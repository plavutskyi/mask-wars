//! MASK WARS season treasury. Sponsors put NEAR in; every round of the season comes out of it, on schedule, with nobody
//! signing for the money.
//!
//! What a round is: a fresh safe on chain and a sealed round on the bounty contract (`contracts/bounty`, RULES.md).
//! `open_next` makes the safe `s<nnnn>.<this account>` from global code (published once on NEAR by its hash, so each
//! new safe costs only its account and the NEAR it holds), funds it, calls its `new(owner, masks, arbiter, team)` with
//! the safe as its own owner, the season's masks, the bounty contract as the one that arms it and this treasury as its
//! team, and opens the round on it with `open_safe`, the bounty paid from the treasury. The round counts only once the
//! safe is armed for it: a safe that does not take the round sends the bounty back here at once. The round then runs
//! as any other: the masks seal, play, reveal and claim; the judge confirms; the bounty contract pays the winner. A
//! round nobody won comes back here, to the treasury (`collect`): its bounty, and then the NEAR of its safe, which the
//! safe sends to its team once the bounty contract has refunded the round (`reclaim` in live-safe).
//!
//! Who does what:
//! - **the scheduler** (one account, `scheduler`) only calls `open_next`, with no arguments: it says "now", nothing
//!   else. Its key also reaches `collect`, which anyone may call and which only brings finished rounds home. The program decides the target, the masks, the bounty, the safe's NEAR, the windows and the judge; the
//!   schedule decides when a round is due; the limits cap what one round takes and how many open in a day. The
//!   scheduler's key is a function-call key for these two methods alone: it cannot attach NEAR, call anything else or
//!   move the treasury;
//! - **the admin** proposes changes; each waits in the open (`pending`) before anyone applies it (admin.rs). Nobody
//!   holds a key to this account: the admin cannot deploy code here or move the treasury by hand either;
//! - **sponsors** add NEAR with `fund` and get shares of the treasury for it. It leaves as a round, into a safe or into
//!   a bounty, or, while a change that waits long is pending, back to a sponsor who does not want it: `exit` pays the
//!   sponsor's share of what the treasury holds then.

// `new` and the bounty contract's `open_safe` take every term of a season and a round as its own argument.
#![allow(clippy::too_many_arguments)]

mod admin;
#[cfg(test)]
mod tests;

pub use admin::{Change, Pending, CHANGE_DELAY_HOURS, CHANGE_EXPIRY_HOURS, CHANGE_NOTICE_HOURS};

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json, Map, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

pub(crate) const NS_PER_MINUTE: u64 = 60_000_000_000;
pub(crate) const NS_PER_HOUR: u64 = 60 * NS_PER_MINUTE;
const NS_PER_DAY: u64 = 24 * NS_PER_HOUR;
const MINUTES_PER_DAY: u32 = 24 * 60;
/// The least a round's bounty leaves the winner: the bounty contract takes the round's storage and the masks' reserve
/// out of what it locks and wants this much left (`min_prize`).
pub const MIN_PRIZE: NearToken = NearToken::from_millinear(100);
/// What the bounty contract sets aside of a round's bounty, besides the round's own storage: its growth and the most
/// each mask may store (`BOUNTY_GROWTH_BYTES` and `MASK_STORAGE_BYTES` there).
pub const BOUNTY_GROWTH_BYTES: u64 = 240;
pub const MASK_STORAGE_BYTES: u64 = 4000;
/// The round's own storage on the bounty contract, at most: the bounty, its terms, the race with its masks and the
/// round. The season sandbox test checks it against what the bounty contract keeps.
pub const ROUND_BYTES: u64 = 1500;
pub const ROUND_BYTES_PER_MASK: u64 = 100;
/// The least a drain must take out of the safe: the bounty contract's own floor.
pub const MIN_LOOT: NearToken = NearToken::from_millinear(100);
/// The least a sponsor adds at a time.
pub const MIN_FUND: NearToken = NearToken::from_millinear(10);
/// A round runs 24 hours at most: the bounty contract's limit for a sealed round.
pub const MAX_ROUND_HOURS: u64 = 24;
pub const MAX_MASKS: usize = 16;
pub const MAX_TARGETS: usize = 16;
/// The most rounds a day the limits may ever allow.
pub const MAX_PER_DAY: u32 = 48;
/// A target's own arguments for `new`, besides the owner and the masks.
pub const MAX_INIT_BYTES: usize = 1024;
/// The treasury keeps this much beyond its storage, for the storage its rounds and sponsors add.
pub const KEEP: NearToken = NearToken::from_millinear(100);
/// A round on its way that never came back (a callback out of gas) stops holding the next one after this many blocks.
pub const OPENING_TIMEOUT_BLOCKS: u64 = 300;
/// `open_next` needs gas for the whole chain: the bounty contract's state, the safe, `open_safe` with the safe's `arm`
/// and its answer, the check that the safe took the round, and the callbacks.
pub const OPEN_GAS: Gas = Gas::from_tgas(250);
const VIEW_GAS: Gas = Gas::from_tgas(10);
const INIT_GAS: Gas = Gas::from_tgas(30);
/// `open_safe` itself, the safe's `arm` (10 TGas there) and the bounty contract's `on_armed` (15 TGas), with room.
const OPEN_SAFE_GAS: Gas = Gas::from_tgas(70);
const ON_OPENED_GAS: Gas = Gas::from_tgas(75);
const ON_ARMED_GAS: Gas = Gas::from_tgas(45);
const ON_ROUND_STATE_GAS: Gas = Gas::from_tgas(25);
const ON_SAFE_GAS: Gas = Gas::from_tgas(170);
const ON_STATE_GAS: Gas = Gas::from_tgas(225);
/// The bounty contract lets masks claim for 12 hours after the deadline; a round is collected an hour after that.
pub const COLLECT_AFTER_HOURS: u64 = 13;
/// Rounds one `collect` call settles or refunds.
pub const COLLECT_AT_ONCE: u32 = 2;
const SETTLE_GAS: Gas = Gas::from_tgas(40);
const REFUND_GAS: Gas = Gas::from_tgas(20);
/// The safe's `reclaim`: itself, its question to the bounty contract (10 TGas) and its answer with the transfer (10).
/// The sandbox burns about 6 TGas for the whole of it.
const RECLAIM_GAS: Gas = Gas::from_tgas(30);
const ON_RECLAIMED_GAS: Gas = Gas::from_tgas(10);
/// `on_collected` itself and, for a round nobody won, the safe's `reclaim` and `on_reclaimed` it asks for.
const ON_COLLECTED_GAS: Gas = Gas::from_tgas(50);
/// What the first round of a `collect` call needs left: `settle`, `refund`, the round's state and `on_collected`, and
/// the fees of sending them. Each next round needs what the one before it took, so a call never runs out of gas
/// half-way. On NEAR a round takes about 126 TGas: 300 TGas carry two rounds home.
const COLLECT_ROUND_GAS: Gas = Gas::from_tgas(130);
/// What a collected round ends as on the bounty contract: paid to a winner, or its bounty back here.
const SETTLED: [&str; 3] = ["paid", "drained", "refunded"];
/// Rounds one `collect` call looks at from where it starts, due or not: a round with a later deadline does not hold
/// up an earlier-ending one behind it.
const COLLECT_SCAN: u32 = 16;
/// A mask's turn on a live safe, minutes: the bounty contract wants a reveal window of one turn per mask and one more.
pub const SAFE_TURN_MINUTES: u64 = 3;
/// The shortest commit window a program may set: time for the masks to race the target in the sandbox and seal.
pub const MIN_COMMIT_MINUTES: u64 = 30;
/// All shares together stay below this: when a fund would pass it, every share is halved as often as needed
/// (`shift`), which keeps every sponsor's part as it was.
const SHARE_LIMIT: u128 = 1 << 120;
/// What the season logs: `EVENT_JSON:{"standard":"maskwars_season",…}`.
const STANDARD: &str = "maskwars_season";

