//! MASK WARS bounty. A team locks NEAR for a race. When a mask breaks the target, anyone asks the judge, a module on
//! OutLayer that runs in a TEE. If the judge confirms a break for this bounty, the contract pays the winning mask
//! itself. If nobody breaks the target before the deadline, the team takes its NEAR back. Nobody moves the money by
//! hand.
//!
//! Two kinds of race:
//! - a live safe on chain (`open_safe`, `commit`, `reveal`, `claim_drain`): a sealed round. Each mask first seals the
//!   hash of its plan, then drains the real safe with its own key, reveals the plan and claims; the judge reads the
//!   drain from the chain. The earliest seal whose claim the judge confirms wins (RULES.md);
//! - a sandbox race (`open`, `claim`): a team's private code never leaves the sandbox, and the judge reads the result
//!   of the `Live race` run on GitHub.
//!
//! Who can change the rules (admin.rs): nobody holds a key to the contract's account. Its admin proposes a new code,
//! judge or safe, the proposal waits in the open (`pending`) and only then applies. Every bounty keeps the judge it
//! was opened with.
//!
//! Every claim has its own record, so any number of claims can be with the judge at once: junk never blocks a real
//! claim, and a claim the judge never answers is dropped after `CLAIM_TIMEOUT_BLOCKS` (`unstick`).

mod admin;
#[cfg(test)]
mod tests;

pub use admin::{Change, Pending};

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::BorshStorageKey;
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

/// The smallest bounty, so a race is worth running: what the winner can take, after storage.
pub const MIN_BOUNTY: NearToken = NearToken::from_millinear(100);
/// What a claim must attach for the judge's run on OutLayer; the unused part goes back to the claimer. A mask's first
/// drain claim in a race may attach nothing: then this much comes out of the bounty instead (see `claim_drain`).
pub const MIN_JUDGE_FEE: NearToken = NearToken::from_millinear(10);
/// How long a sandbox race may run, in hours.
pub const MAX_HOURS: u64 = 72;
/// How long a sealed round may run, in hours. The judge reads the safe at the block the round opened in, and a regular
/// testnet RPC keeps blocks for about two and a half days: the round and its claim grace must fit well inside that.
pub const MAX_ROUND_HOURS: u64 = 24;
/// The least a drain must take out of the safe to count.
pub const MIN_LOOT: NearToken = NearToken::from_millinear(100);
/// Masks in one live race.
pub const MAX_MASKS: usize = 16;
/// The judge's answer pays the winner and schedules `on_paid`: it must never run out of gas, or the claim would stay
/// with the judge until `unstick`.
const ON_JUDGED_GAS: Gas = Gas::from_tgas(40);
const ON_PAID_GAS: Gas = Gas::from_tgas(10);
/// OutLayer's part; whatever the claim leaves unspent goes to it as well.
const OUTLAYER_GAS: Gas = Gas::from_tgas(100);
const MIN_CLAIM_GAS: Gas = Gas::from_tgas(180);
/// The safe arms itself for the round, and the contract hears back: a safe that would not arm takes no round.
const ARM_GAS: Gas = Gas::from_tgas(10);
const ON_ARMED_GAS: Gas = Gas::from_tgas(15);
/// The safe hears each seal of its round (`queue`): only a mask that sealed moves it, in the order of the seals.
const QUEUE_GAS: Gas = Gas::from_tgas(5);
/// After the deadline a mask still has this long to claim a break made before it; only then can the team take its
/// NEAR back.
pub const CLAIM_GRACE_HOURS: u64 = 12;
/// OutLayer answers or fails a request within 200 blocks. A claim with no answer after this many is dropped by anyone
/// (`unstick`), so a lost callback never holds a bounty.
pub const CLAIM_TIMEOUT_BLOCKS: u64 = 600;
/// In a sealed round, the masks play and reveal for this long after the commit window unless the team says otherwise.
pub const DEFAULT_REVEAL_MINUTES: u64 = 60;
/// A mask's turn on a live safe (`TURN_NS` there): each earlier seal may keep a later one waiting this long, so the
/// reveal window gives every mask its slot and the last one time to play and reveal.
pub const SAFE_TURN_MINUTES: u64 = 3;
/// The judge's whole answer is a short JSON: anything longer is not a verdict, and reading it costs gas.
const MAX_REPLY_BYTES: usize = 4096;
/// Storage a bounty may still grow by after it opens: its final status with the longest account and transaction.
pub const BOUNTY_GROWTH_BYTES: u64 = 240;
/// Storage one mask of a sealed round may take at most: the biggest seal and revealed plan, its claim on the judge
/// and the keys that make a drain pay once. `the_reserve_covers_the_biggest_mask` measures it.
pub const MASK_STORAGE_BYTES: u64 = 4000;
pub(crate) const NS_PER_HOUR: u64 = 3_600_000_000_000;
const NS_PER_MINUTE: u64 = 60_000_000_000;
/// A revealed plan: the calls a mask sends the safe, in order.
pub const MAX_PLAN_CALLS: usize = 12;
pub const MAX_PLAN_BYTES: usize = 2048;
/// What a seal hashes: `maskwars-commit:<id>:<mask>:<salt>:<plan>`.
const SEAL_PREFIX: &str = "maskwars-commit";

/// The judge's bounds on OutLayer. All three are given: OutLayer's contract takes a missing one, but its workers read
/// the request event as plain numbers and silently drop an event with a `null`, so the run never starts. These are
/// the values OutLayer prices a request at anyway.
fn judge_limits() -> Value {
    json!({ "max_instructions": 1_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60 })
}

/// The judge's secret for a sandbox race: the GitHub token, stored on OutLayer by the owner of the judge's project (the
/// contract's own account holds no key, so it could not store one). A drain is read from the chain and needs none, and
/// it must not ask for one: OutLayer checks the secret's access list against whoever signed the claim, and a mask is
/// not on it.
fn judge_secrets(project: &str, drain: Option<&Drain>) -> Option<Value> {
    let owner = project.split('/').next().unwrap_or_default();
    drain.is_none().then(|| json!({ "profile": "default", "account_id": owner }))
}

#[ext_contract(ext_outlayer)]
#[allow(dead_code)]
trait OutLayer {
    fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    );
}

/// A live safe of the arena (contracts/challenges/live-safe): the contract named at its deployment arms it for one
/// round its own team opens, and until the commit window closes nobody moves it. After the window only the masks
/// that sealed a plan move it, in the order of their seals.
#[ext_contract(ext_safe)]
#[allow(dead_code)]
trait LiveSafe {
    fn arm(&mut self, bounty: String, opens_ns: U64, masks: Vec<AccountId>, team: AccountId);
    fn queue(&mut self, bounty: String, mask: AccountId, seq: u32);
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    /// Locked, waiting for a break. Claims may be with the judge meanwhile (`get_terms`).
    Open,
    /// Only bounties from before per-claim records: one claim held the whole bounty. Nothing new is ever put here.
    Judging {
        claimant: AccountId,
    },
    Paid {
        winner: AccountId,
        run_id: U64,
    },
    Refunded,
    /// A mask drained the live safe with its own key and was paid. New variants go last: the state is Borsh.
    Drained {
        winner: AccountId,
        tx_hash: String,
    },
}

/// The terms of a live race: the safe on chain, the masks allowed to win it and what counts as a drain.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SafeRace {
    pub safe: AccountId,
    pub masks: Vec<AccountId>,
    /// yoctoNEAR the plan must move from the safe to the mask, net of what the mask put in.
    pub min_loot: U128,
    pub opened_ns: U64,
}

/// A sandbox race's own terms: when it opened and which masks may win it. The judge reads only a run that started
/// after the opening, and the contract pays only one of these masks.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SandboxRace {
    pub masks: Vec<AccountId>,
    pub opened_ns: U64,
}

/// The drain a claim names.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Drain {
    pub tx_hash: String,
    pub mask: AccountId,
}

/// A live race's sealed round: masks seal their plans until `commit_until`; only after it does a drain count.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Round {
    /// The block the round opened in: the judge checks the safe's code and keys as they were then.
    pub opened_height: U64,
    pub commit_until: U64,
    /// Seals so far; the next seal gets this number.
    pub sealed: u32,
}

