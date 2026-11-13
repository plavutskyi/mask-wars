//! A sealed round (RULES.md) in a fresh local sandbox, with scripted masks and no model. Everything on chain is the
//! real thing: the bounty contract, the live safe locked to the round, and the judge (services/judge), which reads the
//! sandbox's own RPC.
//! Only OutLayer is a stand-in: `outlayer-stub` holds each judge request as a yielded promise, the round runs the
//! judge on the request's input and resumes the promise with the judge's answer. The round can hold an answer back
//! while other claims go through, as a slow or junk claim would on OutLayer.
//!
//! `race-runner round` prints the board of one round; tests/round.rs checks who may win.

use crate::workspace_root;
use anyhow::{bail, Context, Result};
use maskwars_judge::chain::Chain;
use maskwars_judge::judge::GitHub;
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::task::Poll;
use std::time::Duration;

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// What a mask leaves in the safe when it seals a sweep of all the safe can pay out: the storage that the turns before
/// its own may add, as packages/race/src/live.ts leaves it. Then rounded down to 0.01 NEAR.
pub const SWEEP_MARGIN: u128 = 3 * ONE_NEAR / 100;
const SWEEP_STEP: u128 = ONE_NEAR / 100;
const BOUNTY_ID: &str = "round-0001";
/// The most a withdrawal takes at the `limit` desk without the owner's word (`WITHDRAW_LIMIT` in live-safe).
const WITHDRAW_LIMIT: u128 = ONE_NEAR / 200;
/// The judge version the sandbox's bounty contract pins; the stub runs the real judge whatever it is.
pub const SANDBOX_JUDGE: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// How a scripted mask plays the round.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Play {
    /// Finds the hole in the commit window, seals its plan, plays it after the window, reveals it and claims.
    Finder,
    /// Seals a guess early: a bare sweep to itself, without the hole. After the window it borrows the hole from
    /// another mask's moves on chain, plays its sealed sweep, reveals the guess and claims.
    Gambler,
    /// Seals nothing. Copies another mask's plan from the chain once it is played, then tries to seal, reveal and
    /// claim it as its own.
    Peeker,
    /// Finds the hole only after the commit window closed.
    Late,
    /// Wants nobody paid. Seals a junk plan and tries to empty the safe in the commit window, before any sealed plan
    /// can be played; then claims what it played: its claim stays with the judge while the others claim.
    Saboteur,
    /// Wants nobody paid, and seals nothing. The moment the commit window closes it moves the safe first, then
    /// stops: under the old rule no plan started after that could win.
    Squatter,
    /// Seals early a plan that only takes the safe (a `set_owner` to itself) and plays it in its turn: each such turn
    /// adds to what the safe stores before a later seal plays.
    Occupant,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MaskScript {
    /// The mask's account under the sandbox root: `nova` → `nova.test.near`.
    pub name: String,
    pub play: Play,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Scenario {
    /// In the order the masks act within each phase.
    pub masks: Vec<MaskScript>,
    pub safe_near: u128,
    /// What each mask's sweep asks of the safe.
    pub sweep_near: u128,
    pub min_loot_near: u128,
    pub bounty_near: u128,
    pub commit_minutes: u64,
    #[serde(default = "default_reveal_minutes")]
    pub reveal_minutes: u64,
    pub hours: u64,
    /// A finder seals a sweep of all the safe can pay out at that moment, less this margin, rounded down to 0.01 NEAR,
    /// as our masks do; `None`: the fixed `sweep_near`.
    #[serde(default)]
    pub sweep_margin: Option<u128>,
    /// The safe is topped up so what it can pay out sits 0.0001 NEAR above a step of 0.01 NEAR: a sweep rounded down
    /// to the step keeps almost nothing back for the storage later turns add.
    #[serde(default)]
    pub tight_safe: bool,
    /// Before the team, an account outside it opens a round of its own on the fresh safe, with the same masks.
    #[serde(default)]
    pub intruder: bool,
    /// The kind of the round's safe (`variant` of live-safe's `new`): `owner` unless named, else `limit` or `pause`.
    /// The masks' scripts are the same; the calls their plans are made of are that kind's.
    #[serde(default)]
    pub variant: Option<String>,
}

fn default_reveal_minutes() -> u64 {
    60
}

impl Scenario {
    /// ONYX gambles and seals first, JINX sabotages and seals second, NOVA finds the hole and seals third, ORACLE
    /// peeks, VOLT is late. The safe holds enough for all of them to take something; only one may win the bounty.
    pub fn standard() -> Self {
        let mask = |name: &str, play| MaskScript { name: name.into(), play };
        Self {
            masks: vec![
                mask("onyx", Play::Gambler),
                mask("jinx", Play::Saboteur),
                mask("nova", Play::Finder),
                mask("oracle", Play::Peeker),
                mask("volt", Play::Late),
            ],
            safe_near: 12,
            sweep_near: 2,
            min_loot_near: 1,
            bounty_near: 1,
            commit_minutes: 1,
            reveal_minutes: 30,
            hours: 1,
            sweep_margin: None,
            tight_safe: false,
            intruder: false,
            variant: None,
        }
    }

    /// The standard round on a safe of another kind.
    pub fn of(variant: &str) -> Self {
        Self { variant: Some(variant.into()), ..Self::standard() }
    }

    fn kind(&self) -> &str {
        self.variant.as_deref().unwrap_or(crate::DEFAULT_VARIANT)
    }
}

/// One line of the public board.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Event {
    pub mask: String,
    pub step: String,
    pub ok: bool,
    pub note: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Board {
    pub bounty: String,
    pub events: Vec<Event>,
    /// The bounty as the contract holds it at the end (`get`).
    pub status: Value,
    /// The round as the contract shows it at the end (`get_round`): every seal, plans once revealed.
    pub round: Value,
    pub winner: Option<String>,
    /// yoctoNEAR the winner was paid.
    pub prize: String,
}

/// A claim whose question waits with the judge.
struct Asked {
    name: String,
    pending: near_workspaces::operations::TransactionStatus,
    index: usize,
    input: String,
}

/// One call of a plan on the safe.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Call {
    pub method: String,
    pub args: Value,
}