#[ext_contract(ext_bounty)]
#[allow(dead_code)]
trait BountyContract {
    fn governance(&self) -> Value;
    fn get(&self, id: String) -> Option<Value>;
    #[allow(clippy::too_many_arguments)]
    fn settle(&mut self, id: String);
    fn refund(&mut self, id: String);
    fn open_safe(
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
    ) -> Value;
}

/// The round's safe, as the season makes it (contracts/challenges/live-safe).
#[ext_contract(ext_safe)]
#[allow(dead_code)]
trait RoundSafe {
    fn get_round(&self) -> Option<Value>;
    fn reclaim(&mut self);
}

/// What one round may take, and how often rounds may open. Raising a limit waits `CHANGE_DELAY_HOURS`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    /// The most one round's bounty may lock, yoctoNEAR.
    pub max_prize: U128,
    /// The most one round may put into its safe, yoctoNEAR.
    pub max_safe_fund: U128,
    /// Rounds that may open in any 24 hours.
    pub max_per_day: u32,
}

/// A safe the season races on: code from the library (`contracts/challenges`), named by its hash.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    /// The library id the masks race on in the sandbox first: `live-safe` (a safe with the lock: `arm`, `queue`, slots).
    pub challenge: String,
    /// The safe's code hash as NEAR shows it, base58: published on chain as a global contract, one of `safe_codes`.
    pub code_hash: String,
    /// The rest of the safe's `new` arguments, a JSON object of numbers, flags and amounts only. Every account the safe
    /// is made with comes from the season: `owner` (the safe itself), `masks` (the round's), `arbiter` (the bounty
    /// contract) and `team` (this treasury). A program cannot name any other account here.
    pub init: String,
    /// NEAR the safe gets when it is made, its own storage included, yoctoNEAR.
    pub safe_fund: U128,
    /// What a drain must take out of the safe to count, yoctoNEAR.
    pub min_loot: U128,
}

/// Every round of the season, decided in advance: the scheduler only says when.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Program {
    /// The masks of every round: only these can win.
    pub masks: Vec<AccountId>,
    /// The targets, in turn.
    pub targets: Vec<Target>,
    /// NEAR each round's bounty locks, yoctoNEAR. The bounty contract keeps the round's storage out of it; the rest
    /// is the prize.
    pub prize: U128,
    pub hours: u64,
    pub commit_minutes: u64,
    pub reveal_minutes: u64,
    /// The judge the season agrees to: the bounty contract's judge must be this one, or no round opens.
    pub judge_version: String,
    /// The schedule: a round is due at every `every_minutes` from `first_minute` minutes after midnight UTC, 1 January
    /// 1970. `first_minute` 1080 and `every_minutes` 1440 is every day at 18:00 UTC.
    pub first_minute: u32,
    pub every_minutes: u32,
}

/// A round the season opened.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SeasonRound {
    /// The bounty's id on the bounty contract.
    pub id: String,
    /// The safe's number: the safe is `s<nnnn>.<season>`.
    pub n: u32,
    pub safe: AccountId,
    pub challenge: String,
    pub code_hash: String,
    /// What the bounty locked, and what went into the safe.
    pub prize: U128,
    pub safe_fund: U128,
    pub min_loot: U128,
    pub masks: Vec<AccountId>,
    /// The slot it opened for, and when it opened.
    pub slot_ns: U64,
    pub opened_ns: U64,
    /// End of the commit window and the deadline.
    pub commit_until_ns: U64,
    pub deadline_ns: U64,
    /// The bounty contract the round opened on: `collect` brings it home from there, whatever the season's is by then.
    pub bounty: AccountId,
    /// How the round ended there, once `collect` saw it: `paid`, `drained` or `refunded`. `null` until then.
    pub outcome: Option<String>,
    /// Whether the safe's NEAR came home: `true` once the safe of a round nobody won sent it to the treasury,
    /// `false` when a mask won the round or the safe did not send it. `null` until then.
    pub reclaimed: Option<bool>,
}

/// A safe made for a round that did not open. The next round takes it as it is, if it still fits the program.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Spare {
    pub n: u32,
    pub safe: AccountId,
    pub target: Target,
    pub masks: Vec<AccountId>,
    /// The bounty contract the safe names as its arbiter: only a round there arms it.
    pub bounty: AccountId,
}

/// What a round was opened with: what the callback records, whatever the program says by then.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RoundTerms {
    pub prize: U128,
    pub hours: u64,
    pub commit_minutes: u64,
}

/// A round on its way, from `open_next` to its last callback.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Opening {
    pub attempt: u32,
    pub height: U64,
    pub slot_ns: U64,
    /// Where the target sits in the program.
    pub turn: u32,
}

/// The next round as the home page shows it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct NextRound {
    /// The slot: due now if it is in the past.
    pub at_ns: U64,
    pub n: u32,
    pub challenge: String,
    pub code_hash: String,
    pub prize: U128,
    pub safe_fund: U128,
    pub min_loot: U128,
    pub masks: Vec<AccountId>,
    pub hours: u64,
    pub commit_minutes: u64,
    pub reveal_minutes: u64,
    /// The treasury can pay for it now.
    pub funded: bool,
    /// NEAR the treasury can spend on rounds now.
    pub treasury: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SeasonView {
    pub name: String,
    pub admin: AccountId,
    pub scheduler: AccountId,
    pub bounty: AccountId,
    pub limits: Limits,
    pub safe_codes: Vec<String>,
    pub program: Program,
    pub pending: Option<Pending>,
    /// Rounds opened, and safes made.
    pub rounds: u32,
    pub safes: u32,
    /// Everything sponsors put in, and how many sponsors.
    pub funded: U128,
    pub sponsors: u32,
    /// What sponsors took back with `exit`, and the treasury's shares they hold.
    pub exited: U128,
    pub shares: U128,
    /// What rounds not brought home yet still hold, and may send back: their bounties and their safes' NEAR. Shares
    /// are priced with it, and with the NEAR of the spare safe.
    pub outstanding: U128,
    /// NEAR rounds took out: safe funds and bounties. A round nobody won sends its bounty and its safe's NEAR back as
    /// plain transfers.
    pub spent: U128,
    /// NEAR the treasury can spend on rounds now.
    pub treasury: U128,
    pub spare: Option<Spare>,
    pub opening: Option<Opening>,
    pub delay_hours: u64,
    pub notice_hours: u64,
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Rounds,
    Sponsors,
    Shares,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Season {
    /// Round ids start with it: `<name>-<nnnn>-<6 hex>`.
    name: String,
    /// Who may propose changes (admin.rs). It holds no key to this account.
    admin: AccountId,
    /// The one account that may call `open_next`.
    scheduler: AccountId,
    /// The bounty contract the rounds open on.
    bounty: AccountId,
    limits: Limits,
    /// Code hashes of the safes a round may be made from (base58).
    safe_codes: Vec<String>,
    program: Program,
    pending: Option<Pending>,
    /// Safes made so far: the next is `s<made + 1>`.
    made: u32,
    /// The target the next round runs, an index into the program's targets.
    turn: u32,
    opening: Option<Opening>,
    attempts: u32,
    spare: Option<Spare>,
    /// The slot the last round opened for: one round per slot.
    last_slot_ns: u64,
    /// When rounds opened in the last 24 hours.
    recent: Vec<u64>,
    rounds: Vector<SeasonRound>,
    sponsors: LookupMap<AccountId, u128>,
    sponsor_count: u32,
    funded: u128,
    spent: u128,
    /// Rounds before this one were collected: settled or refunded on the bounty contract.
    collected: u32,
    /// Each sponsor's shares of the treasury, with the era and the shift they were last written at, and all shares
    /// now. A share is a part of everything the treasury has: what it can spend and the bounties still out. A treasury
    /// that rounds emptied, with nothing out, starts a new era: old shares are worth nothing. When the shares would
    /// grow too many, every share is halved (`shift`), lazily for each sponsor.
    shares: LookupMap<AccountId, Held>,
    total_shares: u128,
    era: u32,
    shift: u32,
    exited: u128,
    /// What recorded rounds still hold until `collect` brings them home: the bounty, until the bounty contract says
    /// how the round ended, and the safe's NEAR, until a mask won it or the safe sent it back.
    outstanding: u128,
    /// The deposits of `publish_code` calls on their way: the treasury's balance holds them until `on_published`
    /// sends the change back, and they are not the treasury's. `publishing_height` is the block of the latest.
    publishing: u128,
    publishing_height: u64,
}

/// One sponsor's shares as stored: `shares` at `shift`, in `era`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Held {
    pub era: u32,
    pub shift: u32,
    pub shares: u128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Event<'a, T: Serialize> {
    standard: &'a str,
    version: &'a str,
    event: &'a str,
    data: T,
}