/// Where a mask's seal stands. New variants go last: the state is Borsh.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SealState {
    /// Only the hash is known.
    Sealed,
    /// The plan and its transactions are public; the judge has not confirmed it.
    Revealed,
    /// The judge confirmed the drain: this seal can win.
    Confirmed,
    /// The judge refused the drain. The mask may claim again; meanwhile it gives way to later seals.
    Refused,
}

/// One mask's seal in a round. The plan stays `null` until the mask reveals it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Seal {
    pub mask: AccountId,
    /// sha256 of `maskwars-commit:<id>:<mask>:<salt>:<plan>`, lowercase hex.
    pub hash: String,
    /// Arrival order in the round: 0 is the earliest.
    pub seq: u32,
    pub at_ns: U64,
    pub state: SealState,
    pub salt: Option<String>,
    pub plan: Option<String>,
    /// One transaction per call of the plan, in order.
    pub txs: Vec<String>,
    /// The drain the judge confirmed.
    pub drain_tx: Option<String>,
}

/// A live race's round as anyone sees it: every seal by arrival, plans only once revealed.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RoundView {
    pub commit_until: U64,
    /// Seals not revealed by then drop out and hold no payout.
    pub reveal_until: U64,
    pub deadline_ns: U64,
    pub seals: Vec<Seal>,
    /// Masks whose claim is with the judge right now.
    pub judging: Vec<AccountId>,
}

/// One call of a revealed plan: what the mask sends the safe.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct PlanCall {
    pub method: String,
    pub args: Value,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bounty {
    pub owner: AccountId,
    /// What the winner takes.
    pub amount: U128,
    /// What the masks race on: a training target or the team's repository; the safe for a live race.
    pub target: String,
    pub deadline_ns: U64,
    pub status: Status,
}

/// What a bounty fixed when it opened and keeps until it ends.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Terms {
    /// The judge's wasm (its sha256, OutLayer's version key) every claim on this bounty goes to. A later change of
    /// the contract's judge applies to new bounties only.
    pub judge_version: String,
    /// NEAR set aside from the deposit for the storage this bounty still takes: seals, reveals, claims, the final
    /// status. What is left goes back to the team when the bounty ends.
    pub reserve: U128,
    /// Claims with the judge right now.
    pub judging: u32,
    /// A sealed round: seals not revealed by then drop out.
    pub reveal_until: Option<U64>,
    /// A sealed round: the safe's code hash (base58, as NEAR shows it), one the contract knows.
    pub safe_code: Option<String>,
}

/// A claim with the judge. It lives until the judge answers or `unstick` drops it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Claim {
    pub bounty: String,
    pub by: AccountId,
    pub height: U64,
    pub run_id: Option<U64>,
    pub drain: Option<Drain>,
    /// The bounty paid this claim's judge: the mask's one free claim, given back if the judge's run itself fails.
    pub free: bool,
}

/// The judge's answer for one claim: `run_id` for a sandbox race, `tx_hash` for a drain.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Verdict {
    bounty_id: String,
    winner: AccountId,
    run_id: Option<U64>,
    tx_hash: Option<String>,
    /// For a drain: the safe's code at the drain's block.
    safe_code_hash: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct JudgeReply {
    success: bool,
    output: Option<Verdict>,
    error: Option<String>,
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Safes,
    Drains,
    Rounds,
    Seals,
    Terms,
    Claims,
    SealClaims,
    /// New keys go last: the prefixes are what is already on chain.
    Sandboxes,
}

/// Sandbox races' terms (`SandboxRace`), by bounty id. Kept under a prefix of their own, outside the contract's
/// struct: the state already on chain reads as it is, and new code needs no new migration step for it. Bounties opened
/// before have none: they keep the judge they were opened with, which never asked.
fn sandboxes() -> LookupMap<String, SandboxRace> {
    LookupMap::new(Key::Sandboxes)
}