struct Mask {
    script: MaskScript,
    account: Account,
    plan: Option<String>,
    salt: String,
    txs: Vec<String>,
    /// Moves a copycat played outside its sealed plan.
    borrowed: Vec<String>,
    drain: Option<String>,
}

struct World {
    /// The node itself: dropping it stops the sandbox.
    _node: near_sandbox::Sandbox,
    worker: Worker<Sandbox>,
    team: Account,
    safe: near_workspaces::AccountId,
    bounty: Contract,
    stub: Contract,
    masks: Vec<Mask>,
    events: Vec<Event>,
    /// The call that pays in a plan through the hole of this round's safe: a mask claims the one that went through.
    pays: String,
}

/// The seal both the masks and the contract compute.
pub fn seal_hash(id: &str, mask: &str, salt: &str, plan: &str) -> String {
    let digest = Sha256::digest(format!("maskwars-commit:{id}:{mask}:{salt}:{plan}").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn plan_text(calls: &[Call]) -> String {
    serde_json::to_string(calls).expect("a plan is JSON")
}

/// The planted hole of a safe of kind `variant`, as `mask` plays it for `sweep` yoctoNEAR: the last call pays.
pub fn the_hole(variant: &str, mask: &str, sweep: u128) -> Vec<Call> {
    let call = |method: &str, args: Value| Call { method: method.into(), args };
    match variant {
        "limit" => vec![
            call("request_exit", json!({ "amount": WITHDRAW_LIMIT.to_string() })),
            call("request_exit", json!({ "amount": sweep.to_string() })),
            call("withdraw", json!({})),
        ],
        "pause" => vec![call("book", json!({ "amount": sweep.to_string() })), call("cash_out", json!({}))],
        _ => vec![
            call("set_owner", json!({ "new_owner": mask })),
            call("sweep", json!({ "to": mask, "amount": sweep.to_string() })),
        ],
    }
}

/// What a squatter plays: one move that takes nothing, the hole's first call.
fn junk(variant: &str, mask: &str) -> Vec<Call> {
    the_hole(variant, mask, 1)[..1].to_vec()
}

/// A guess sealed without the hole: the call that pays, alone.
fn a_guess(variant: &str, mask: &str, sweep: u128) -> Vec<Call> {
    let hole = the_hole(variant, mask, sweep);
    hole[hole.len() - 1..].to_vec()
}

/// The panic message of a failed call, or `ok`.
fn why(r: &ExecutionFinalResult) -> String {
    match r.clone().into_result() {
        Ok(_) => "ok".into(),
        Err(e) => {
            let text = format!("{e:?}");
            match text.split_once("Smart contract panicked: ") {
                Some((_, rest)) => rest.split(['"', '\\']).next().unwrap_or(rest).to_string(),
                None => text.chars().take(160).collect(),
            }
        }
    }
}

fn near(yocto: u128) -> String {
    crate::near_str(yocto)
}

/// Why the safe sends a mask away for now: it lets it in later in the round.
const WAIT: [&str; 2] = ["another mask has its turn", "an earlier seal goes first"];

impl World {
    fn log(&mut self, mask: &str, step: &str, ok: bool, note: impl Into<String>) {
        self.events.push(Event { mask: mask.into(), step: step.into(), ok, note: note.into() });
    }

    async fn view(&self, contract: &near_workspaces::AccountId, method: &str, args: Value) -> Result<Value> {
        Ok(self.worker.view(contract, method).args_json(args).await?.json()?)
    }

    async fn bounty_view(&self, method: &str) -> Result<Value> {
        self.view(self.bounty.id(), method, json!({ "id": BOUNTY_ID })).await
    }

    /// Sends one call of a plan from mask `i` to the safe; returns its transaction and whether it went through.
    async fn send(&mut self, i: usize, call: &Call) -> Result<(String, bool)> {
        let account = self.masks[i].account.clone();
        let r = account.call(&self.safe, &call.method).args_json(&call.args).gas(Gas::from_tgas(30)).transact().await?;
        let hash = r.outcome().transaction_hash.to_string();
        let ok = r.is_success();
        let name = self.masks[i].script.name.clone();
        let note = if ok { hash.clone() } else { why(&r) };
        self.log(&name, &format!("play {}", call.method), ok, note);
        Ok((hash, ok))
    }

    /// Plays `calls` on the safe as mask `i`, in order. The paying call that went through is the mask's drain. While
    /// another mask has its turn on the safe, or an earlier seal goes first, the mask waits and sends the call again.
    async fn play(&mut self, i: usize, calls: &[Call]) -> Result<Vec<String>> {
        let mut txs = vec![];
        for call in calls {
            let (mut hash, mut ok) = self.send(i, call).await?;
            if !ok && self.events.last().is_some_and(|e| WAIT.iter().any(|w| e.note.contains(w))) {
                self.wait_until_the_safe_lets_in(i).await?;
                (hash, ok) = self.send(i, call).await?;
            }
            if ok && call.method == self.pays {
                self.masks[i].drain = Some(hash.clone());
            }
            txs.push(hash);
        }
        Ok(txs)
    }

    async fn commit(&mut self, i: usize, plan: &str) -> Result<bool> {
        let m = &self.masks[i];
        let hash = seal_hash(BOUNTY_ID, m.account.id().as_str(), &m.salt, plan);
        let r = m
            .account
            .call(self.bounty.id(), "commit")
            .args_json(json!({ "id": BOUNTY_ID, "hash": hash }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        let name = m.script.name.clone();
        let note = match r.clone().json::<Value>() {
            Ok(seal) if r.is_success() => format!("seal #{} {}", seal["seq"], &hash[..12]),
            _ => why(&r),
        };
        let ok = r.is_success();
        self.log(&name, "seal", ok, note);
        Ok(ok)
    }

    async fn reveal(&mut self, i: usize, plan: &str, txs: &[String]) -> Result<bool> {
        let m = &self.masks[i];
        let r = m
            .account
            .call(self.bounty.id(), "reveal")
            .args_json(json!({ "id": BOUNTY_ID, "plan": plan, "salt": m.salt, "txs": txs }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        let name = m.script.name.clone();
        let ok = r.is_success();
        let note = match (ok, txs.len()) {
            (true, 1) => "1 call".into(),
            (true, n) => format!("{n} calls"),
            _ => why(&r),
        };
        self.log(&name, "reveal", ok, note);
        Ok(ok)
    }

    /// The mask claims its drain with nothing attached, as a function-call key must. The judge's request waits in
    /// the stub; the round runs the real judge on it and hands the answer back.
    async fn claim(&mut self, i: usize) -> Result<()> {
        if let Some(asked) = self.ask(i).await? {
            self.answer(asked).await?;
        }
        Ok(())
    }

    /// Sends mask `i`'s claim and waits until its question reaches the judge; `None` if the contract refused it.
    async fn ask(&mut self, i: usize) -> Result<Option<Asked>> {
        let name = self.masks[i].script.name.clone();
        let Some(tx) = self.masks[i].drain.clone() else {
            self.log(&name, "claim", false, "no drain to claim");
            return Ok(None);
        };
        let asked = self.view(self.stub.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
        let pending = self.masks[i]
            .account
            .call(self.bounty.id(), "claim_drain")
            .args_json(json!({ "id": BOUNTY_ID, "tx_hash": tx }))
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await?;
        loop {
            if let Poll::Ready(r) = pending.status().await? {
                // The contract refused before it asked the judge.
                self.log(&name, "claim", false, why(&r));
                return Ok(None);
            }
            let requests = self.view(self.stub.id(), "requests", json!({})).await?;
            if let Some(r) = requests.as_array().and_then(|r| r.get(asked)) {
                let input = r["input"].as_str().unwrap_or("").to_string();
                self.log(&name, "asked", true, format!("the claim is with the judge, request {asked}"));
                return Ok(Some(Asked { name, pending, index: asked, input }));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Runs the real judge on a claim's question and hands the answer back to the contract.
    async fn answer(&mut self, asked: Asked) -> Result<()> {
        let Asked { name, pending, index, input } = asked;
        let rpc = SandboxRpc::new(&self.worker.rpc_addr())?;
        let verdict = tokio::task::spawn_blocking(move || {
            let input = serde_json::from_str::<Value>(&input).ok();
            maskwars_judge::answer(input, &NoGitHub, &[&rpc])
        })
        .await?;
        let output = serde_json::to_string(&verdict)?;
        self.team
            .call(self.stub.id(), "answer")
            .args_json(json!({ "index": index, "output": output }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?
            .into_result()
            .context("answer the judge's request")?;
        let r = loop {
            if let Poll::Ready(r) = pending.status().await? {
                break r;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        };
        let note = match (&verdict.error, r.is_success()) {
            (None, true) => "the judge confirmed the drain".to_string(),
            (Some(e), _) => format!("the judge refused: {e}"),
            (None, false) => why(&r),
        };
        self.log(&name, "claim", verdict.success && r.is_success(), note);
        Ok(())
    }

    /// Lets sandbox time pass until the safe lets mask `i` in: the turn of another mask is over, and so is its wait
    /// for the earlier seals.
    async fn wait_until_the_safe_lets_in(&mut self, i: usize) -> Result<()> {
        let me = self.masks[i].account.id().clone();
        for _ in 0..2000 {
            let why = self.view(&self.safe, "waits_for", json!({ "account_id": me })).await?;
            if !why.as_str().is_some_and(|w| WAIT.iter().any(|x| w.contains(x))) {
                return Ok(());
            }
            self.worker.fast_forward(20).await?;
        }
        bail!("sandbox time did not reach the mask's turn");
    }

    /// Lets sandbox time pass until the commit window is over.
    async fn close_the_window(&mut self) -> Result<()> {
        let until: u64 =
            self.bounty_view("get_round").await?["commit_until"].as_str().context("commit_until")?.parse()?;
        for _ in 0..200 {
            if self.worker.view_block().await?.timestamp() >= until {
                self.log("", "window", true, "the commit window is closed");
                return Ok(());
            }
            self.worker.fast_forward(20).await?;
        }
        bail!("sandbox time did not reach the end of the commit window");
    }
}

/// A fresh local node. The round lets sandbox time pass in big steps, and the judge reads the safe as the round
/// opened it: with the default short epochs that block would be garbage collected before the claims.
pub async fn sandbox() -> Result<(near_sandbox::Sandbox, Worker<Sandbox>)> {
    if std::env::var("NEAR_ENABLE_SANDBOX_LOG").map_or(true, |v| v == "0") {
        // SAFETY: set once, before the node starts and before any other thread reads the environment.
        unsafe { std::env::set_var("NEAR_SANDBOX_LOG", "near=error,stats=error,network=error") };
    }
    let config = near_sandbox::SandboxConfig {
        additional_genesis: Some(json!({ "epoch_length": 100_000 })),
        ..Default::default()
    };
    let node = near_sandbox::Sandbox::start_sandbox_with_config(config).await?;
    let worker = near_workspaces::sandbox()
        .rpc_addr(&node.rpc_addr)
        .validator_key(ValidatorKey::HomeDir(node.home_dir.path().to_path_buf()))
        .await?;
    Ok((node, worker))
}

/// Runs one round of `scenario` in a fresh sandbox and returns its board.
pub async fn run_round(scenario: &Scenario) -> Result<Board> {
    let (bounty_wasm, safe_wasm, stub_wasm) = round_wasm()?;
    let (node, worker) = sandbox().await.context("start sandbox")?;
    let root = worker.root_account()?;
    let sub = |name: &str, near: u128| {
        let root = root.clone();
        let name = name.to_string();
        async move {
            root.create_subaccount(&name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .with_context(|| format!("create {name}"))
        }
    };

    let team = sub("team", 20).await?;
    let mut masks = vec![];
    for (n, script) in scenario.masks.iter().enumerate() {
        let account = sub(&script.name, 10).await?;
        let salt = format!("{}-{:016x}", script.name, seed(n));
        masks.push(Mask {
            script: script.clone(),
            account,
            plan: None,
            salt,
            txs: vec![],
            borrowed: vec![],
            drain: None,
        });
    }
    let mask_ids: Vec<String> = masks.iter().map(|m| m.account.id().to_string()).collect();

    let stub = sub("outlayer", 10).await?.deploy(&stub_wasm).await?.into_result()?;
    // The bounty contract knows exactly this safe's code; the judge checks it on chain.
    let safe_code = code_hash(&safe_wasm);
    let bounty = sub("bounty", 20).await?.deploy(&bounty_wasm).await?.into_result()?;
    bounty
        .call("new")
        .args_json(json!({ "outlayer": stub.id(), "judge_project": "sandbox/judge", "judge_version": SANDBOX_JUDGE,
                           "admin": team.id(), "safe_codes": [safe_code] }))
        .transact()
        .await?
        .into_result()
        .context("init the bounty contract")?;
    // The safe owns itself, lets in the round's masks, and only the bounty contract may lock it to a round.
    let safe = sub("safe", scenario.safe_near).await?;
    let safe = safe.deploy(&safe_wasm).await?.into_result()?;
    let variant = scenario.kind();
    let mut init = json!({ "owner": safe.id(), "masks": mask_ids, "arbiter": bounty.id(), "team": team.id() });
    if let Some(named) = &scenario.variant {
        init["variant"] = json!(named);
    }
    safe.call("new")
        .args_json(init)
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("init the safe")?;

    let pays = the_hole(variant, "", 0).pop().map(|c| c.method).unwrap_or_default();
    let mut w = World { _node: node, worker, team, safe: safe.id().clone(), bounty, stub, masks, events: vec![], pays };
    if scenario.intruder {
        // Someone outside the team opens a round of its own on the fresh safe first: same masks, same code, same
        // judge, all public. The safe takes only its own team's round.
        let intruder = sub("intruder", 5).await?;
        let r = intruder
            .call(w.bounty.id(), "open_safe")
            .args_json(json!({
                "id": "intruder-0001", "safe": w.safe, "masks": mask_ids,
                "min_loot": (scenario.min_loot_near * ONE_NEAR).to_string(), "hours": scenario.hours,
                "commit_minutes": scenario.commit_minutes, "reveal_minutes": scenario.reveal_minutes,
                "safe_code": safe_code, "judge_version": SANDBOX_JUDGE,
            }))
            .deposit(NearToken::from_near(1))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?;
        let theirs = w.view(w.bounty.id(), "get", json!({ "id": "intruder-0001" })).await?;
        let state = theirs["status"]["state"].as_str().unwrap_or("none").to_string();
        let lock = w.view(&w.safe, "get_round", json!({})).await?;
        let note = format!("{state}; the safe is locked to {}", lock["bounty"].as_str().unwrap_or("no round"));
        w.log("intruder", "open", r.is_success() && state == "open", note);
    }
    let opened = w
        .team
        .call(w.bounty.id(), "open_safe")
        .args_json(json!({
            "id": BOUNTY_ID,
            "safe": w.safe,
            "masks": mask_ids,
            "min_loot": (scenario.min_loot_near * ONE_NEAR).to_string(),
            "hours": scenario.hours,
            "commit_minutes": scenario.commit_minutes,
            "reveal_minutes": scenario.reveal_minutes,
            "safe_code": safe_code,
            "judge_version": SANDBOX_JUDGE,
        }))
        .deposit(NearToken::from_near(scenario.bounty_near))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let note = format!("{} on {} for {} masks", near(scenario.bounty_near * ONE_NEAR), w.safe, mask_ids.len());
    w.log("team", "open", opened.is_success(), if opened.is_success() { note } else { why(&opened) });
    opened.into_result().context("open the round")?;

    let n = w.masks.len();
    let first_finder = (0..n).find(|&i| w.masks[i].script.play == Play::Finder);

    // The commit window: whoever knows a plan seals it. The safe is locked: nobody moves it, the masks included.
    // All the safe can pay out, less a little for the storage its own moves take: what a saboteur sweeps if nothing
    // stops it. What is left is far below min_loot.
    if scenario.tight_safe {
        // Right before the seals: the safe's storage is what it will be until the first turn.
        let available: u128 = w.view(&w.safe, "available", json!({})).await?.as_str().context("available")?.parse()?;
        let top_up = SWEEP_STEP - available % SWEEP_STEP + ONE_NEAR / 10_000;
        w.team.transfer_near(&w.safe, NearToken::from_yoctonear(top_up)).await?.into_result()?;
    }
    let available: u128 = w.view(&w.safe, "available", json!({})).await?.as_str().context("available")?.parse()?;
    let everything = available.saturating_sub(ONE_NEAR / 100);
    // What a finder seals: a fixed sweep, or all the safe can pay out when it seals, less the margin.
    let sweep = match scenario.sweep_margin {
        Some(margin) => available.saturating_sub(margin) / SWEEP_STEP * SWEEP_STEP,
        None => scenario.sweep_near * ONE_NEAR,
    };
    for i in 0..n {
        let me = w.masks[i].account.id().to_string();
        let plan = match w.masks[i].script.play {
            Play::Finder => the_hole(variant, &me, sweep),
            Play::Gambler => a_guess(variant, &me, sweep),
            Play::Saboteur => the_hole(variant, &me, everything),
            Play::Occupant => junk(variant, &me),
            Play::Peeker | Play::Late | Play::Squatter => continue,
        };
        let text = plan_text(&plan);
        if w.commit(i, &text).await? {
            w.masks[i].plan = Some(text);
        }
        if w.masks[i].script.play == Play::Saboteur {
            // It empties the safe before any sealed plan may be played. Without the lock nothing was left to win.
            w.masks[i].txs = w.play(i, &plan).await?;
        }
    }
    w.close_the_window().await?;

    // The moment the window closes, the squatter moves the safe first and stops; the occupants play their turns.
    for i in 0..n {
        if matches!(w.masks[i].script.play, Play::Squatter | Play::Occupant) {
            let me = w.masks[i].account.id().to_string();
            w.play(i, &junk(variant, &me)).await?;
        }
    }

    // Too late to seal.
    for i in 0..n {
        if w.masks[i].script.play == Play::Late {
            let me = w.masks[i].account.id().to_string();
            w.commit(i, &plan_text(&the_hole(variant, &me, sweep))).await?;
        }
    }

    // The finders play first; then the others copy what the chain shows them.
    for i in 0..n {
        if w.masks[i].script.play == Play::Finder {
            let plan: Vec<Call> = serde_json::from_str(w.masks[i].plan.as_deref().unwrap_or("[]"))?;
            w.masks[i].txs = w.play(i, &plan).await?;
        }
    }
    for i in 0..n {
        let me = w.masks[i].account.id().to_string();
        match w.masks[i].script.play {
            Play::Gambler if first_finder.is_some() => {
                // The hole, seen in another mask's moves (its set_owner, on a safe of the owner kind), played outside
                // the sealed plan: every call of it but the one that pays.
                let hole = the_hole(variant, &me, sweep);
                w.masks[i].borrowed = w.play(i, &hole[..hole.len() - 1]).await?;
                w.masks[i].txs = w.play(i, &a_guess(variant, &me, sweep)).await?;
            }
            Play::Peeker if first_finder.is_some() => {
                w.masks[i].txs = w.play(i, &the_hole(variant, &me, sweep)).await?;
            }
            _ => {}
        }
    }

    // Reveals: the sealed plan, and what the copycats wish they had sealed.
    for i in 0..n {
        let me = w.masks[i].account.id().to_string();
        let txs = w.masks[i].txs.clone();
        match w.masks[i].script.play {
            Play::Finder => {
                let plan = w.masks[i].plan.clone().unwrap_or_default();
                w.reveal(i, &plan, &txs).await?;
            }
            Play::Gambler => {
                // First the plan it played, as if it had known the hole: the seal says otherwise.
                let whole: Vec<String> = w.masks[i].borrowed.iter().chain(&txs).cloned().collect();
                w.reveal(i, &plan_text(&the_hole(variant, &me, sweep)), &whole).await?;
                let plan = w.masks[i].plan.clone().unwrap_or_default();
                w.reveal(i, &plan, &txs).await?;
            }
            Play::Peeker => {
                w.reveal(i, &plan_text(&the_hole(variant, &me, sweep)), &txs).await?;
            }
            Play::Saboteur => {
                let plan = w.masks[i].plan.clone().unwrap_or_default();
                w.reveal(i, &plan, &txs).await?;
                // It claims the sweep it tried in the window.
                w.masks[i].drain = txs.last().cloned();
            }
            Play::Late | Play::Squatter | Play::Occupant => {}
        }
    }

    // Claims. The saboteur's goes first and its answer is held back: the others claim while it is with the judge.
    let mut held = vec![];
    for i in 0..n {
        if w.masks[i].script.play == Play::Saboteur {
            held.extend(w.ask(i).await?);
        }
    }
    for i in 0..n {
        if !matches!(w.masks[i].script.play, Play::Late | Play::Saboteur | Play::Squatter | Play::Occupant) {
            w.claim(i).await?;
        }
    }
    for asked in held {
        w.answer(asked).await?;
    }

    let status = w.bounty_view("get").await?;
    let round = w.bounty_view("get_round").await?;
    let winner = status["status"]["winner"].as_str().map(|s| s.split('.').next().unwrap_or(s).to_string());
    let prize = status["amount"].as_str().unwrap_or("0").to_string();
    if let Some(name) = &winner {
        let note = format!("{} for seal #{}", near(prize.parse().unwrap_or(0)), seq_of(&round, name));
        w.log(name, "paid", true, note);
    }
    Ok(Board { bounty: BOUNTY_ID.into(), events: w.events, status, round, winner, prize })
}

fn seq_of(round: &Value, name: &str) -> String {
    round["seals"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|s| s["mask"].as_str().is_some_and(|m| m.split('.').next() == Some(name)))
        .map_or("?".into(), |s| s["seq"].to_string())
}

/// A contract's code hash as NEAR shows it: base58 of the wasm's sha256.
pub fn code_hash(wasm: &[u8]) -> String {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let digest = Sha256::digest(wasm);
    let mut digits: Vec<u8> = vec![];
    for byte in digest.iter() {
        let mut carry = u32::from(*byte);
        for d in digits.iter_mut() {
            carry += u32::from(*d) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = digest.iter().take_while(|b| **b == 0).count();
    std::iter::repeat_n(b'1', zeros).chain(digits.iter().rev().map(|d| B58[*d as usize])).map(char::from).collect()
}

/// Salts only need to differ between masks and runs.
fn seed(n: usize) -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_usize(n);
    h.finish()
}

/// The bounty contract, the live safe and the OutLayer stub, built for wasm by `build_targets`.
fn round_wasm() -> Result<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let read =
        |p: PathBuf| std::fs::read(&p).with_context(|| format!("read {} (run `race-runner build`)", p.display()));
    Ok((
        read(bounty_wasm_path())?,
        read(crate::wasm_dir().join("live_safe.wasm"))?,
        read(crate::wasm_dir().join("outlayer_stub.wasm"))?,
    ))
}

pub fn bounty_wasm_path() -> PathBuf {
    workspace_root()
        .join("target")
        .join("bounty-wasm")
        .join("wasm32-unknown-unknown")
        .join("release")
        .join("maskwars_bounty.wasm")
}

pub fn season_wasm_path() -> PathBuf {
    workspace_root()
        .join("target")
        .join("season-wasm")
        .join("wasm32-unknown-unknown")
        .join("release")
        .join("maskwars_season.wasm")
}

/// Builds the season treasury (`contracts/season`, its own crate) for wasm.
pub fn build_season() -> Result<()> {
    let root = workspace_root();
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(root.join("..").join("season"))
        .env("RUSTFLAGS", "--cfg near -C link-arg=-s")
        .env("CARGO_TARGET_DIR", root.join("target").join("season-wasm"))
        .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
        .status()
        .context("run cargo build for the season treasury")?;
    if !status.success() {
        bail!("season wasm build failed");
    }
    Ok(())
}

pub fn house_wasm_path() -> PathBuf {
    workspace_root()
        .join("target")
        .join("house-wasm")
        .join("wasm32-unknown-unknown")
        .join("release")
        .join("maskwars_house.wasm")
}

/// Builds the house contract (`contracts/house`, its own crate) for wasm.
pub fn build_house() -> Result<()> {
    let root = workspace_root();
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(root.join("..").join("house"))
        .env("RUSTFLAGS", "--cfg near -C link-arg=-s")
        .env("CARGO_TARGET_DIR", root.join("target").join("house-wasm"))
        .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
        .status()
        .context("run cargo build for the house contract")?;
    if !status.success() {
        bail!("house wasm build failed");
    }
    Ok(())
}

/// Where `build_masks` puts the mask factory and the mask code.
pub fn masks_wasm_dir() -> PathBuf {
    workspace_root().join("target").join("masks-wasm").join("wasm32-unknown-unknown").join("release")
}

/// Builds the mask factory and the mask code (`contracts/masks`, their own workspace) for wasm: the people's masks
/// race beside the arena's own (tests/human.rs).
pub fn build_masks() -> Result<()> {
    let root = workspace_root();
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(root.join("..").join("masks"))
        .env("RUSTFLAGS", "--cfg near -C link-arg=-s")
        .env("CARGO_TARGET_DIR", root.join("target").join("masks-wasm"))
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "maskwars-masks",
            "-p",
            "maskwars-mask",
        ])
        .status()
        .context("run cargo build for the mask factory")?;
    if !status.success() {
        bail!("mask factory wasm build failed");
    }
    Ok(())
}

/// Where `build_home` puts the code of `home` for `network` (`mainnet` or `testnet`): the very file contracts/home/build.sh
/// makes from this source.
pub fn home_wasm_path(network: &str) -> PathBuf {
    workspace_root().join("..").join("home").join("target").join("wasm").join(format!("maskwars_home-{network}.wasm"))
}

/// Builds `home` (contracts/home, its own crate) for both networks with its own script: the same bytes in any folder.
pub fn build_home() -> Result<()> {
    let status = std::process::Command::new("bash")
        .arg(workspace_root().join("..").join("home").join("build.sh"))
        .status()
        .context("run contracts/home/build.sh")?;
    if !status.success() {
        bail!("home wasm build failed");
    }
    Ok(())
}

/// Builds the bounty contract (its own crate next to this workspace) for wasm.
pub fn build_bounty() -> Result<()> {
    let root = workspace_root();
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(root.join("..").join("bounty"))
        .env("RUSTFLAGS", "--cfg near -C link-arg=-s")
        .env("CARGO_TARGET_DIR", root.join("target").join("bounty-wasm"))
        .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
        .status()
        .context("run cargo build for the bounty contract")?;
    if !status.success() {
        bail!("bounty wasm build failed");
    }
    Ok(())
}

/// A round reads nothing from GitHub.
pub struct NoGitHub;

impl GitHub for NoGitHub {
    fn get(&self, path: &str) -> std::result::Result<Value, String> {
        Err(format!("no GitHub in the sandbox: {path}"))
    }
}

/// The sandbox's JSON-RPC over plain HTTP, for the judge, which asks synchronously.
pub struct SandboxRpc {
    host: String,
}

impl SandboxRpc {
    pub fn new(addr: &str) -> Result<Self> {
        let host = addr.trim_start_matches("http://").trim_end_matches('/').to_string();
        Ok(Self { host })
    }

    fn post(&self, body: &str) -> std::result::Result<Value, String> {
        let mut s = TcpStream::connect(&self.host).map_err(|e| e.to_string())?;
        let req = format!(
            "POST / HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.host,
            body.len()
        );
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        let mut raw = vec![];
        s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&raw);
        let (head, body) = text.split_once("\r\n\r\n").ok_or("no HTTP body")?;
        let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
            unchunk(body)
        } else {
            body.to_string()
        };
        serde_json::from_str(&body).map_err(|e| e.to_string())
    }
}

fn unchunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some((size, tail)) = rest.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || tail.len() < n {
            break;
        }
        out.push_str(&tail[..n]);
        rest = tail[n..].trim_start_matches("\r\n");
    }
    out
}

impl Chain for SandboxRpc {
    fn name(&self) -> &str {
        "sandbox"
    }
    fn rpc(&self, method: &str, params: Value) -> std::result::Result<Value, String> {
        self.post(&json!({ "jsonrpc": "2.0", "id": "round", "method": method, "params": params }).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seal_matches_the_contract_and_the_masks() {
        // The vector the bounty contract and packages/race check too.
        let plan = r#"[{"method":"set_owner","args":{"new_owner":"nova.tinygif8324.testnet"}},{"method":"sweep","args":{"to":"nova.tinygif8324.testnet","amount":"1000000000000000000000000"}}]"#;
        assert_eq!(
            seal_hash("race-0004", "nova.tinygif8324.testnet", "0123456789abcdef0123456789abcdef", plan),
            "cce78cfbfb2d6aee8c1b5aed63ee1fdc5c1efe8cab8a421bae8a200979e6ca10"
        );
        assert_eq!(plan_text(&the_hole("owner", "nova.tinygif8324.testnet", ONE_NEAR)), plan);
    }

    #[test]
    fn a_code_hash_is_base58_of_the_sha256() {
        // NEAR's code hash of an empty contract: sha256("") in base58.
        assert_eq!(code_hash(b""), "GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn");
    }

    #[test]
    fn chunked_bodies_are_joined() {
        assert_eq!(unchunk("4\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\n\r\n"), "{\"a\":1}");
    }
}