pub(crate) fn event<T: Serialize>(name: &str, data: T) {
    let e = Event { standard: STANDARD, version: "1.0.0", event: name, data };
    env::log_str(&format!("EVENT_JSON:{}", serde_json::to_string(&e).unwrap_or_default()));
}

/// A code hash as NEAR shows it: base58 of 32 bytes.
pub(crate) fn b58_32(h: &str) -> Option<[u8; 32]> {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    if !(32..=44).contains(&h.len()) {
        return None;
    }
    let mut out = [0u8; 32];
    for c in h.bytes() {
        let mut carry = B58.iter().position(|b| *b == c)? as u32;
        for byte in out.iter_mut().rev() {
            carry += u32::from(*byte) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(out)
}

/// 32 bytes in base58, as NEAR shows a code hash.
pub(crate) fn b58(bytes: &[u8; 32]) -> String {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = vec![];
    for byte in bytes {
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
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    std::iter::repeat_n(b'1', zeros).chain(digits.iter().rev().map(|d| B58[*d as usize])).map(char::from).collect()
}

pub(crate) fn b58_32_ok(h: &str) -> bool {
    b58_32(h).is_some()
}

/// The wasm's sha256 in hex: what a code change proposes, and OutLayer's version key for the judge.
pub(crate) fn hex64_ok(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn name_ok(name: &str) -> bool {
    (1..=12).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn challenge_ok(c: &str) -> bool {
    (1..=40).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A slot is due at every `every` minutes from `first` minutes after the epoch: the latest one at or before `now`.
fn latest_slot(p: &Program, now: u64) -> Option<u64> {
    let minute = now / NS_PER_MINUTE;
    let (first, every) = (u64::from(p.first_minute), u64::from(p.every_minutes.max(1)));
    (minute >= first).then(|| (first + (minute - first) / every * every) * NS_PER_MINUTE)
}

fn next_slot(p: &Program, now: u64) -> u64 {
    let every = u64::from(p.every_minutes.max(1)) * NS_PER_MINUTE;
    match latest_slot(p, now) {
        Some(s) => s + every,
        None => u64::from(p.first_minute) * NS_PER_MINUTE,
    }
}

#[near]
impl Season {
    /// A fresh treasury. `name` starts every round id; `admin` proposes changes and holds no key to this account;
    /// `scheduler` is the one account that may open the next round; rounds open on `bounty`.
    #[init]
    pub fn new(
        name: String,
        admin: AccountId,
        scheduler: AccountId,
        bounty: AccountId,
        limits: Limits,
        safe_codes: Vec<String>,
        program: Program,
    ) -> Self {
        require!(name_ok(&name), "name: 1-12 lowercase letters or digits");
        require!(safe_codes.iter().all(|c| b58_32_ok(c)), "safe code: a code hash in base58");
        let me = Self {
            name,
            admin,
            scheduler,
            bounty,
            limits,
            safe_codes,
            program,
            pending: None,
            made: 0,
            turn: 0,
            opening: None,
            attempts: 0,
            spare: None,
            last_slot_ns: 0,
            recent: vec![],
            rounds: Vector::new(Key::Rounds),
            sponsors: LookupMap::new(Key::Sponsors),
            sponsor_count: 0,
            funded: 0,
            spent: 0,
            collected: 0,
            shares: LookupMap::new(Key::Shares),
            total_shares: 0,
            era: 0,
            shift: 0,
            exited: 0,
            outstanding: 0,
            publishing: 0,
            publishing_height: 0,
        };
        me.check_limits(&me.limits);
        me.check_program(&me.program).unwrap_or_else(|e| env::panic_str(&e));
        me
    }

    /// Runs right after new code (`upgrade`): keeps the state as it is.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("no state to migrate"))
    }

    /// A sponsor adds the attached NEAR to the treasury and gets shares of it for that: as many as keep every other
    /// sponsor's part as it was. The part is of everything the treasury has, what rounds still hold included (their
    /// bounties and their safes' NEAR, and the spare safe's), so a sponsor who comes just before a round comes home
    /// buys what it brings at its price and takes nobody's part. It leaves as a round, into a safe or a bounty, or with
    /// `exit`. Not while a round is on its way or a safe code is being published: mid-way, the treasury's balance is
    /// not what it has.
    #[payable]
    pub fn fund(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount >= MIN_FUND.as_yoctonear(), "fund with at least 0.01 NEAR");
        // Mid-way, what the treasury holds is not what it has: a share would sell too cheap.
        self.require_settled("fund once it is open");
        let by = env::predecessor_account_id();
        let minted = self.mint(amount);
        require!(minted > 0, "this deposit buys no share of the treasury: fund more");
        let total = self.sponsors.get(&by).copied().unwrap_or(0) + amount;
        if !self.sponsors.contains_key(&by) {
            self.sponsor_count += 1;
        }
        self.sponsors.insert(by.clone(), total);
        let held = self.held(&by) + minted;
        self.shares.insert(by.clone(), Held { era: self.era, shift: self.shift, shares: held });
        self.total_shares += minted;
        self.funded += amount;
        event("fund", json!({ "by": by, "amount": U128(amount), "total": U128(total), "shares": U128(held) }));
        U128(total)
    }

    /// A sponsor leaves while a change that waits long is pending (new masks, targets, prize, judge or safe code, a
    /// new admin, bounty contract or code, higher limits): it gets its share of what the treasury can spend now, and
    /// all its shares are gone. Its part of what rounds still hold, their bounties and their safes' NEAR, stays with the
    /// sponsors who remain, so an exit never pays out anything that is not here, whatever those rounds bring back. Not
    /// while a round is on its way, the treasury has already promised its NEAR; nor while a safe code is being
    /// published, its deposit is in the treasury's balance but not the treasury's.
    pub fn exit(&mut self) -> U128 {
        let p = self
            .pending_change()
            .cloned()
            .unwrap_or_else(|| env::panic_str("no change is pending: a sponsor exits only while one waits"));
        require!(p.long, "only a change that waits long lets sponsors exit");
        require!(env::block_timestamp() < p.ready_ns.0, "the change is ready: exit before it may apply");
        self.require_settled("exit once it is open");
        let by = env::predecessor_account_id();
        let held = self.held(&by);
        require!(held > 0, "this account holds no shares of the treasury");
        let amount = mul_div(self.treasury(), held, self.total_shares);
        self.shares.remove(&by);
        self.total_shares -= held;
        self.exited += amount;
        event("exit", json!({ "by": by, "amount": U128(amount), "shares": U128(held) }));
        if amount > 0 {
            let _ = Promise::new(by).transfer(NearToken::from_yoctonear(amount));
        }
        U128(amount)
    }

    /// Opens the round that is due: makes its safe from global code, funds it, and opens a sealed round on it on the
    /// bounty contract, the bounty paid from the treasury. Only the scheduler, at most once per slot of the schedule
    /// and `max_per_day` times in any 24 hours. Everything else comes from the program.
    ///
    /// The rest happens in callbacks: the bounty contract's state is read first, and no safe is made if the round
    /// could not open on it (another judge, a safe code it does not know, new code pending there). A safe that was
    /// made for a round that then did not open waits for the next one (`spare`).
    pub fn open_next(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.scheduler, "only the scheduler opens rounds");
        require!(env::prepaid_gas() >= OPEN_GAS, "attach 250 TGas or more");
        let now = env::block_timestamp();
        let height = env::block_height();
        if let Some(o) = &self.opening {
            require!(height >= o.height.0 + OPENING_TIMEOUT_BLOCKS, "a round is already on its way");
            log!("round attempt {} never came back: it no longer holds the next one", o.attempt);
        }
        let slot = self.due_slot(now).unwrap_or_else(|| {
            env::panic_str(&format!("no round is due: the next one is at {} ns", next_slot(&self.program, now)))
        });
        self.prune(now);
        require!((self.recent.len() as u32) < self.limits.max_per_day, "the limit of rounds for 24 hours is reached");
        let (turn, target) = self.next_target().unwrap_or_else(|e| env::panic_str(&e));
        // Limits lowered under a program already in force hold at once: the program waits for a fix.
        require!(
            self.program.prize.0 <= self.limits.max_prize.0 && target.safe_fund.0 <= self.limits.max_safe_fund.0,
            "the program is over the limits: it needs a change before the next round"
        );
        let need = self.cost_of(&target);
        let free = self.treasury();
        require!(
            free >= need,
            &format!("the treasury holds {} yoctoNEAR for rounds, the next one needs {}", free, need)
        );
        self.attempts += 1;
        let attempt = self.attempts;
        self.opening = Some(Opening { attempt, height: U64(height), slot_ns: U64(slot), turn });
        ext_bounty::ext(self.bounty.clone())
            .with_static_gas(VIEW_GAS)
            .governance()
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_STATE_GAS).on_bounty_state(attempt))
    }

    /// The bounty contract's state is in: if a round can open there, makes the safe (or takes the spare one) and opens
    /// the round.
    #[private]
    pub fn on_bounty_state(
        &mut self,
        attempt: u32,
        #[callback_result] state: Result<Value, PromiseError>,
    ) -> PromiseOrValue<Option<SeasonRound>> {
        let Some(o) = self.opening.clone().filter(|o| o.attempt == attempt) else {
            log!("round attempt {} was dropped", attempt);
            return PromiseOrValue::Value(None);
        };
        let Some(target) = self.program.targets.get(o.turn as usize).cloned() else {
            return self.give_up(attempt, "the program changed under the round");
        };
        let state = match state {
            Ok(s) => s,
            Err(_) => return self.give_up(attempt, "the bounty contract did not answer"),
        };
        if let Err(why) = self.bounty_takes(&state, &target) {
            return self.give_up(attempt, &why);
        }
        if let Some(spare) = self.spare.clone() {
            if self.spare_fits(&spare, &target) {
                log!("round attempt {} takes the spare safe {}", attempt, spare.safe);
                return PromiseOrValue::Promise(self.open_round(attempt, spare));
            }
            log!("the spare safe {} no longer fits the program: it keeps its NEAR and waits for nothing", spare.safe);
            event("orphan", json!({ "n": spare.n, "safe": spare.safe, "why": "it no longer fits the program" }));
            self.spare = None;
        }
        let Some(code) = b58_32(&target.code_hash) else {
            return self.give_up(attempt, "the target's code hash is not base58");
        };
        // The number is taken now, before the safe is made: no later attempt ever names the same account.
        self.made += 1;
        let n = self.made;
        let safe = self.safe_account(n);
        let args = self.safe_init(&target, &safe);
        PromiseOrValue::Promise(
            Promise::new(safe.clone())
                .create_account()
                .transfer(NearToken::from_yoctonear(target.safe_fund.0))
                .use_global_contract(code)
                .function_call("new", args, NearToken::from_yoctonear(0), INIT_GAS)
                .then(Self::ext(env::current_account_id()).with_static_gas(ON_SAFE_GAS).on_safe(
                    attempt,
                    n,
                    target,
                    self.program.masks.clone(),
                    self.bounty.clone(),
                )),
        )
    }

    /// The safe is made (or not). A safe that came out waits as the spare and goes into the round right away; one
    /// that did not leaves its NEAR in the treasury: a failed batch takes nothing.
    #[private]
    pub fn on_safe(
        &mut self,
        attempt: u32,
        n: u32,
        target: Target,
        masks: Vec<AccountId>,
        bounty: AccountId,
        #[callback_result] made: Result<(), PromiseError>,
    ) -> PromiseOrValue<Option<SeasonRound>> {
        let safe = self.safe_account(n);
        if made.is_err() {
            self.skip(attempt, &format!("the safe {} was not made; its NEAR stays in the treasury", safe));
            return PromiseOrValue::Value(None);
        }
        self.spent += target.safe_fund.0;
        event(
            "safe",
            json!({ "n": n, "safe": safe, "challenge": target.challenge, "code_hash": target.code_hash,
                    "safe_fund": target.safe_fund }),
        );
        let spare = Spare { n, safe, target, masks, bounty };
        self.park(&spare);
        if self.opening.as_ref().is_none_or(|o| o.attempt != attempt) {
            log!("round attempt {} was dropped: its safe waits for the next round", attempt);
            return PromiseOrValue::Value(None);
        }
        PromiseOrValue::Promise(self.open_round(attempt, spare))
    }

    /// `open_safe` answered. Not open: its NEAR came back with the failed call, and the safe stays the spare. Open:
    /// the round counts only once the safe is armed for it, so the season asks the safe (`get_round`). `open_safe`
    /// asks the safe to arm in the same block; if the safe has not heard it yet, `on_armed` asks the bounty contract.
    #[private]
    pub fn on_opened(
        &mut self,
        attempt: u32,
        id: String,
        spare: Spare,
        terms: RoundTerms,
        #[callback_result] opened: Result<Value, PromiseError>,
    ) -> PromiseOrValue<Option<SeasonRound>> {
        let bounty = match opened {
            Ok(b) => b,
            Err(_) => {
                log!("round {} did not open on {}: its bounty came back", id, spare.bounty);
                self.skip_round(attempt, &id, "the bounty contract refused the round");
                return PromiseOrValue::Value(None);
            }
        };
        let deadline = bounty.get("deadline_ns").and_then(Value::as_str).and_then(|d| d.parse::<u64>().ok());
        PromiseOrValue::Promise(ext_safe::ext(spare.safe.clone()).with_static_gas(VIEW_GAS).get_round().then(
            Self::ext(env::current_account_id()).with_static_gas(ON_ARMED_GAS).on_armed(
                attempt,
                id,
                spare,
                terms,
                deadline.map(U64),
            ),
        ))
    }

    /// The safe's round is in. Armed by the bounty contract the round opened on, for this very round: the round is the
    /// season's, recorded here. Armed for nothing yet: either the safe refused and the bounty contract has sent the
    /// bounty back (its `on_armed`), or the safe has not heard `arm` yet (NEAR does not promise which receipt runs
    /// first), so the season asks the bounty contract (`on_round_state`). Armed for anything else, or unable to say:
    /// the round does not count and the safe is dropped; a code whose safe cannot say at all is taken off the list.
    #[private]
    pub fn on_armed(
        &mut self,
        attempt: u32,
        id: String,
        spare: Spare,
        terms: RoundTerms,
        deadline: Option<U64>,
        #[callback_result] armed: Result<Option<Value>, PromiseError>,
    ) -> PromiseOrValue<Option<SeasonRound>> {
        let ours = |r: &Value| {
            r.get("bounty").and_then(Value::as_str) == Some(id.as_str())
                && r.get("arbiter").and_then(Value::as_str) == Some(spare.bounty.as_str())
        };
        match &armed {
            Ok(Some(r)) if ours(r) => PromiseOrValue::Value(Some(self.record(attempt, id, spare, terms, deadline))),
            Ok(None) => PromiseOrValue::Promise(
                ext_bounty::ext(spare.bounty.clone()).with_static_gas(VIEW_GAS).get(id.clone()).then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(ON_ROUND_STATE_GAS)
                        .on_round_state(attempt, id, spare, terms, deadline),
                ),
            ),
            _ => {
                if self.spare.as_ref() == Some(&spare) {
                    self.spare = None;
                }
                event("orphan", json!({ "n": spare.n, "safe": spare.safe, "why": "it takes no round of the season" }));
                // A safe that cannot even say which round it is armed for has no lock at all (a safe of the library
                // without `arm`): no round on its code can ever count, so no more safes are made from it.
                if armed.is_err() {
                    let code = spare.target.code_hash.clone();
                    self.safe_codes.retain(|c| *c != code);
                    log!("{} takes no round: rounds are no longer made from it", code);
                    event("drop_safe_code", json!({ "code_hash": code, "why": "its safes take no round" }));
                }
                self.skip_round(attempt, &id, "the safe is not armed for the round: its bounty comes back");
                PromiseOrValue::Value(None)
            }
        }
    }

    /// The bounty contract's word on a round whose safe was not armed yet. Still open there: `arm` is on its way, the
    /// round is the season's and is recorded (if the safe refuses after all, the bounty comes back and `collect` sees
    /// it refunded). Refunded, or gone: the safe did not arm, the round does not count, and a free safe stays the spare.
    #[private]
    pub fn on_round_state(
        &mut self,
        attempt: u32,
        id: String,
        spare: Spare,
        terms: RoundTerms,
        deadline: Option<U64>,
        #[callback_result] bounty: Result<Option<Value>, PromiseError>,
    ) -> Option<SeasonRound> {
        let state =
            bounty.ok().flatten().and_then(|b| b.pointer("/status/state").and_then(Value::as_str).map(str::to_string));
        if matches!(state.as_deref(), Some("open") | Some("judging")) {
            return Some(self.record(attempt, id, spare, terms, deadline));
        }
        self.skip_round(attempt, &id, "the safe did not arm for the round: its bounty came back");
        None
    }

    /// Brings finished rounds home: for each round whose claims are over (`COLLECT_AFTER_HOURS` after its deadline), asks
    /// the bounty contract it opened on to `settle` it, which pays a confirmed winner nobody paid yet, and then to
    /// `refund` it, which sends a bounty nobody won back here. Whichever does not apply fails on its own and changes
    /// nothing. Then it reads the round there (`on_collected`): only a round that ended (paid, drained or refunded) is
    /// done, and the cursor moves past it; any other is asked again next time. Up to `COLLECT_AT_ONCE` rounds a call,
    /// oldest first, looking at up to `COLLECT_SCAN` rounds from the cursor, or from `from_index` past it, so a round
    /// that never ends holds up none behind it; and only as many as the attached gas carries home whole, the safe of
    /// a round nobody won included (`COLLECT_ROUND_GAS`). Anyone may call it: the NEAR only goes to a winner or to the
    /// treasury. Returns how many rounds it asked about.
    pub fn collect(&mut self, from_index: Option<u32>) -> u32 {
        let now = env::block_timestamp();
        let mut asked = 0;
        let start = from_index.unwrap_or(0).max(self.collected);
        let mut i = start;
        let end = self.rounds.len().min(start.saturating_add(COLLECT_SCAN));
        let mut need = COLLECT_ROUND_GAS;
        while asked < COLLECT_AT_ONCE && i < end {
            let Some(r) = self.rounds.get(i).cloned() else { break };
            i += 1;
            // Not over yet, or brought home already: a round with a later deadline holds up none behind it.
            if r.outcome.is_some() || now < r.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR {
                continue;
            }
            // A round goes out with all the gas its way home may take, its safe's included, or it waits for the
            // next call.
            if env::prepaid_gas().saturating_sub(env::used_gas()) < need {
                break;
            }
            let before = env::used_gas();
            let _ = ext_bounty::ext(r.bounty.clone())
                .with_static_gas(SETTLE_GAS)
                .settle(r.id.clone())
                .then(ext_bounty::ext(r.bounty.clone()).with_static_gas(REFUND_GAS).refund(r.id.clone()))
                .then(ext_bounty::ext(r.bounty.clone()).with_static_gas(VIEW_GAS).get(r.id.clone()))
                .then(Self::ext(env::current_account_id()).with_static_gas(ON_COLLECTED_GAS).on_collected(i - 1));
            event("collect", json!({ "id": r.id, "n": r.n, "bounty": r.bounty }));
            asked += 1;
            need = env::used_gas().saturating_sub(before).saturating_add(Gas::from_tgas(5));
        }
        asked
    }

    /// The round as the bounty contract shows it after `settle` and `refund`. Ended: recorded, and the cursor moves
    /// past every round that ended. Still open (a claim with the judge, a payout on its way, an answer that did not
    /// come): nothing changes, and the next `collect` asks again. A round a mask won leaves its safe's NEAR with the
    /// winner. A round nobody won, its bounty back here, asks its safe for the NEAR in it (`reclaim`): it stays
    /// counted as out until the safe answers (`on_reclaimed`).
    #[private]
    pub fn on_collected(
        &mut self,
        index: u32,
        #[callback_result] round: Result<Option<Value>, PromiseError>,
    ) -> Option<String> {
        let state =
            round.ok().flatten().and_then(|b| b.pointer("/status/state").and_then(Value::as_str).map(str::to_string));
        let mut r = self.rounds.get(index).cloned()?;
        // Two collects in a row both come back here: a round is brought home once.
        if r.outcome.is_some() {
            return r.outcome;
        }
        let Some(state) = state.filter(|s| SETTLED.contains(&s.as_str())) else {
            log!("round {} is not over on {} yet: collect asks again", r.id, r.bounty);
            return None;
        };
        r.outcome = Some(state.clone());
        self.outstanding = self.outstanding.saturating_sub(r.prize.0);
        if state == "refunded" {
            let _ = ext_safe::ext(r.safe.clone())
                .with_static_gas(RECLAIM_GAS)
                .reclaim()
                .then(Self::ext(env::current_account_id()).with_static_gas(ON_RECLAIMED_GAS).on_reclaimed(index));
        } else {
            r.reclaimed = Some(false);
            self.outstanding = self.outstanding.saturating_sub(r.safe_fund.0);
        }
        event("collected", json!({ "id": r.id, "n": r.n, "outcome": state }));
        self.rounds.replace(index, r);
        while self.rounds.get(self.collected).is_some_and(|r| r.outcome.is_some()) {
            self.collected += 1;
        }
        Some(state)
    }

    /// The safe of a round nobody won answered `reclaim`. Sent: its NEAR is here, in what the treasury can spend. Not
    /// sent (the safe refused or could not): it stays in the safe. Either way the safe's NEAR no longer counts as out:
    /// what came home is here, and only once it is here.
    #[private]
    pub fn on_reclaimed(&mut self, index: u32) -> bool {
        let sent = env::promise_results_count() == 1 && env::promise_result_checked(0, 64).is_ok();
        let Some(mut r) = self.rounds.get(index).cloned() else { return false };
        if r.reclaimed.is_some() {
            return r.reclaimed == Some(true);
        }
        r.reclaimed = Some(sent);
        self.outstanding = self.outstanding.saturating_sub(r.safe_fund.0);
        if !sent {
            log!("the safe {} did not send its NEAR home: it stays there", r.safe);
        }
        event("reclaimed", json!({ "id": r.id, "n": r.n, "safe": r.safe, "sent": sent }));
        self.rounds.replace(index, r);
        sent
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------------

    /// Finished rounds `collect` would ask about now, from the cursor or from `from_index` past it.
    pub fn collectable(&self, from_index: Option<u32>) -> u32 {
        let now = env::block_timestamp();
        let start = from_index.unwrap_or(0).max(self.collected);
        let end = self.rounds.len().min(start.saturating_add(COLLECT_SCAN));
        (start..end)
            .filter_map(|i| self.rounds.get(i))
            .filter(|r| r.outcome.is_none() && now >= r.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR)
            .count() as u32
    }

    /// The whole season: who does what, the limits, the program, the treasury and what is on its way.
    pub fn season(&self) -> SeasonView {
        SeasonView {
            name: self.name.clone(),
            admin: self.admin.clone(),
            scheduler: self.scheduler.clone(),
            bounty: self.bounty.clone(),
            limits: self.limits.clone(),
            safe_codes: self.safe_codes.clone(),
            program: self.program.clone(),
            pending: self.pending_change().cloned(),
            rounds: self.rounds.len(),
            safes: self.made,
            funded: U128(self.funded),
            sponsors: self.sponsor_count,
            exited: U128(self.exited),
            shares: U128(self.total_shares),
            outstanding: U128(self.outstanding),
            spent: U128(self.spent),
            treasury: U128(self.treasury()),
            spare: self.spare.clone(),
            opening: self.opening.clone(),
            delay_hours: CHANGE_DELAY_HOURS,
            notice_hours: CHANGE_NOTICE_HOURS,
        }
    }

    /// The next round: when, on what, for how much. `null` when no target of the program can run.
    pub fn next(&self) -> Option<NextRound> {
        let now = env::block_timestamp();
        let at = self.due_slot(now).unwrap_or_else(|| next_slot(&self.program, now));
        let (_, target) = self.next_target().ok()?;
        let p = &self.program;
        let n = match &self.spare {
            Some(s) if self.spare_fits(s, &target) => s.n,
            _ => self.made + 1,
        };
        let treasury = self.treasury();
        Some(NextRound {
            at_ns: U64(at),
            n,
            challenge: target.challenge.clone(),
            code_hash: target.code_hash.clone(),
            prize: p.prize,
            safe_fund: target.safe_fund,
            min_loot: target.min_loot,
            masks: p.masks.clone(),
            hours: p.hours,
            commit_minutes: p.commit_minutes,
            reveal_minutes: p.reveal_minutes,
            funded: treasury >= self.cost_of(&target),
            treasury: U128(treasury),
        })
    }

    /// The latest rounds, newest first, at most 50.
    pub fn latest(&self, limit: Option<u32>) -> Vec<SeasonRound> {
        let n = self.rounds.len();
        let take = limit.unwrap_or(10).min(50);
        (0..n).rev().take(take as usize).filter_map(|i| self.rounds.get(i).cloned()).collect()
    }

    /// Every round in the order they opened, a page at a time (at most 50).
    pub fn rounds(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<SeasonRound> {
        let from = from_index.unwrap_or(0);
        let to = from.saturating_add(limit.unwrap_or(50).min(50)).min(self.rounds.len());
        (from..to).filter_map(|i| self.rounds.get(i).cloned()).collect()
    }

    /// What a sponsor has put in.
    pub fn sponsor(&self, account_id: AccountId) -> U128 {
        U128(self.sponsors.get(&account_id).copied().unwrap_or(0))
    }

    /// What a sponsor's shares are worth now: what `exit` would pay it.
    pub fn share_of(&self, account_id: AccountId) -> U128 {
        let held = self.held(&account_id);
        U128(if held == 0 { 0 } else { mul_div(self.treasury(), held, self.total_shares) })
    }

    /// The least a round's bounty locks for `masks` masks: the bounty contract keeps the round's storage and every
    /// mask's reserve out of it, and the winner still gets `MIN_PRIZE`.
    pub fn min_prize(&self, masks: u32) -> U128 {
        U128(min_prize_for(masks as usize))
    }
}

/// `a * b / c` rounded down, through a 256-bit product: shares times yoctoNEAR overflow 128 bits. `None` when the
/// quotient does not fit in 128 bits, or `c` is 0.
pub(crate) fn mul_div_checked(a: u128, b: u128, c: u128) -> Option<u128> {
    if c == 0 {
        return None;
    }
    let (hi, lo) = mul_wide(a, b);
    if hi >= c {
        return None;
    }
    Some(div_wide(hi, lo, c))
}

/// `a * b / c` for a quotient that fits: `b <= c` or `a <= c`, as in `exit` and `share_of`. Panics otherwise.
pub(crate) fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    mul_div_checked(a, b, c).unwrap_or_else(|| env::panic_str("mul_div: the quotient does not fit"))
}

/// The 256-bit product of `a` and `b`, as its high and low 128 bits.
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const LOW: u128 = u64::MAX as u128;
    let (a1, a0, b1, b0) = (a >> 64, a & LOW, b >> 64, b & LOW);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & LOW) + (p10 & LOW);
    ((p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64)), (p00 & LOW) | (mid << 64))
}