/// 1 to 16 masks, none listed twice, and neither the team nor `other` among them.
fn masks_ok(masks: &[AccountId], team: &AccountId, other: &AccountId) {
    require!((1..=MAX_MASKS).contains(&masks.len()), "masks: 1 to 16 accounts");
    for (i, m) in masks.iter().enumerate() {
        require!(!masks[..i].contains(m), "a mask is listed twice");
        require!(m != team && m != other, "the team or the safe cannot race for its own bounty");
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bounties {
    /// OutLayer's contract (`outlayer.testnet` or `outlayer.near`).
    outlayer: AccountId,
    /// The judge's OutLayer project, `owner/name`.
    judge_project: String,
    /// The judge every new bounty is pinned to.
    judge_version: String,
    bounties: LookupMap<String, Bounty>,
    /// Bounty id → its live safe. A bounty without one is a sandbox race.
    safes: LookupMap<String, SafeRace>,
    /// Drain transaction → the bounty it was claimed for: one drain pays once. Also `<bounty>/<mask>` → the
    /// transaction of the mask's one claim whose judge fee the bounty paid; neither part of that key can be a hash.
    drains: LookupMap<String, String>,
    /// Bounty id → its sealed round. Every live race opened since sealed rounds has one.
    rounds: LookupMap<String, Round>,
    /// `<bounty>/<mask>` → that mask's seal in the round.
    seals: LookupMap<String, Seal>,
    /// Who may propose a change (admin.rs). It holds no key to this account.
    admin: AccountId,
    pending: Option<Pending>,
    /// Code hashes of the safes a sealed round may run on (base58, as NEAR shows a code hash).
    safe_codes: Vec<String>,
    terms: LookupMap<String, Terms>,
    claims: LookupMap<u64, Claim>,
    /// `<bounty>/<mask>` → the number of that seal's claim with the judge.
    seal_claims: LookupMap<String, u64>,
    next_claim: u64,
    /// Bounties not yet paid or refunded. With none, a change needs only the short notice.
    live: u32,
    /// The judge of bounties opened before each bounty kept its own.
    legacy_judge: String,
    /// The block of the last `migrate` from an older state: a bounty left in the old `Judging` may be reopened
    /// `CLAIM_TIMEOUT_BLOCKS` after it.
    migrated_height: u64,
}

/// The state before sealed rounds (testnet until 7.11.2026).
#[near(serializers = [borsh])]
struct BountiesV2 {
    outlayer: AccountId,
    judge_project: String,
    judge_version: Option<String>,
    bounties: LookupMap<String, Bounty>,
    safes: LookupMap<String, SafeRace>,
    drains: LookupMap<String, String>,
}

/// The state with sealed rounds, before per-claim records and the delayed admin.
#[near(serializers = [borsh])]
struct BountiesV3 {
    outlayer: AccountId,
    judge_project: String,
    judge_version: Option<String>,
    bounties: LookupMap<String, Bounty>,
    safes: LookupMap<String, SafeRace>,
    drains: LookupMap<String, String>,
    rounds: LookupMap<String, Round>,
    seals: LookupMap<String, Seal>,
}

fn id_ok(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An OutLayer version key for a wasm module: its SHA-256, 64 lowercase hex characters.
pub(crate) fn version_ok(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A NEAR transaction hash or code hash: base58 of 32 bytes.
pub(crate) fn b58_32_ok(h: &str) -> bool {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    (32..=44).contains(&h.len()) && h.bytes().all(|c| B58.contains(&c))
}

fn tx_hash_ok(h: &str) -> bool {
    b58_32_ok(h)
}

fn hex64_ok(v: &str) -> bool {
    version_ok(v)
}

fn salt_ok(s: &str) -> bool {
    (16..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn seal_key(id: &str, mask: &AccountId) -> String {
    format!("{id}/{mask}")
}

fn cost_of(bytes: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear() * u128::from(bytes)
}

/// The seal of a plan: sha256 of `maskwars-commit:<id>:<mask>:<salt>:<plan>`, lowercase hex. Neither the id, the
/// mask nor the salt can hold a `:`, so the plan is everything after the fourth one. The mask is inside, so copying
/// another mask's hash seals nothing of one's own.
pub fn seal_hash(id: &str, mask: &AccountId, salt: &str, plan: &str) -> String {
    let digest = env::sha256(format!("{SEAL_PREFIX}:{id}:{mask}:{salt}:{plan}").as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// A revealed plan: a JSON array of 1-12 calls `{ "method", "args" }`, each method a plain name, args an object.
fn parse_plan(plan: &str) -> Result<Vec<PlanCall>, String> {
    let calls: Vec<PlanCall> =
        serde_json::from_str(plan).map_err(|_| "plan: a JSON array of { method, args }".to_string())?;
    if !(1..=MAX_PLAN_CALLS).contains(&calls.len()) {
        return Err("plan: 1 to 12 calls".into());
    }
    for c in &calls {
        let name_ok =
            (1..=64).contains(&c.method.len()) && c.method.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !name_ok || !c.args.is_object() {
            return Err("plan: each call is a method name and an args object".into());
        }
    }
    Ok(calls)
}

#[near]
impl Bounties {
    /// A fresh contract. `judge_version` pins the judge for every bounty opened until a change applies; `admin` may
    /// propose changes and holds no key to this account; `safe_codes` are the safes a sealed round may run on.
    #[init]
    pub fn new(
        outlayer: AccountId,
        judge_project: String,
        judge_version: String,
        admin: AccountId,
        safe_codes: Vec<String>,
    ) -> Self {
        require!(judge_project.contains('/'), "judge project is owner/name");
        require!(version_ok(&judge_version), "judge version: the wasm's sha256 in hex");
        require!(safe_codes.iter().all(|c| b58_32_ok(c)), "safe code: a code hash in base58");
        Self {
            outlayer,
            judge_project,
            legacy_judge: judge_version.clone(),
            judge_version,
            bounties: LookupMap::new(b"b"),
            safes: LookupMap::new(Key::Safes),
            drains: LookupMap::new(Key::Drains),
            rounds: LookupMap::new(Key::Rounds),
            seals: LookupMap::new(Key::Seals),
            admin,
            pending: None,
            safe_codes,
            terms: LookupMap::new(Key::Terms),
            claims: LookupMap::new(Key::Claims),
            seal_claims: LookupMap::new(Key::SealClaims),
            next_claim: 0,
            live: 0,
            migrated_height: 0,
        }
    }

    /// Reads the state the code finds and keeps all of it: every bounty, live race, round, seal and claimed drain.
    /// Runs right after new code: `upgrade` calls it with nothing, or the account's owner deploys an older contract's
    /// account with it in the same transaction. From a state before the delayed admin, `admin` defaults to the
    /// account itself and `judge_version` must be given if the old contract pinned none. Bounties opened before keep
    /// the judge the old contract had. On the current state it changes nothing.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(admin: Option<AccountId>, judge_version: Option<String>) -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no state to migrate"));
        if let Ok(now) = near_sdk::borsh::from_slice::<Self>(&raw) {
            return now;
        }
        let me = env::current_account_id();
        let pin = |old: Option<String>| -> (String, String) {
            let new = judge_version.clone().or_else(|| old.clone());
            let new = new.unwrap_or_else(|| env::panic_str("the old contract pinned no judge: pass judge_version"));
            require!(version_ok(&new), "judge version: the wasm's sha256 in hex");
            (old.unwrap_or_else(|| new.clone()), new)
        };
        let fresh = |outlayer, judge_project, legacy_judge, judge_version, admin| Self {
            outlayer,
            judge_project,
            judge_version,
            bounties: LookupMap::new(b"b"),
            safes: LookupMap::new(Key::Safes),
            drains: LookupMap::new(Key::Drains),
            rounds: LookupMap::new(Key::Rounds),
            seals: LookupMap::new(Key::Seals),
            admin,
            pending: None,
            safe_codes: vec![],
            terms: LookupMap::new(Key::Terms),
            claims: LookupMap::new(Key::Claims),
            seal_claims: LookupMap::new(Key::SealClaims),
            next_claim: 0,
            live: 0,
            legacy_judge,
            migrated_height: env::block_height(),
        };
        let admin = admin.unwrap_or(me);
        if let Ok(v3) = near_sdk::borsh::from_slice::<BountiesV3>(&raw) {
            let (legacy, current) = pin(v3.judge_version);
            return Self {
                bounties: v3.bounties,
                safes: v3.safes,
                drains: v3.drains,
                rounds: v3.rounds,
                seals: v3.seals,
                ..fresh(v3.outlayer, v3.judge_project, legacy, current, admin)
            };
        }
        if let Ok(v2) = near_sdk::borsh::from_slice::<BountiesV2>(&raw) {
            let (legacy, current) = pin(v2.judge_version);
            return Self {
                bounties: v2.bounties,
                safes: v2.safes,
                drains: v2.drains,
                ..fresh(v2.outlayer, v2.judge_project, legacy, current, admin)
            };
        }
        env::panic_str("unknown state: nothing migrated")
    }

    /// Locks the attached NEAR as the bounty for a race on `target` that ends in `hours`. `masks` are the accounts
    /// that may win it, 1 to 16, the team not among them: whatever the race reports, the contract pays only one of
    /// them, and the judge reads only a run that started after this opening. `judge_version` is the judge the team
    /// agrees to (`judge()`): if it is not the contract's judge right now, nothing opens.
    #[payable]
    pub fn open(
        &mut self,
        id: String,
        target: String,
        hours: u64,
        judge_version: String,
        masks: Vec<AccountId>,
    ) -> Bounty {
        require!((1..=MAX_HOURS).contains(&hours), "hours: 1 to 72");
        let team = env::predecessor_account_id();
        masks_ok(&masks, &team, &env::current_account_id());
        let before = env::storage_usage();
        self.lock(id.clone(), target, hours, &judge_version, None, None);
        let mut races = sandboxes();
        races.insert(id.clone(), SandboxRace { masks, opened_ns: U64(env::block_timestamp()) });
        races.flush();
        self.charge_opening(&id, before, BOUNTY_GROWTH_BYTES)
    }

    /// Locks the attached NEAR as the bounty for a sealed round on the safe `safe` (RULES.md). For the first
    /// `commit_minutes` the masks only seal their plans (`commit`). For `reveal_minutes` after that (60 by default)
    /// they play and reveal; a seal not revealed by then drops out. Until the deadline `hours` after opening, a mask
    /// claims its drain of at least `min_loot`. The earliest seal whose drain the judge confirms wins.
    ///
    /// The safe runs code the contract knows (`safe_codes`), named by `safe_code`; the judge checks it and that
    /// nobody holds a key to the safe. The contract arms the safe for the round right away (`arm`), naming the caller
    /// as the round's team: a safe takes only the round of the team named at its deployment, so nobody else can take
    /// a fresh safe first. From then on nobody moves it before the commit window closes, and after it each mask that
    /// sealed a plan has the safe to itself for one turn, in the order of the seals. A safe that does not arm (another
    /// contract or team named at its deployment, armed already, other masks, another owner) takes no round, and
    /// `on_armed` gives the whole deposit back. `judge_version` is the judge the team agrees to,
    /// as for `open`. The deposit also sets aside the storage every mask may take (`get_terms`): a mask's key never
    /// attaches NEAR. The team that opens the bounty cannot be one of the masks.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn open_safe(
        &mut self,
        id: String,
        safe: AccountId,
        masks: Vec<AccountId>,
        min_loot: U128,
        hours: u64,
        commit_minutes: u64,
        reveal_minutes: Option<u64>,
        safe_code: String,
        judge_version: String,
    ) -> Bounty {
        let owner = env::predecessor_account_id();
        require!((1..=MAX_HOURS).contains(&hours), "hours: 1 to 72");
        require!(hours <= MAX_ROUND_HOURS, "hours: a sealed round runs 24 hours at most");
        masks_ok(&masks, &owner, &safe);
        require!(safe != env::current_account_id(), "the safe is another account");
        require!(min_loot.0 >= MIN_LOOT.as_yoctonear(), "min_loot: at least 0.1 NEAR");
        require!(self.safe_codes.contains(&safe_code), "the safe's code is not one the contract knows");
        let reveal_minutes = reveal_minutes.unwrap_or(DEFAULT_REVEAL_MINUTES);
        require!(
            commit_minutes >= 1 && commit_minutes < hours.saturating_mul(60),
            "commit_minutes: at least 1 and less than the race"
        );
        require!(
            reveal_minutes >= 1 && commit_minutes.saturating_add(reveal_minutes) <= hours.saturating_mul(60),
            "reveal_minutes: at least 1, and the windows fit in the race"
        );
        require!(
            reveal_minutes >= SAFE_TURN_MINUTES * (masks.len() as u64 + 1),
            "reveal_minutes: 3 for each mask's turn on the safe, and 3 more"
        );
        let now = env::block_timestamp();
        let commit_until = now + commit_minutes * NS_PER_MINUTE;
        let reveal_until = commit_until + reveal_minutes * NS_PER_MINUTE;
        let before = env::storage_usage();
        self.lock(id.clone(), safe.to_string(), hours, &judge_version, Some(U64(reveal_until)), Some(safe_code));
        let race = SafeRace { safe: safe.clone(), masks: masks.clone(), min_loot, opened_ns: U64(now) };
        let round = Round { opened_height: U64(env::block_height()), commit_until: U64(commit_until), sealed: 0 };
        log!("bounty {} is a sealed round on {} for {} masks", id, race.safe, race.masks.len());
        let reserve = BOUNTY_GROWTH_BYTES + MASK_STORAGE_BYTES * race.masks.len() as u64;
        self.safes.insert(id.clone(), race);
        self.rounds.insert(id.clone(), round);
        let bounty = self.charge_opening(&id, before, reserve);
        let _ = ext_safe::ext(safe)
            .with_static_gas(ARM_GAS)
            .arm(id.clone(), U64(commit_until), masks, owner)
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_ARMED_GAS).on_armed(id));
        bounty
    }

    /// The safe's answer to `arm`. Armed: the round goes on. Not armed: the safe takes no round, so nothing could ever
    /// be confirmed on it, and the team gets the bounty and its whole storage reserve back at once. It never fails.
    #[private]
    pub fn on_armed(&mut self, id: String) -> Option<Status> {
        let armed = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        let mut bounty = self.bounties.get(&id).cloned()?;
        if armed {
            log!("the safe {} is armed for {}", bounty.target, id);
            return Some(bounty.status);
        }
        if bounty.status != Status::Open {
            return Some(bounty.status);
        }
        bounty.status = Status::Refunded;
        self.bounties.insert(id.clone(), bounty.clone());
        self.live = self.live.saturating_sub(1);
        log!("bounty {} refunded to {}: the safe {} would not arm for the round", id, bounty.owner, bounty.target);
        let _ = Promise::new(bounty.owner.clone()).transfer(NearToken::from_yoctonear(bounty.amount.0));
        self.return_reserve(&id, &bounty.owner);
        Some(Status::Refunded)
    }

    /// A mask of the round seals its plan: `hash` is sha256 of `maskwars-commit:<id>:<mask>:<salt>:<plan>` in hex.
    /// Only during the commit window, once per mask, final. Seals are numbered as they arrive; anyone sees the hashes,
    /// nobody sees a plan. The bounty's reserve pays the seal's storage: a mask's key never attaches NEAR.
    ///
    /// The contract tells the safe the seal (`queue`): after the window only a mask that sealed moves the safe, and
    /// seal #0 plays first. The safe keeps the seals in a place of fixed size, so a seal never eats into the NEAR it can
    /// pay out. A safe from before seal order does not take the call, which changes nothing there.
    pub fn commit(&mut self, id: String, hash: String) -> Seal {
        let mask = env::predecessor_account_id();
        let race = self.live_race(&id);
        require!(race.masks.contains(&mask), "only a mask of this race can seal a plan");
        let mut round = self.round(&id);
        self.get_open(&id);
        require!(env::block_timestamp() < round.commit_until.0, "the commit window is closed");
        require!(hex64_ok(&hash), "hash: sha256 in lowercase hex");
        let key = seal_key(&id, &mask);
        require!(!self.seals.contains_key(&key), "this mask has already sealed its plan");
        let before = env::storage_usage();
        let seal = Seal {
            mask: mask.clone(),
            hash,
            seq: round.sealed,
            at_ns: U64(env::block_timestamp()),
            state: SealState::Sealed,
            salt: None,
            plan: None,
            txs: vec![],
            drain_tx: None,
        };
        round.sealed += 1;
        self.rounds.insert(id.clone(), round);
        self.seals.insert(key, seal.clone());
        self.account_storage(&id, before, true);
        log!("{} sealed a plan for {}: seal #{}", mask, id, seal.seq);
        let _ = ext_safe::ext(race.safe).with_static_gas(QUEUE_GAS).queue(id, mask, seal.seq);
        seal
    }

    /// After the commit window, and before the reveal window ends, the mask shows what it sealed: the plan, the salt,
    /// and the transactions in which it sent each call of the plan to the safe. The contract checks the plan against
    /// the seal; the judge later checks the transactions against the plan. From here on the plan is public.
    pub fn reveal(&mut self, id: String, plan: String, salt: String, txs: Vec<String>) -> Seal {
        let mask = env::predecessor_account_id();
        self.live_race(&id);
        let round = self.round(&id);
        let bounty = self.bounties.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(matches!(bounty.status, Status::Open | Status::Judging { .. }), "the bounty is not open");
        let now = env::block_timestamp();
        require!(now >= round.commit_until.0, "the commit window is still open: reveal after it");
        let (_, last_reveal) = self.reveal_times(&id, &bounty);
        require!(now < last_reveal, "the reveal window is closed");
        let key = seal_key(&id, &mask);
        let mut seal = self.seals.get(&key).cloned().unwrap_or_else(|| env::panic_str("this mask sealed no plan"));
        require!(seal.state == SealState::Sealed, "this plan is already revealed");
        require!(salt_ok(&salt), "salt: 16-128 letters, digits, - or _");
        require!(plan.len() <= MAX_PLAN_BYTES, "plan: at most 2048 bytes");
        require!(seal_hash(&id, &mask, &salt, &plan) == seal.hash, "the plan does not match the seal");
        let calls = parse_plan(&plan).unwrap_or_else(|e| env::panic_str(&e));
        require!(txs.len() == calls.len(), "one transaction per call of the plan");
        for (i, tx) in txs.iter().enumerate() {
            require!(tx_hash_ok(tx), "txs: NEAR transaction hashes");
            require!(!txs[..i].contains(tx), "a transaction is listed twice");
        }
        let before = env::storage_usage();
        seal.state = SealState::Revealed;
        seal.salt = Some(salt);
        seal.plan = Some(plan);
        seal.txs = txs;
        self.seals.insert(key, seal.clone());
        self.account_storage(&id, before, true);
        log!("{} revealed seal #{} of {}: {} calls", mask, seal.seq, id, calls.len());
        seal
    }

    /// Pays the round's winner once nothing can beat it: the earliest confirmed seal, when every earlier seal is out.
    /// Anyone may call it; the NEAR only goes to the winner.
    pub fn settle(&mut self, id: String) -> Status {
        let bounty = self.get_open(&id);
        match self.winner(&id) {
            Ok(seal) => self.pay_drain(&id, bounty, seal),
            Err(why) => env::panic_str(&why),
        }
    }

    /// Asks the judge whether race `run_id` broke this bounty's target. Anyone may ask, any number of times, until
    /// `CLAIM_GRACE_HOURS` after the deadline. The attached NEAR pays for the claim's own storage and the judge's run;
    /// what the run leaves goes back to the caller. The money goes to the winner the judge names, never to the caller
    /// because they asked. Claims do not wait for each other: the first one confirmed is paid.
    #[payable]
    pub fn claim(&mut self, id: String, run_id: U64) -> Promise {
        require!(!self.safes.contains_key(&id), "this bounty pays for a drain on chain: use claim_drain");
        let bounty = self.get_open(&id);
        self.claim_window(&bounty);
        let before = env::storage_usage();
        let no = self.add_claim(
            &id,
            Claim {
                bounty: id.clone(),
                by: env::predecessor_account_id(),
                height: U64(env::block_height()),
                run_id: Some(run_id),
                drain: None,
                free: false,
            },
        );
        self.flush();
        let storage = cost_of(env::storage_usage().saturating_sub(before));
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= storage + MIN_JUDGE_FEE.as_yoctonear(),
            "attach at least 0.01 NEAR for the judge and the claim's storage"
        );
        let fee = NearToken::from_yoctonear(attached - storage);
        let race = sandboxes().get(&id).cloned();
        let input = json!({ "kind": "race", "bounty_id": id, "target": bounty.target, "run_id": run_id,
                            "opened_ns": race.as_ref().map(|r| r.opened_ns), "masks": race.map(|r| r.masks) });
        self.ask_judge(id, input, None, no, fee, env::predecessor_account_id())
    }

    /// A mask of this race asks the judge whether its own transaction `tx_hash` drained the safe. Only the mask
    /// claims, so nobody else can send its drain to another bounty. It may claim until `CLAIM_GRACE_HOURS` after the
    /// deadline; the drain itself must come before the deadline. Each mask has at most one claim with the judge, and
    /// claims of different masks run side by side.
    ///
    /// A mask that holds only a function-call key cannot attach NEAR: NEAR refuses a deposit from such a key. So once
    /// per race a mask may claim with nothing attached, and the judge's fee comes out of the bounty. Its key then
    /// never needs the power to move the mask's own NEAR. Every further claim of that mask attaches the fee itself.
    ///
    /// In a sealed round the mask must have revealed its plan, and `tx_hash` is the plan's transaction that drained
    /// the safe. A mask whose seal is later than an already confirmed one cannot win and is not judged.
    #[payable]
    pub fn claim_drain(&mut self, id: String, tx_hash: String) -> Promise {
        let mask = env::predecessor_account_id();
        let race =
            self.safes.get(&id).cloned().unwrap_or_else(|| env::panic_str("this bounty is a sandbox race: use claim"));
        require!(race.masks.contains(&mask), "only a mask of this race can win it");
        require!(tx_hash_ok(&tx_hash), "tx_hash: a NEAR transaction hash");
        require!(!self.drains.contains_key(&tx_hash), "this drain is already claimed");
        let round = self.round(&id);
        let key = seal_key(&id, &mask);
        let seal = self.seals.get(&key).cloned().unwrap_or_else(|| env::panic_str("this mask sealed no plan"));
        match seal.state {
            SealState::Sealed => env::panic_str("reveal the plan before claiming"),
            SealState::Confirmed => env::panic_str("this mask's drain is already confirmed"),
            SealState::Revealed | SealState::Refused => {}
        }
        require!(seal.txs.contains(&tx_hash), "the drain is not a transaction of the revealed plan");
        require!(!self.seal_claims.contains_key(&key), "this mask's claim is already with the judge");
        if let Some(lead) = self.leader(&id, &race) {
            require!(seal.seq < lead.seq, "an earlier seal is already confirmed");
        }
        let mut bounty = self.get_open(&id);
        self.claim_window(&bounty);
        let before = env::storage_usage();
        let bounty_pays = env::attached_deposit().is_zero();
        let (fee, payer) = if bounty_pays {
            let once = format!("{id}/{mask}");
            require!(!self.drains.contains_key(&once), "the bounty paid this mask's judge once: attach 0.01 NEAR");
            let fee = MIN_JUDGE_FEE.as_yoctonear();
            require!(bounty.amount.0 > fee, "the bounty cannot pay the judge: attach 0.01 NEAR");
            bounty.amount = U128(bounty.amount.0 - fee);
            self.bounties.insert(id.clone(), bounty.clone());
            self.drains.insert(once, tx_hash.clone());
            (MIN_JUDGE_FEE, env::current_account_id())
        } else {
            require!(env::attached_deposit() >= MIN_JUDGE_FEE, "attach at least 0.01 NEAR for the judge");
            (env::attached_deposit(), mask.clone())
        };
        // The drain is not locked for anyone else here: another mask naming it in its own plan cannot hold it up.
        // It counts as claimed only once the judge confirms it.
        let drain = Drain { tx_hash: tx_hash.clone(), mask: mask.clone() };
        let no = self.add_claim(
            &id,
            Claim {
                bounty: id.clone(),
                by: mask,
                height: U64(env::block_height()),
                run_id: None,
                drain: Some(drain.clone()),
                free: bounty_pays,
            },
        );
        self.seal_claims.insert(key, no);
        self.account_storage(&id, before, true);
        let terms = self.terms_of(&id);
        let input = drain_input(&id, &race, &round, &bounty, &terms, &seal, &tx_hash);
        self.ask_judge(id, input, Some(drain), no, fee, payer)
    }

    /// Drops a claim the judge has not answered within `CLAIM_TIMEOUT_BLOCKS`, so it holds nothing any more: the
    /// bounty can be refunded, the drain claimed again, the seal no longer waits. Anyone may call it. An answer that
    /// still comes later is ignored. Without `claim`, reopens a bounty left `judging` by a contract from before
    /// per-claim records.
    pub fn unstick(&mut self, id: String, claim: Option<U64>) -> Status {
        let now = env::block_height();
        let Some(no) = claim else {
            let mut bounty = self.bounties.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such bounty"));
            require!(matches!(bounty.status, Status::Judging { .. }), "the bounty is not stuck with the judge");
            require!(now >= self.migrated_height + CLAIM_TIMEOUT_BLOCKS, "the judge may still answer");
            bounty.status = Status::Open;
            self.bounties.insert(id.clone(), bounty.clone());
            log!("bounty {} is open again: its old claim never came back", id);
            return bounty.status;
        };
        let c = self.claims.get(&no.0).cloned().unwrap_or_else(|| env::panic_str("no such claim with the judge"));
        require!(c.bounty == id, "this claim is for another bounty");
        require!(now >= c.height.0 + CLAIM_TIMEOUT_BLOCKS, "the judge may still answer");
        let before = env::storage_usage();
        self.release_claim(no.0, &c);
        self.give_back_free_claim(&c);
        self.account_storage(&id, before, false);
        log!("claim #{} on {} dropped: the judge never answered", no.0, id);
        self.bounties.get(&id).map_or(Status::Refunded, |b| b.status.clone())
    }

    /// What the judge's run leaves unspent goes back to whoever paid for it: the claimer, or this contract when the
    /// bounty paid. The question goes to the judge this bounty was opened with.
    fn ask_judge(
        &self,
        id: String,
        input: Value,
        drain: Option<Drain>,
        no: u64,
        fee: NearToken,
        payer: AccountId,
    ) -> Promise {
        let input = input.to_string();
        let secrets = judge_secrets(&self.judge_project, drain.as_ref());
        let version = self.terms_of(&id).judge_version;
        log!("claim #{} on {} goes to judge {}", no, id, version);
        ext_outlayer::ext(self.outlayer.clone())
            .with_attached_deposit(fee)
            .with_static_gas(OUTLAYER_GAS)
            .with_unused_gas_weight(1)
            .request_execution(
                json!({ "Project": { "project_id": self.judge_project, "version_key": version } }),
                Some(judge_limits()),
                Some(input),
                secrets,
                Some("Text".into()),
                Some(payer),
                None,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_JUDGED_GAS).on_judged(
                id,
                drain,
                Some(U64(no)),
            ))
    }

    /// The judge's answer to claim `claim`. A confirmed sandbox race pays its winner. A confirmed drain makes the
    /// mask's seal `confirmed`, and pays it at once if no earlier seal can still win. Anything else frees the drain.
    /// It never fails: whatever comes back, the claim is released and the bounty stays as it should. `claim` is
    /// missing only for a claim sent by a contract from before per-claim records.
    #[private]
    pub fn on_judged(&mut self, id: String, drain: Option<Drain>, claim: Option<U64>) -> Option<Status> {
        let reply = read_reply();
        let before = env::storage_usage();
        let mut bounty = match self.bounties.get(&id).cloned() {
            Some(b) => b,
            None => {
                log!("bounty {} is gone: the judge's answer is ignored", id);
                return None;
            }
        };
        let mut released = None;
        match claim {
            Some(no) => match self.claims.get(&no.0).cloned() {
                Some(c) if c.bounty == id => {
                    self.release_claim(no.0, &c);
                    released = Some(c);
                }
                _ => {
                    log!("claim #{} on {} was dropped before the judge answered: the answer is ignored", no.0, id);
                    return Some(bounty.status);
                }
            },
            None if matches!(bounty.status, Status::Judging { .. }) => {
                bounty.status = Status::Open;
                self.bounties.insert(id.clone(), bounty.clone());
            }
            None => {
                log!("bounty {} was not waiting for this answer: it is ignored", id);
                return Some(bounty.status);
            }
        }
        if bounty.status != Status::Open {
            if let Some(d) = &drain {
                self.free_drain(&id, &d.tx_hash);
            }
            log!("bounty {} is already settled: the judge's answer changes nothing", id);
            self.account_storage(&id, before, false);
            return Some(bounty.status);
        }
        let mut code = None;
        let verdict = match verdict_for(&id, reply) {
            Ok(v) => {
                code = v.safe_code_hash.clone();
                let masks = sandboxes().get(&id).map(|r| r.masks.clone());
                paid_status(v, drain.as_ref(), masks.as_deref()).map_err(|why| (why, true))
            }
            Err(e) => Err(e),
        };
        let status = match verdict {
            Ok(Status::Paid { winner, run_id }) => {
                log!("bounty {} paid to {} for race {}", id, winner, run_id.0);
                bounty.status = Status::Paid { winner: winner.clone(), run_id };
                self.bounties.insert(id.clone(), bounty.clone());
                self.live = self.live.saturating_sub(1);
                self.transfer(&id, winner, bounty.amount);
                bounty.status
            }
            Ok(Status::Drained { winner, tx_hash }) => {
                log!(
                    "{} drained the safe in {}; the safe's code: {}",
                    winner,
                    tx_hash,
                    code.as_deref().unwrap_or("unknown")
                );
                let key = seal_key(&id, &winner);
                let taken = self.drains.get(&tx_hash).is_some_and(|other| *other != id);
                match self.seals.get(&key).cloned() {
                    Some(_) if taken => {
                        log!("the drain {} already counted for another bounty", tx_hash);
                        self.refuse_seal(&id, &winner);
                        Status::Open
                    }
                    Some(mut seal) => {
                        // From here this drain pays once: it counts for this bounty only.
                        self.drains.insert(tx_hash.clone(), id.clone());
                        seal.state = SealState::Confirmed;
                        seal.drain_tx = Some(tx_hash);
                        self.seals.insert(key, seal.clone());
                        match self.winner(&id) {
                            Ok(first) => self.pay_drain(&id, bounty, first),
                            Err(why) => {
                                log!("seal #{} of {} is confirmed and waits: {}", seal.seq, id, why);
                                Status::Open
                            }
                        }
                    }
                    None => {
                        log!("{} has no seal in {}: nothing to confirm", winner, id);
                        self.free_drain(&id, &tx_hash);
                        Status::Open
                    }
                }
            }
            Ok(_) => Status::Open,
            Err((why, false)) => {
                // The judge's run failed, or its answer could not be read: no verdict on the plan. Nothing is refused,
                // and a free claim is given back, so a mask whose key cannot attach NEAR may claim again.
                log!("bounty {} stays open, the judge gave no verdict: {}", id, why);
                if let Some(d) = &drain {
                    self.free_drain(&id, &d.tx_hash);
                }
                if let Some(c) = &released {
                    self.give_back_free_claim(c);
                }
                Status::Open
            }
            Err((why, true)) => {
                log!("bounty {} stays open: {}", id, why);
                match &drain {
                    Some(d) => {
                        self.free_drain(&id, &d.tx_hash);
                        self.refuse_seal(&id, &d.mask);
                        // The refused seal may have been all that held a later confirmed seal back.
                        match self.winner(&id) {
                            Ok(first) => self.pay_drain(&id, bounty, first),
                            Err(_) => Status::Open,
                        }
                    }
                    None => Status::Open,
                }
            }
        };
        self.account_storage(&id, before, false);
        Some(status)
    }

    /// A transfer to an account that does not exist comes back to the contract; then the bounty reopens instead of
    /// staying `Paid` with the NEAR stuck inside. A payout that went through ends the bounty: what is left of its
    /// storage reserve goes back to the team.
    #[private]
    pub fn on_paid(&mut self, id: String, #[callback_result] sent: Result<(), PromiseError>) -> Option<Status> {
        let mut bounty = self.bounties.get(&id).cloned()?;
        let paid = matches!(bounty.status, Status::Paid { .. } | Status::Drained { .. });
        if sent.is_err() && paid {
            if let Status::Drained { tx_hash, winner } = &bounty.status {
                self.drains.remove(tx_hash);
                // The winner's account cannot take the NEAR: its seal gives way, or settle would bounce again.
                let winner = winner.clone();
                self.refuse_seal(&id, &winner);
            }
            bounty.status = Status::Open;
            self.bounties.insert(id.clone(), bounty.clone());
            self.live += 1;
            log!("bounty {} payout bounced, open again", id);
        } else if paid {
            self.return_reserve(&id, &bounty.owner);
        }
        Some(bounty.status)
    }

    /// After the deadline and the claim grace an unbroken bounty goes back to the team, with what is left of its
    /// storage reserve. Not while a claim is with the judge. Anyone may trigger it; the NEAR only goes to the owner.
    pub fn refund(&mut self, id: String) -> Status {
        let mut bounty = self.get_open(&id);
        let now = env::block_timestamp();
        require!(now >= bounty.deadline_ns.0, "the race is still on");
        require!(now >= bounty.deadline_ns.0 + CLAIM_GRACE_HOURS * NS_PER_HOUR, "the masks can still claim");
        require!(self.terms_of(&id).judging == 0, "a claim is still with the judge");
        if let Some(race) = self.safes.get(&id).cloned() {
            require!(self.leader(&id, &race).is_none(), "a mask won this round: settle pays it");
        }
        bounty.status = Status::Refunded;
        self.bounties.insert(id.clone(), bounty.clone());
        self.live = self.live.saturating_sub(1);
        log!("bounty {} refunded to {}", id, bounty.owner);
        let _ = Promise::new(bounty.owner.clone()).transfer(NearToken::from_yoctonear(bounty.amount.0));
        self.return_reserve(&id, &bounty.owner);
        Status::Refunded
    }

    pub fn get(&self, id: String) -> Option<Bounty> {
        self.bounties.get(&id).cloned()
    }

    /// The judge, the storage reserve and, for a sealed round, the reveal window and the safe's code of a bounty.
    pub fn get_terms(&self, id: String) -> Option<Terms> {
        self.bounties.get(&id)?;
        Some(self.terms_of(&id))
    }

    /// A claim still with the judge: `unstick` drops it after `CLAIM_TIMEOUT_BLOCKS`.
    pub fn get_claim(&self, claim: U64) -> Option<Claim> {
        self.claims.get(&claim.0).cloned()
    }

    /// A sandbox race's opening time and the masks that may win it; `null` for a live race or one opened before.
    pub fn get_sandbox(&self, id: String) -> Option<SandboxRace> {
        sandboxes().get(&id).cloned()
    }

    /// The live safe, masks and drain rule of a bounty; `null` for a sandbox race.
    pub fn get_safe(&self, id: String) -> Option<SafeRace> {
        self.safes.get(&id).cloned()
    }

    /// A live race's sealed round: the windows, the deadline and every seal by arrival. A plan shows only once its
    /// mask revealed it.
    pub fn get_round(&self, id: String) -> Option<RoundView> {
        let round = self.rounds.get(&id)?;
        let race = self.safes.get(&id)?;
        let bounty = self.bounties.get(&id)?;
        let judging = race.masks.iter().filter(|m| self.seal_claims.contains_key(&seal_key(&id, m))).cloned().collect();
        Some(RoundView {
            commit_until: round.commit_until,
            reveal_until: U64(self.reveal_times(&id, bounty).0),
            deadline_ns: bounty.deadline_ns,
            seals: self.seals_of(&id, race),
            judging,
        })
    }

    /// Which bounty a drain transaction was claimed for, if any.
    pub fn drain_claimed(&self, tx_hash: String) -> Option<String> {
        self.drains.get(&tx_hash).cloned()
    }

    /// Who judges new bounties: OutLayer's contract, the project and the exact wasm. Each bounty keeps its own
    /// (`get_terms`).
    pub fn judge(&self) -> Value {
        json!({ "outlayer": self.outlayer, "project": self.judge_project, "version": self.judge_version })
    }
}

/// The parts no one calls from outside.
impl Bounties {
    fn lock(
        &mut self,
        id: String,
        target: String,
        hours: u64,
        judge_version: &str,
        reveal_until: Option<U64>,
        safe_code: Option<String>,
    ) {
        require!(id_ok(&id), "id: 8-64 letters, digits, - or _");
        require!(!target.trim().is_empty() && target.len() <= 300, "target: 1-300 characters");
        let amount = env::attached_deposit();
        require!(amount >= MIN_BOUNTY, "bounty: at least 0.1 NEAR");
        require!(!self.bounties.contains_key(&id), "this id is taken");
        require!(judge_version == self.judge_version, "the judge is not the one the team agreed to: see judge()");
        self.no_change_pending_for_bounties();
        if let Some(p) = self.pending_change() {
            log!("a change is pending and applies from {}: {:?}", p.notice_ns.0, p.change);
        }
        let bounty = Bounty {
            owner: env::predecessor_account_id(),
            amount: U128(amount.as_yoctonear()),
            target,
            deadline_ns: U64(env::block_timestamp() + hours * NS_PER_HOUR),
            status: Status::Open,
        };
        let terms =
            Terms { judge_version: self.judge_version.clone(), reserve: U128(0), judging: 0, reveal_until, safe_code };
        self.bounties.insert(id.clone(), bounty);
        self.terms.insert(id, terms);
        self.live += 1;
    }

    /// The bounty pays for what it stores now and sets aside `reserve` bytes for what it may store later, so neither
    /// eats the NEAR that pays winners or the contract's own balance. The rest of the deposit is the prize.
    fn charge_opening(&mut self, id: &str, before: u64, reserve: u64) -> Bounty {
        self.flush();
        let used = cost_of(env::storage_usage().saturating_sub(before));
        let reserve = cost_of(reserve);
        let mut bounty = self.bounties.get(id).cloned().unwrap_or_else(|| env::panic_str("no such bounty"));
        let prize = bounty.amount.0.checked_sub(used + reserve).unwrap_or(0);
        require!(prize >= MIN_BOUNTY.as_yoctonear(), "bounty: at least 0.1 NEAR beyond its storage");
        bounty.amount = U128(prize);
        self.bounties.insert(id.to_string(), bounty.clone());
        let mut terms = self.terms_of(id);
        terms.reserve = U128(reserve);
        self.terms.insert(id.to_string(), terms);
        log!(
            "bounty {} open: {} for {}, judged by {}",
            id,
            NearToken::from_yoctonear(bounty.amount.0).exact_amount_display(),
            bounty.target,
            self.judge_version
        );
        bounty
    }

    fn flush(&mut self) {
        self.bounties.flush();
        self.safes.flush();
        self.drains.flush();
        self.rounds.flush();
        self.seals.flush();
        self.terms.flush();
        self.claims.flush();
        self.seal_claims.flush();
    }

    /// Settles the storage a call on bounty `id` added or freed since `before`: growth comes out of the bounty's
    /// reserve, then out of its prize; what is freed goes back to the reserve. `strict` refuses the call when the
    /// bounty cannot pay. A callback is never strict: it must not fail, and the contract's own balance covers the
    /// rest.
    fn account_storage(&mut self, id: &str, before: u64, strict: bool) {
        self.flush();
        let after = env::storage_usage();
        let Some(mut terms) = self.terms.get(id).cloned() else {
            return self.charge_prize(id, cost_of(after.saturating_sub(before)), strict);
        };
        if after < before {
            terms.reserve = U128(terms.reserve.0 + cost_of(before - after));
        } else {
            let cost = cost_of(after - before);
            let from_reserve = cost.min(terms.reserve.0);
            terms.reserve = U128(terms.reserve.0 - from_reserve);
            self.charge_prize(id, cost - from_reserve, strict);
        }
        self.terms.insert(id.to_string(), terms);
    }

    fn charge_prize(&mut self, id: &str, cost: u128, strict: bool) {
        if cost == 0 {
            return;
        }
        let Some(mut bounty) = self.bounties.get(id).cloned() else { return };
        if bounty.amount.0 > cost {
            bounty.amount = U128(bounty.amount.0 - cost);
            self.bounties.insert(id.to_string(), bounty);
        } else if strict {
            env::panic_str("the bounty cannot pay for this storage");
        } else {
            log!("bounty {} could not pay {} yoctoNEAR of storage: the contract did", id, cost);
        }
    }

    /// The reserve a bounty did not use goes back to its team when the bounty ends.
    fn return_reserve(&mut self, id: &str, owner: &AccountId) {
        let Some(mut terms) = self.terms.get(id).cloned() else { return };
        if terms.reserve.0 > 0 {
            let _ = Promise::new(owner.clone()).transfer(NearToken::from_yoctonear(terms.reserve.0));
            log!("bounty {}: {} of unused storage back to {}", id, terms.reserve.0, owner);
            terms.reserve = U128(0);
            self.terms.insert(id.to_string(), terms);
        }
    }

    /// Terms of a bounty; one opened before bounties kept terms gets the old contract's judge and no reserve.
    fn terms_of(&self, id: &str) -> Terms {
        self.terms.get(id).cloned().unwrap_or_else(|| Terms {
            judge_version: self.legacy_judge.clone(),
            reserve: U128(0),
            judging: 0,
            reveal_until: None,
            safe_code: None,
        })
    }

    fn add_claim(&mut self, id: &str, c: Claim) -> u64 {
        let no = self.next_claim;
        self.next_claim += 1;
        self.claims.insert(no, c);
        let mut terms = self.terms_of(id);
        terms.judging += 1;
        self.terms.insert(id.to_string(), terms);
        no
    }

    fn release_claim(&mut self, no: u64, c: &Claim) {
        self.claims.remove(&no);
        if let Some(mut terms) = self.terms.get(&c.bounty).cloned() {
            terms.judging = terms.judging.saturating_sub(1);
            self.terms.insert(c.bounty.clone(), terms);
        }
        if let Some(d) = &c.drain {
            let key = seal_key(&c.bounty, &d.mask);
            if self.seal_claims.get(&key) == Some(&no) {
                self.seal_claims.remove(&key);
            }
        }
    }

    /// The bounty pays a mask's judge once; when that run failed without a verdict, the mask gets the free claim back.
    fn give_back_free_claim(&mut self, c: &Claim) {
        if let (true, Some(d)) = (c.free, &c.drain) {
            self.drains.remove(&format!("{}/{}", c.bounty, d.mask));
            log!("{} may claim {} again with nothing attached", d.mask, c.bounty);
        }
    }

    /// A drain that did not pay can be claimed again, unless the judge confirmed it for its seal. Claims made since
    /// per-claim records never lock a drain before it is confirmed; this frees what an older contract locked.
    fn free_drain(&mut self, id: &str, tx_hash: &str) {
        let confirmed = self
            .safes
            .get(id)
            .map(|r| self.seals_of(id, r))
            .unwrap_or_default()
            .iter()
            .any(|s| s.state == SealState::Confirmed && s.drain_tx.as_deref() == Some(tx_hash));
        if !confirmed && self.drains.get(tx_hash).map(String::as_str) == Some(id) {
            self.drains.remove(tx_hash);
        }
    }

    /// A claim can come until the claim grace after the deadline.
    fn claim_window(&self, bounty: &Bounty) {
        require!(env::block_timestamp() < bounty.deadline_ns.0 + CLAIM_GRACE_HOURS * NS_PER_HOUR, "the race is over");
        require!(env::prepaid_gas() >= MIN_CLAIM_GAS, "attach at least 180 TGas");
    }

    /// Until when an unrevealed seal holds a later winner back, and until when a mask may reveal. A round from before
    /// reveal windows keeps the old rule: until the deadline, and reveals until the end of the claim grace.
    fn reveal_times(&self, id: &str, bounty: &Bounty) -> (u64, u64) {
        match self.terms_of(id).reveal_until {
            Some(t) => (t.0, t.0),
            None => (bounty.deadline_ns.0, bounty.deadline_ns.0 + CLAIM_GRACE_HOURS * NS_PER_HOUR),
        }
    }

    fn refuse_seal(&mut self, id: &str, mask: &AccountId) {
        let key = seal_key(id, mask);
        if let Some(mut seal) = self.seals.get(&key).cloned() {
            if seal.state != SealState::Sealed {
                seal.state = SealState::Refused;
                self.seals.insert(key, seal);
            }
        }
    }

    /// Pays the confirmed `seal` the whole bounty: the race is drained.
    fn pay_drain(&mut self, id: &str, mut bounty: Bounty, seal: Seal) -> Status {
        let Some(tx_hash) = seal.drain_tx.clone() else {
            log!("seal #{} of {} has no drain to pay for", seal.seq, id);
            return bounty.status;
        };
        log!("bounty {} paid to {} for seal #{}, the drain {}", id, seal.mask, seal.seq, tx_hash);
        bounty.status = Status::Drained { winner: seal.mask.clone(), tx_hash };
        self.bounties.insert(id.to_string(), bounty.clone());
        self.live = self.live.saturating_sub(1);
        self.transfer(id, seal.mask, bounty.amount);
        bounty.status
    }

    fn transfer(&self, id: &str, to: AccountId, amount: U128) {
        let _ = Promise::new(to)
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_PAID_GAS).on_paid(id.to_string()));
    }

    fn live_race(&self, id: &str) -> SafeRace {
        self.safes.get(id).cloned().unwrap_or_else(|| env::panic_str("no such live race"))
    }

    fn round(&self, id: &str) -> Round {
        self.rounds.get(id).cloned().unwrap_or_else(|| env::panic_str("this live race has no sealed round"))
    }

    /// Every seal of the round, earliest first.
    fn seals_of(&self, id: &str, race: &SafeRace) -> Vec<Seal> {
        let mut seals: Vec<Seal> =
            race.masks.iter().filter_map(|m| self.seals.get(&seal_key(id, m)).cloned()).collect();
        seals.sort_by_key(|s| s.seq);
        seals
    }

    /// The earliest confirmed seal, if any.
    fn leader(&self, id: &str, race: &SafeRace) -> Option<Seal> {
        self.seals_of(id, race).into_iter().find(|s| s.state == SealState::Confirmed)
    }

    /// The seal that wins now, or why nobody does yet. An earlier seal holds the leader back only while it can still
    /// win: before the reveal window ends, or while its first claim is with the judge. A seal the judge refused never
    /// holds anyone back, and neither does one that missed the reveal window.
    fn winner(&self, id: &str) -> Result<Seal, String> {
        let race = self.safes.get(id).cloned().ok_or("no such live race")?;
        let bounty = self.bounties.get(id).cloned().ok_or("no such bounty")?;
        let seals = self.seals_of(id, &race);
        let lead = seals.iter().find(|s| s.state == SealState::Confirmed).ok_or("no confirmed seal yet")?;
        let (holds_until, _) = self.reveal_times(id, &bounty);
        let in_window = env::block_timestamp() < holds_until;
        let waiting = seals.iter().take_while(|s| s.seq < lead.seq).any(|s| {
            matches!(s.state, SealState::Sealed | SealState::Revealed)
                && (in_window || self.seal_claims.contains_key(&seal_key(id, &s.mask)))
        });
        if waiting {
            return Err("an earlier seal can still win".into());
        }
        Ok(lead.clone())
    }

    fn get_open(&self, id: &str) -> Bounty {
        let bounty = self.bounties.get(id).cloned().unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(bounty.status == Status::Open, "the bounty is not open");
        bounty
    }
}

