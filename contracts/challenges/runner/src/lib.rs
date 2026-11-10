//! One attempt = one fresh local sandbox. Deploy the target, fund the vault the way honest users
//! would, give the attacker a small account, run the attacker's plan step by step, compare balances.
//!
//! The only win is money: the target's balance went down and the attacker got it. Nothing here
//! touches a live network; `near_workspaces::sandbox()` starts a private `neard` on localhost.

use anyhow::{bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Worker};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub mod round;

/// Max gas one step may attach. Matches the protocol limit per function call.
pub const MAX_GAS_TGAS: u64 = 300;
/// What a step attaches when the plan does not say.
pub const DEFAULT_GAS_TGAS: u64 = 100;
/// Upper bound on what gas can cost the attacker per call step (300 TGas at the sandbox floor
/// price of 1e8 yocto/gas is 0.03 NEAR). The attacker must keep the loot minus at most this.
pub const GAS_ALLOWANCE_PER_CALL: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

// ---------------------------------------------------------------------------------------------
// Challenge format
// ---------------------------------------------------------------------------------------------

/// `challenge.json`: everything needed to rebuild the same world for every attempt.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub title: String,
    /// Wasm file name the build produces, e.g. `open_admin.wasm`.
    pub wasm: String,
    /// Source files shown to attackers, relative to the challenge directory.
    pub source: Vec<String>,
    /// The contract that guards the vault. Its own NEAR balance is the vault.
    pub target: Party,
    /// The attacker's account. Small balance.
    pub attacker: Party,
    /// Honest accounts that fill the vault in `setup`.
    #[serde(default)]
    pub accounts: Vec<Party>,
    pub init: Init,
    #[serde(default)]
    pub setup: Vec<SetupCall>,
    /// Public data the attacker is allowed to know (their own receipts, proofs, addresses).
    #[serde(default)]
    pub kit: Value,
    pub limits: Limits,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Party {
    /// Sub-account name under the sandbox root, e.g. `vault` → `vault.test.near`.
    pub name: String,
    /// Starting balance in whole NEAR.
    pub near: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Init {
    pub method: String,
    #[serde(default = "empty_object")]
    pub args: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SetupCall {
    /// Party name: one of `accounts`, or the attacker's name.
    pub by: String,
    pub method: String,
    #[serde(default = "empty_object")]
    pub args: Value,
    #[serde(default)]
    pub deposit_near: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub max_steps: usize,
    pub timeout_s: u64,
    /// Smallest drain that counts as a breach, in whole NEAR.
    pub min_loot_near: u64,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

pub struct Challenge {
    pub dir: PathBuf,
    pub manifest: Manifest,
}

impl Challenge {
    pub fn load(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        let path = dir.join("challenge.json");
        let text = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        let manifest: Manifest = serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
        if manifest.limits.max_steps == 0 || manifest.limits.timeout_s == 0 {
            bail!("limits must be positive");
        }
        Ok(Self { dir, manifest })
    }
}

// ---------------------------------------------------------------------------------------------
// Attack plan: a typed list of actions, never code
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// A transaction from the attacker to the target.
    Call {
        method: String,
        #[serde(default = "empty_object")]
        args: Value,
        /// yoctoNEAR as a decimal string.
        #[serde(default = "zero")]
        deposit: String,
        #[serde(default = "default_gas")]
        gas_tgas: u64,
    },
    /// A read-only call on the target. Costs nothing, changes nothing.
    View {
        method: String,
        #[serde(default = "empty_object")]
        args: Value,
    },
}

fn zero() -> String {
    "0".into()
}
fn default_gas() -> u64 {
    DEFAULT_GAS_TGAS
}

impl Step {
    pub fn method(&self) -> &str {
        match self {
            Step::Call { method, .. } | Step::View { method, .. } => method,
        }
    }
}

/// Checks a plan before a sandbox is started, so a malformed plan costs nothing.
pub fn validate(plan: &Plan, limits: &Limits) -> std::result::Result<(), String> {
    if plan.steps.is_empty() {
        return Err("plan has no steps".into());
    }
    if plan.steps.len() > limits.max_steps {
        return Err(format!("plan has {} steps, limit is {}", plan.steps.len(), limits.max_steps));
    }
    for (i, step) in plan.steps.iter().enumerate() {
        let method = step.method();
        if method.is_empty() || method.len() > 64 || !method.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("step {i}: bad method name"));
        }
        let args = match step {
            Step::Call { args, .. } | Step::View { args, .. } => args,
        };
        if !args.is_object() {
            return Err(format!("step {i}: args must be a JSON object"));
        }
        if let Step::Call { deposit, gas_tgas, .. } = step {
            if deposit.parse::<u128>().is_err() {
                return Err(format!("step {i}: deposit must be yoctoNEAR as a decimal string"));
            }
            if *gas_tgas == 0 || *gas_tgas > MAX_GAS_TGAS {
                return Err(format!("step {i}: gas_tgas must be 1..={MAX_GAS_TGAS}"));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// The vault lost at least `min_loot` and the attacker kept it.
    Breach,
    /// The plan ran; the vault held.
    Held,
    /// The plan was rejected before the sandbox started.
    Invalid,
    /// The attempt ran past `timeout_s`.
    Timeout,
    /// The sandbox or the challenge setup failed. Not the attacker's fault.
    Error,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StepReport {
    pub index: usize,
    pub method: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub logs: Vec<String>,
    /// Return value as text (JSON for most contracts).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

/// Balances are yoctoNEAR decimal strings: u128 does not fit in a JSON number.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Outcome {
    pub challenge: String,
    pub verdict: Verdict,
    pub reason: String,
    pub vault_before: String,
    pub vault_after: String,
    pub attacker_before: String,
    pub attacker_after: String,
    /// `vault_before - vault_after`, 0 if the vault grew.
    pub stolen: String,
    pub steps: Vec<StepReport>,
    pub elapsed_ms: u64,
}

impl Outcome {
    pub fn breached(&self) -> bool {
        self.verdict == Verdict::Breach
    }

    fn early(challenge: &str, verdict: Verdict, reason: String, elapsed: Duration) -> Self {
        Self {
            challenge: challenge.into(),
            verdict,
            reason,
            vault_before: "0".into(),
            vault_after: "0".into(),
            attacker_before: "0".into(),
            attacker_after: "0".into(),
            stolen: "0".into(),
            steps: vec![],
            elapsed_ms: elapsed.as_millis() as u64,
        }
    }
}

/// The single win rule. `calls` is how many transactions the attacker sent.
pub fn judge(
    vault_before: u128,
    vault_after: u128,
    attacker_before: u128,
    attacker_after: u128,
    calls: usize,
    min_loot_near: u64,
) -> (bool, String) {
    let stolen = vault_before.saturating_sub(vault_after);
    let min_loot = min_loot_near as u128 * ONE_NEAR;
    if stolen < min_loot {
        return (false, format!("vault held: lost {} of at least {} needed", near_str(stolen), near_str(min_loot)));
    }
    let allowance = GAS_ALLOWANCE_PER_CALL * calls as u128;
    if attacker_after + allowance < attacker_before + stolen {
        return (false, format!("vault lost {} but the attacker did not receive it", near_str(stolen)));
    }
    (true, format!("vault drained of {}", near_str(stolen)))
}

/// `12.345 NEAR`, three decimals, rounded down.
pub fn near_str(yocto: u128) -> String {
    let milli = yocto / (ONE_NEAR / 1000);
    format!("{}.{:03} NEAR", milli / 1000, milli % 1000)
}

// ---------------------------------------------------------------------------------------------
// Running an attempt
// ---------------------------------------------------------------------------------------------

/// Runs one plan in a brand-new sandbox. Never returns `Err`: every failure is an `Outcome`.
pub async fn run_attempt(challenge: &Challenge, wasm: &[u8], plan: &Plan) -> Outcome {
    let started = Instant::now();
    let m = &challenge.manifest;
    if let Err(reason) = validate(plan, &m.limits) {
        return Outcome::early(&m.id, Verdict::Invalid, reason, started.elapsed());
    }
    let limit = Duration::from_secs(m.limits.timeout_s);
    match tokio::time::timeout(limit, attempt(m, wasm, plan)).await {
        Ok(Ok(mut outcome)) => {
            outcome.elapsed_ms = started.elapsed().as_millis() as u64;
            outcome
        }
        Ok(Err(e)) => Outcome::early(&m.id, Verdict::Error, format!("{e:#}"), started.elapsed()),
        Err(_) => Outcome::early(
            &m.id,
            Verdict::Timeout,
            format!("attempt ran past {}s", m.limits.timeout_s),
            started.elapsed(),
        ),
    }
}

async fn attempt(m: &Manifest, wasm: &[u8], plan: &Plan) -> Result<Outcome> {
    let worker = near_workspaces::sandbox().await.context("start sandbox")?;
    let root = worker.root_account()?;

    let target = sub(&root, &m.target).await?;
    target.deploy(wasm).await?.into_result().context("deploy target")?;
    target
        .call(target.id(), &m.init.method)
        .args_json(&m.init.args)
        .max_gas()
        .transact()
        .await?
        .into_result()
        .context("init target")?;

    let attacker = sub(&root, &m.attacker).await?;
    let mut honest = Vec::new();
    for p in &m.accounts {
        honest.push((p.name.clone(), sub(&root, p).await?));
    }
    for (i, s) in m.setup.iter().enumerate() {
        let who = if s.by == m.attacker.name {
            &attacker
        } else {
            &honest.iter().find(|(n, _)| *n == s.by).with_context(|| format!("setup {i}: unknown party {}", s.by))?.1
        };
        who.call(target.id(), &s.method)
            .args_json(&s.args)
            .deposit(NearToken::from_near(s.deposit_near as u128))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .with_context(|| format!("setup {i}: {}", s.method))?;
    }

    let vault_before = balance(&worker, &target).await?;
    let attacker_before = balance(&worker, &attacker).await?;

    let mut reports = Vec::with_capacity(plan.steps.len());
    let mut calls = 0;
    for (index, step) in plan.steps.iter().enumerate() {
        reports.push(match step {
            Step::Call { method, args, deposit, gas_tgas } => {
                calls += 1;
                let deposit: u128 = deposit.parse().expect("validated");
                let sent = attacker
                    .call(target.id(), method)
                    .args_json(args)
                    .deposit(NearToken::from_yoctonear(deposit))
                    .gas(Gas::from_tgas(*gas_tgas))
                    .transact()
                    .await;
                match sent {
                    Err(e) => StepReport {
                        index,
                        method: method.clone(),
                        ok: false,
                        logs: vec![],
                        value: None,
                        error: Some(short(&e.to_string())),
                    },
                    Ok(res) => {
                        let logs = res.logs().into_iter().map(String::from).collect();
                        match res.into_result() {
                            Ok(ok) => StepReport {
                                index,
                                method: method.clone(),
                                ok: true,
                                logs,
                                value: text(ok.raw_bytes().ok()),
                                error: None,
                            },
                            Err(fail) => StepReport {
                                index,
                                method: method.clone(),
                                ok: false,
                                logs,
                                value: None,
                                error: Some(short(&fail.to_string())),
                            },
                        }
                    }
                }
            }
            Step::View { method, args } => match worker.view(target.id(), method).args_json(args).await {
                Ok(v) => StepReport {
                    index,
                    method: method.clone(),
                    ok: true,
                    logs: v.logs.clone(),
                    value: text(Some(v.result)),
                    error: None,
                },
                Err(e) => StepReport {
                    index,
                    method: method.clone(),
                    ok: false,
                    logs: vec![],
                    value: None,
                    error: Some(short(&e.to_string())),
                },
            },
        });
    }

    // Let every outgoing transfer land before reading balances.
    worker.fast_forward(3).await?;
    let vault_after = balance(&worker, &target).await?;
    let attacker_after = balance(&worker, &attacker).await?;
    let (breached, reason) =
        judge(vault_before, vault_after, attacker_before, attacker_after, calls, m.limits.min_loot_near);

    Ok(Outcome {
        challenge: m.id.clone(),
        verdict: if breached { Verdict::Breach } else { Verdict::Held },
        reason,
        vault_before: vault_before.to_string(),
        vault_after: vault_after.to_string(),
        attacker_before: attacker_before.to_string(),
        attacker_after: attacker_after.to_string(),
        stolen: vault_before.saturating_sub(vault_after).to_string(),
        steps: reports,
        elapsed_ms: 0,
    })
}

async fn sub(root: &Account, p: &Party) -> Result<Account> {
    root.create_subaccount(&p.name)
        .initial_balance(NearToken::from_near(p.near as u128))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("create account {}", p.name))
}

async fn balance(worker: &Worker<Sandbox>, account: &Account) -> Result<u128> {
    Ok(worker.view_account(account.id()).await?.balance.as_yoctonear())
}

fn text(bytes: Option<Vec<u8>>) -> Option<String> {
    let bytes = bytes?;
    if bytes.is_empty() {
        return None;
    }
    Some(short(&String::from_utf8_lossy(&bytes)))
}

fn short(s: &str) -> String {
    const MAX: usize = 600;
    if s.len() <= MAX {
        return s.to_string();
    }
    let mut end = MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

// ---------------------------------------------------------------------------------------------
// Building the targets
// ---------------------------------------------------------------------------------------------

/// The challenges workspace root (this crate's parent).
pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Where `build_targets` puts the wasm files.
pub fn wasm_dir() -> PathBuf {
    workspace_root().join("target").join("challenge-wasm").join("wasm32-unknown-unknown").join("release")
}

/// The sandbox-only training targets: they never go on chain.
pub const TRAINING_TARGETS: &[&str] = &["open-admin", "proof-replay", "over-withdraw"];

/// Arena safes: targets with the live-round interface of `live-safe` (README, "Live round"), each with one planted
/// hole, from level 1 to level 5.
pub const ARENA_SAFES: &[&str] = &[
    "pause-bypass",
    "fake-oracle",
    "share-rounding",
    "batch-overflow",
    "blind-callback",
    "relay-trust",
    "prefix-clash",
];

/// Builds every training target and arena safe for wasm, into a separate target dir so it never
/// contends with the outer `cargo` lock; and, for the sealed round, the OutLayer stub and the bounty
/// contract. The season treasury is built only by the season's own test (`round::build_season`).
pub fn build_targets() -> Result<()> {
    let root = workspace_root();
    let mut args = vec!["build", "--release", "--target", "wasm32-unknown-unknown"];
    for package in
        TRAINING_TARGETS.iter().chain(["live-safe"].iter()).chain(ARENA_SAFES).chain(["outlayer-stub"].iter())
    {
        args.extend(["-p", package]);
    }
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(&root)
        .env("RUSTFLAGS", "--cfg near -C link-arg=-s")
        .env("CARGO_TARGET_DIR", root.join("target").join("challenge-wasm"))
        .args(&args)
        .status()
        .context("run cargo build")?;
    if !status.success() {
        bail!("wasm build failed");
    }
    round::build_bounty()
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: u128 = ONE_NEAR;
    fn limits() -> Limits {
        Limits { max_steps: 3, timeout_s: 10, min_loot_near: 1 }
    }

    #[test]
    fn judge_needs_loot_in_the_attackers_pocket() {
        // 90 NEAR out, attacker +89.99 after gas: breach.
        assert!(judge(100 * N, 10 * N, 5 * N, 5 * N + 90 * N - N / 100, 2, 1).0);
        // Vault grew or barely moved: held.
        assert!(!judge(100 * N, 101 * N, 5 * N, 4 * N, 1, 1).0);
        assert!(!judge(100 * N, 100 * N - N / 2, 5 * N, 5 * N + N / 2, 1, 1).0);
        // Vault lost 50 but the attacker gained nothing: held.
        assert!(!judge(100 * N, 50 * N, 5 * N, 5 * N, 2, 1).0);
    }

    #[test]
    fn plan_checks() {
        let ok: Plan =
            serde_json::from_str(r#"{"steps":[{"kind":"call","method":"withdraw","args":{"amount":"1"}}]}"#).unwrap();
        assert!(validate(&ok, &limits()).is_ok());
        let bad = |s: &str| validate(&serde_json::from_str::<Plan>(s).unwrap(), &limits()).unwrap_err();
        assert!(bad(r#"{"steps":[]}"#).contains("no steps"));
        assert!(bad(r#"{"steps":[{"kind":"view","method":"a b"}]}"#).contains("method"));
        assert!(bad(r#"{"steps":[{"kind":"view","method":"a","args":[1]}]}"#).contains("object"));
        assert!(bad(r#"{"steps":[{"kind":"call","method":"a","deposit":"1.5"}]}"#).contains("deposit"));
        assert!(bad(r#"{"steps":[{"kind":"call","method":"a","gas_tgas":301}]}"#).contains("gas"));
        // Unknown actions and fields are refused at parse time: a plan is data, not code.
        assert!(serde_json::from_str::<Plan>(r#"{"steps":[{"kind":"deploy","code":"00"}]}"#).is_err());
        assert!(
            serde_json::from_str::<Plan>(r#"{"steps":[{"kind":"call","method":"a","receiver":"x.near"}]}"#).is_err()
        );
    }

    #[test]
    fn near_amounts_read_well() {
        assert_eq!(near_str(90 * N + N / 1000 * 123), "90.123 NEAR");
        assert_eq!(near_str(0), "0.000 NEAR");
    }
}