/// `(hi, lo) / c` for `hi < c`, one bit at a time.
fn div_wide(hi: u128, lo: u128, c: u128) -> u128 {
    let (mut q, mut r) = (0u128, hi);
    for i in (0..128u32).rev() {
        let carry = r >> 127;
        r = (r << 1) | ((lo >> i) & 1);
        q <<= 1;
        if carry == 1 || r >= c {
            r = r.wrapping_sub(c);
            q |= 1;
        }
    }
    q
}

/// See `min_prize`.
pub(crate) fn min_prize_for(masks: usize) -> u128 {
    let masks = masks as u64;
    let bytes = ROUND_BYTES + ROUND_BYTES_PER_MASK * masks + BOUNTY_GROWTH_BYTES + MASK_STORAGE_BYTES * masks;
    MIN_PRIZE.as_yoctonear() + env::storage_byte_cost().as_yoctonear() * u128::from(bytes)
}

/// Whether `v` names no account: numbers, flags, amounts (decimal strings) and nothing else, at any depth, under keys
/// that are plain names (`key_ok`).
fn names_no_account(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(s) => !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()),
        Value::Array(a) => a.iter().all(names_no_account),
        Value::Object(o) => o.iter().all(|(k, v)| key_ok(k) && names_no_account(v)),
    }
}