/// The judge's answer as OutLayer hands it back: at most `MAX_REPLY_BYTES`, read without failing.
fn read_reply() -> Result<Option<String>, String> {
    if env::promise_results_count() != 1 {
        return Err("no answer from the judge".into());
    }
    match env::promise_result_checked(0, MAX_REPLY_BYTES) {
        Ok(data) => serde_json::from_slice(&data).map_err(|_| "the judge's answer is unreadable".to_string()),
        Err(PromiseError::TooLong(_)) => Err("the judge's answer is too long".into()),
        Err(_) => Err("the judge's run failed".into()),
    }
}

/// The judge's verdict, or why there is none. The flag says whether the judge itself answered `no`: a refusal of the
/// plan. Without it the run failed or its answer could not be read, which says nothing about the plan.
fn verdict_for(id: &str, reply: Result<Option<String>, String>) -> Result<Verdict, (String, bool)> {
    let no_verdict = |why: &str| (why.to_string(), false);
    let raw = reply.map_err(|e| (e, false))?.ok_or_else(|| no_verdict("the judge returned nothing"))?;
    let reply: JudgeReply = serde_json::from_str(&raw).map_err(|_| no_verdict("the judge's answer is unreadable"))?;
    if !reply.success {
        return Err((format!("no break: {}", reply.error.unwrap_or_default()), true));
    }
    let v = reply.output.ok_or(("the judge confirmed nothing".to_string(), true))?;
    if v.bounty_id != id {
        return Err(("the race was for another bounty".into(), true));
    }
    Ok(v)
}

/// What a confirmed verdict pays: the judge must answer the question this claim asked. A sandbox race pays only one
/// of the masks it was opened for.
fn paid_status(v: Verdict, drain: Option<&Drain>, masks: Option<&[AccountId]>) -> Result<Status, String> {
    match (drain, v.run_id, v.tx_hash) {
        (None, Some(_), _) if masks.is_some_and(|m| !m.contains(&v.winner)) => {
            Err(format!("{} is not a mask of this race", v.winner))
        }
        (None, Some(run_id), _) => Ok(Status::Paid { winner: v.winner, run_id }),
        (Some(d), _, Some(tx_hash)) if tx_hash == d.tx_hash && v.winner == d.mask => {
            Ok(Status::Drained { winner: v.winner, tx_hash })
        }
        (Some(_), _, _) => Err("the judge confirmed another drain".into()),
        (None, None, _) => Err("the judge confirmed no race".into()),
    }
}

/// The judge's question for a drain in a sealed round. Numbers go as decimal strings, as `U128` and `U64` do. A
/// drain counts only between the end of the commit window and the deadline, only if every transaction of the revealed
/// plan is the call the plan names, and only on the safe the round named, with the code it named and no keys, owned by
/// itself and open to exactly the round's masks when the round opened, and armed for this round by this contract.
/// `opened_ns` is the end of the commit window, as judges before `commit_until` read it.
fn drain_input(
    id: &str,
    race: &SafeRace,
    round: &Round,
    bounty: &Bounty,
    terms: &Terms,
    seal: &Seal,
    tx_hash: &str,
) -> Value {
    let plan = parse_plan(seal.plan.as_deref().unwrap_or_default()).unwrap_or_else(|e| env::panic_str(&e));
    json!({
        "kind": "drain",
        "contract": env::current_account_id(),
        "bounty_id": id,
        "safe": race.safe,
        "masks": race.masks,
        "mask": seal.mask,
        "tx_hash": tx_hash,
        "min_loot": race.min_loot,
        "opened_ns": round.commit_until,
        "commit_until": round.commit_until,
        "deadline_ns": bounty.deadline_ns,
        "plan": plan,
        "plan_txs": seal.txs,
        "opened_height": round.opened_height,
        "safe_code": terms.safe_code,
    })
}