/// A key of `init` is a plain name, `^[a-z_][a-z0-9_]{0,31}$`: no dot, so no named account, and at most 32
/// characters, so no implicit one (64 hex, or `0x` and 40 hex).
fn key_ok(k: &str) -> bool {
    let b = k.as_bytes();
    (1..=32).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// The parts no one calls from outside.
impl Season {
    /// A sponsor's shares now: of this era, halved as often as all shares were since they were written.
    fn held(&self, by: &AccountId) -> u128 {
        self.shares
            .get(by)
            .filter(|h| h.era == self.era)
            .map_or(0, |h| h.shares.checked_shr(self.shift - h.shift).unwrap_or(0))
    }

    pub(crate) fn safe_account(&self, n: u32) -> AccountId {
        format!("s{:04}.{}", n, env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("bad safe name"))
    }

    /// NEAR the treasury can spend on rounds: its balance less its storage, `KEEP` and the deposits of publications
    /// on their way, which are their payers' until `on_published`.
    pub(crate) fn treasury(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        env::account_balance().as_yoctonear().saturating_sub(storage + KEEP.as_yoctonear() + self.publishing)
    }

    /// What may still come home besides what the treasury can spend: what rounds hold, and the spare safe's NEAR,
    /// which the next round takes as it is.
    fn out(&self) -> u128 {
        self.outstanding + self.spare.as_ref().map_or(0, |s| s.target.safe_fund.0)
    }

    /// `fund` and `exit` wait while a round is on its way or a publication's deposit is: then the treasury's balance
    /// is not what it has. A round or a publication that never came back stops holding them after
    /// `OPENING_TIMEOUT_BLOCKS`.
    fn require_settled(&self, what: &str) {
        let height = env::block_height();
        require!(
            self.opening.as_ref().is_none_or(|o| height >= o.height.0 + OPENING_TIMEOUT_BLOCKS),
            &format!("a round is on its way: {what}")
        );
        require!(
            self.publishing == 0 || height >= self.publishing_height + OPENING_TIMEOUT_BLOCKS,
            "a safe code is being published: try again in a few blocks"
        );
    }

    /// What the next round takes: its bounty, and its safe's NEAR unless the spare safe already holds it.
    fn cost_of(&self, target: &Target) -> u128 {
        let spare = self.spare.as_ref().is_some_and(|s| self.spare_fits(s, target));
        self.program.prize.0 + if spare { 0 } else { target.safe_fund.0 }
    }

    /// The slot a round may open for now: the latest one, if no round opened for it yet.
    fn due_slot(&self, now: u64) -> Option<u64> {
        latest_slot(&self.program, now).filter(|s| *s > self.last_slot_ns)
    }

    fn prune(&mut self, now: u64) {
        self.recent.retain(|t| *t + NS_PER_DAY > now);
    }

    /// The target whose turn it is, skipping any whose safe code is no longer allowed.
    fn next_target(&self) -> Result<(u32, Target), String> {
        let targets = &self.program.targets;
        let len = targets.len() as u32;
        (0..len)
            .map(|i| (self.turn + i) % len)
            .find_map(|i| {
                let t = &targets[i as usize];
                self.safe_codes.contains(&t.code_hash).then(|| (i, t.clone()))
            })
            .ok_or_else(|| "no target of the program has an allowed safe code".to_string())
    }

    /// The spare safe runs this target's code for exactly the program's masks: the judge checks both.
    fn spare_fits(&self, spare: &Spare, target: &Target) -> bool {
        spare.bounty == self.bounty
            && spare.target.code_hash == target.code_hash
            && spare.target.challenge == target.challenge
            && spare.masks == self.program.masks
            && self.safe_codes.contains(&spare.target.code_hash)
    }

    /// Whether the bounty contract would open this round: the judge the season agrees to, the safe's code, and no new
    /// code or admin pending there (then it opens nothing).
    fn bounty_takes(&self, state: &Value, target: &Target) -> Result<(), String> {
        let judge = state.pointer("/judge/version").and_then(Value::as_str).unwrap_or_default();
        if judge != self.program.judge_version {
            return Err(format!("the bounty contract judges with {judge}, the season agreed to another judge"));
        }
        let codes = state.get("safe_codes").and_then(Value::as_array).cloned().unwrap_or_default();
        if !codes.iter().any(|c| c.as_str() == Some(target.code_hash.as_str())) {
            return Err("the bounty contract does not know the safe's code".into());
        }
        let pending = state.pointer("/pending/change/kind").and_then(Value::as_str);
        if matches!(pending, Some("code") | Some("admin")) {
            return Err("new code or a new admin is pending on the bounty contract: it opens no round".into());
        }
        Ok(())
    }

    /// A round that opened on its bounty contract: the season's from now on, with the slot it took.
    fn record(
        &mut self,
        attempt: u32,
        id: String,
        spare: Spare,
        terms: RoundTerms,
        deadline: Option<U64>,
    ) -> SeasonRound {
        let o = self.opening.clone().filter(|o| o.attempt == attempt);
        if o.is_some() {
            self.opening = None;
        }
        if self.spare.as_ref() == Some(&spare) {
            self.spare = None;
        }
        let now = env::block_timestamp();
        // The bounty contract's own deadline; the round opened `hours` before it, a few blocks before this callback.
        let deadline = deadline.map_or(now + terms.hours * NS_PER_HOUR, |d| d.0);
        let opened_ns = deadline.saturating_sub(terms.hours * NS_PER_HOUR);
        let slot = o.as_ref().map_or(now, |o| o.slot_ns.0);
        let round = SeasonRound {
            id,
            n: spare.n,
            safe: spare.safe,
            challenge: spare.target.challenge.clone(),
            code_hash: spare.target.code_hash.clone(),
            prize: terms.prize,
            safe_fund: spare.target.safe_fund,
            min_loot: spare.target.min_loot,
            masks: spare.masks,
            slot_ns: U64(slot),
            opened_ns: U64(opened_ns),
            commit_until_ns: U64(opened_ns + terms.commit_minutes * NS_PER_MINUTE),
            deadline_ns: U64(deadline),
            bounty: spare.bounty,
            outcome: None,
            reclaimed: None,
        };
        self.spent += terms.prize.0;
        // The bounty and the safe's NEAR are out with the round until `collect` brings it home.
        self.outstanding += terms.prize.0 + round.safe_fund.0;
        self.last_slot_ns = self.last_slot_ns.max(slot);
        self.recent.push(now);
        if let Some(o) = o {
            self.turn = (o.turn + 1) % (self.program.targets.len().max(1) as u32);
        }
        self.rounds.push(round.clone());
        event("open", &round);
        round
    }

    /// Shares for `amount` just paid in, at the price of everything the treasury had before it: what it can spend and
    /// what may still come home (`out`). Halves every share first when the total would pass `SHARE_LIMIT`.
    fn mint(&mut self, amount: u128) -> u128 {
        let assets = self.treasury().saturating_sub(amount) + self.out();
        if self.total_shares > 0 && assets == 0 {
            // Rounds took everything and nothing is out: the old shares are worth nothing.
            self.era += 1;
            self.shift = 0;
            self.total_shares = 0;
        }
        if self.total_shares == 0 {
            // NEAR that belongs to no sponsor (what the treasury was deployed with, or what came back after everyone
            // left) stays the treasury's own: it gets shares that nobody holds, and a newcomer buys in beside them.
            self.total_shares = assets.min(SHARE_LIMIT / 2);
            if self.total_shares == 0 {
                return amount;
            }
        }
        loop {
            if self.total_shares == 0 {
                return amount;
            }
            match mul_div_checked(amount, self.total_shares, assets) {
                Some(m) if m <= SHARE_LIMIT.saturating_sub(self.total_shares) => return m,
                _ => {
                    self.total_shares >>= 16;
                    self.shift += 16;
                }
            }
        }
    }

    fn give_up(&mut self, attempt: u32, why: &str) -> PromiseOrValue<Option<SeasonRound>> {
        self.skip(attempt, why);
        PromiseOrValue::Value(None)
    }

    /// No round this time: the slot stays free, and `why` goes to the log and the `skip` event.
    fn skip(&mut self, attempt: u32, why: &str) {
        if self.opening.as_ref().is_some_and(|o| o.attempt == attempt) {
            self.opening = None;
        }
        log!("no round this time: {}", why);
        event("skip", json!({ "attempt": attempt, "why": why }));
    }

    fn skip_round(&mut self, attempt: u32, id: &str, why: &str) {
        if self.opening.as_ref().is_some_and(|o| o.attempt == attempt) {
            self.opening = None;
        }
        log!("no round this time: {}", why);
        event("skip", json!({ "attempt": attempt, "id": id, "why": why }));
    }

    /// A made safe waits for a round as the spare. The spare is never replaced: if another safe waits already, this one
    /// keeps its NEAR and is logged as left behind.
    fn park(&mut self, spare: &Spare) {
        match &self.spare {
            None => self.spare = Some(spare.clone()),
            Some(s) if s == spare => {}
            Some(s) => {
                log!("the spare safe {} still waits: {} is left behind with its NEAR", s.safe, spare.safe);
                event("orphan", json!({ "n": spare.n, "safe": spare.safe, "why": "another spare safe waits" }));
            }
        }
    }

    /// The safe's `new` arguments: every account in them comes from the season, the rest from the target.
    fn safe_init(&self, target: &Target, safe: &AccountId) -> Vec<u8> {
        let mut args: Map<String, Value> = serde_json::from_str(&target.init).unwrap_or_default();
        args.insert("owner".into(), json!(safe));
        args.insert("masks".into(), json!(self.program.masks));
        args.insert("arbiter".into(), json!(self.bounty));
        args.insert("team".into(), json!(env::current_account_id()));
        serde_json::to_vec(&args).unwrap_or_default()
    }

    /// Opens the round on `spare`: the bounty comes from the treasury, the id is fresh every attempt, so nobody can
    /// take it on the bounty contract first.
    fn open_round(&mut self, attempt: u32, spare: Spare) -> Promise {
        let seed = env::random_seed();
        let id = format!("{}-{:04}-{}", self.name, spare.n, hex(&seed[..3]));
        let p = &self.program;
        let terms = RoundTerms { prize: p.prize, hours: p.hours, commit_minutes: p.commit_minutes };
        log!("round {} opens on {} with {} yoctoNEAR", id, spare.safe, p.prize.0);
        ext_bounty::ext(spare.bounty.clone())
            .with_attached_deposit(NearToken::from_yoctonear(p.prize.0))
            .with_static_gas(OPEN_SAFE_GAS)
            .open_safe(
                id.clone(),
                spare.safe.clone(),
                spare.masks.clone(),
                spare.target.min_loot,
                p.hours,
                p.commit_minutes,
                Some(p.reveal_minutes),
                spare.target.code_hash.clone(),
                p.judge_version.clone(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_OPENED_GAS)
                    .on_opened(attempt, id, spare, terms),
            )
    }

    pub(crate) fn check_limits(&self, l: &Limits) {
        require!(l.max_prize.0 >= MIN_PRIZE.as_yoctonear(), "max_prize: at least 0.1 NEAR");
        require!(l.max_safe_fund.0 > MIN_LOOT.as_yoctonear(), "max_safe_fund: more than 0.1 NEAR");
        require!((1..=MAX_PER_DAY).contains(&l.max_per_day), "max_per_day: 1 to 48");
    }

    /// A program fits the limits and the allowed safe codes, and the bounty contract can open its rounds.
    pub(crate) fn check_program(&self, p: &Program) -> Result<(), String> {
        let me = env::current_account_id();
        let sub = format!(".{me}");
        if !(1..=MAX_MASKS).contains(&p.masks.len()) {
            return Err("masks: 1 to 16 accounts".into());
        }
        for (i, m) in p.masks.iter().enumerate() {
            if p.masks[..i].contains(m) {
                return Err("a mask is listed twice".into());
            }
            if *m == me || *m == self.bounty || m.as_str().ends_with(&sub) {
                return Err("a mask is its own account, not the season, the bounty contract or a safe".into());
            }
        }
        if !(1..=MAX_TARGETS).contains(&p.targets.len()) {
            return Err("targets: 1 to 16".into());
        }
        for t in &p.targets {
            if !challenge_ok(&t.challenge) {
                return Err("challenge: the library id, lowercase letters, digits and -".into());
            }
            if !self.safe_codes.contains(&t.code_hash) {
                return Err(format!("{}: its safe code is not one the season allows", t.challenge));
            }
            let init: Map<String, Value> = match serde_json::from_str(&t.init) {
                Ok(Value::Object(m)) if t.init.len() <= MAX_INIT_BYTES => m,
                _ => return Err(format!("{}: init is a JSON object of at most 1024 bytes", t.challenge)),
            };
            if ["owner", "masks", "arbiter", "team"].iter().any(|k| init.contains_key(*k)) {
                return Err(format!("{}: the season sets owner, masks, arbiter and team itself", t.challenge));
            }
            if !init.iter().all(|(k, v)| key_ok(k) && names_no_account(v)) {
                return Err(format!(
                    "{}: init names no account: plain names for keys; numbers, flags and amounts for values",
                    t.challenge
                ));
            }
            if t.min_loot.0 < MIN_LOOT.as_yoctonear() || t.min_loot.0 >= t.safe_fund.0 {
                return Err(format!("{}: min_loot is at least 0.1 NEAR and less than the safe holds", t.challenge));
            }
            if t.safe_fund.0 > self.limits.max_safe_fund.0 {
                return Err(format!("{}: the safe's NEAR is over the limit", t.challenge));
            }
        }
        let least = min_prize_for(p.masks.len());
        if p.prize.0 < least || p.prize.0 > self.limits.max_prize.0 {
            return Err(format!(
                "prize: at least {least} yoctoNEAR (0.1 NEAR for the winner beyond the round's storage on the bounty contract) and within the limit"
            ));
        }
        if !(1..=MAX_ROUND_HOURS).contains(&p.hours) {
            return Err("hours: 1 to 24".into());
        }
        if p.commit_minutes < MIN_COMMIT_MINUTES {
            return Err("commit_minutes: at least 30, time for the masks to race the target and seal".into());
        }
        if p.reveal_minutes < 1 || p.commit_minutes + p.reveal_minutes > p.hours * 60 {
            return Err("commit and reveal: at least a minute to reveal, and both fit in the round".into());
        }
        if p.reveal_minutes < SAFE_TURN_MINUTES * (p.masks.len() as u64 + 1) {
            return Err(
                "reveal_minutes: 3 for each mask's turn on the safe, and 3 more, as the bounty contract wants".into()
            );
        }
        if !hex64_ok(&p.judge_version) {
            return Err("judge_version: the judge wasm's sha256 in hex".into());
        }
        if p.first_minute >= MINUTES_PER_DAY || !(1..=MINUTES_PER_DAY).contains(&p.every_minutes) {
            return Err("schedule: first_minute below 1440, every_minutes 1 to 1440".into());
        }
        Ok(())
    }
}
