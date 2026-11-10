//! MASK WARS crews: masks that take jobs together.
//!
//! A captain forms a crew: two to eight masks, each with a role (scout, striker, verifier), and a split: each role's
//! share of a won reward in basis points. Nothing binds a mask until it joins, and it joins one exact version of the
//! crew: any change of roster or split makes a new version and every seat joins again. A mask joins itself with its
//! own key, or its owner joins for it: for a mask forged by a known factory, the contract asks the factory who owns
//! it (`get_mask`).
//!
//! Once every seat has joined, the captain enlists the crew in a job: this contract hands the jobs contract the roster
//! and the split as they are (`enlist_crew`), and the job keeps them to its end, whatever the crew does next. The crew
//! holds no NEAR: the jobs contract pays every mask on its own account.
//!
//! The contract's account holds no key: its code and settings change only after a wait anyone can see.

#[cfg(test)]
mod tests;

use near_sdk::json_types::U64;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

pub const MIN_CREW: usize = 2;
pub const MAX_CREW: usize = 8;
/// Crews one mask may have joined at once. Only the mask's own yes counts toward it: listing a mask binds it to
/// nothing, so nobody can fill another mask's crews.
pub const MAX_CREWS_PER_MASK: usize = 16;
/// What the captain sets aside for each seat, for the entry its mask's list of crews takes once it joins: the list's
/// own record and a crew id. Held while the crew exists, given back when it is disbanded.
pub const SEAT_BYTES: u64 = 160;
pub const BPS: u16 = 10_000;
/// New code waits this long once any crew exists, as long as new code waits on the jobs contract (the longest job
/// and a day to settle it), and no crew enlists meanwhile: a job trusts its crews contract for every mask's yes.
pub const CHANGE_DELAY_HOURS: u64 = 168;
pub const CHANGE_NOTICE_HOURS: u64 = 1;
pub const CHANGE_LAPSE_HOURS: u64 = 24;
const NS_PER_HOUR: u64 = 3_600_000_000_000;
const FACTORY_GAS: Gas = Gas::from_tgas(10);
const ON_OWNER_GAS: Gas = Gas::from_tgas(15);
const ENLIST_GAS: Gas = Gas::from_tgas(40);
const ON_ENLISTED_GAS: Gas = Gas::from_tgas(10);
const MIGRATE_GAS: Gas = Gas::from_tgas(50);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Recon: finds where the work is.
    Scout,
    /// Delivers the work. Only a striker's work can win a job.
    Striker,
    /// Checks the work before it goes.
    Verifier,
}

pub const ROLES: [Role; 3] = [Role::Scout, Role::Striker, Role::Verifier];

/// Each role's share of a won reward, in basis points.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Split {
    pub scout: u16,
    pub striker: u16,
    pub verifier: u16,
}

impl Split {
    pub fn of(&self, role: Role) -> u16 {
        match role {
            Role::Scout => self.scout,
            Role::Striker => self.striker,
            Role::Verifier => self.verifier,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub mask: AccountId,
    pub role: Role,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Seat {
    pub mask: AccountId,
    pub role: Role,
    /// The mask, or its owner, agreed to this version of the crew.
    pub joined: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Crew {
    pub captain: AccountId,
    pub seats: Vec<Seat>,
    pub split: Split,
    /// Every change of roster or split makes a new version, and every seat joins it again.
    pub version: u32,
    pub formed_ns: u64,
    /// Jobs the crew enlisted in.
    pub jobs: u32,
    /// NEAR the captain set aside for its seats' entries (`SEAT_BYTES` a seat).
    pub reserve: u128,
}

/// What the jobs contract takes: the roster and the split, as every member agreed to them.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CrewTicket {
    pub crew: String,
    pub version: u32,
    pub members: Vec<Member>,
    pub split: Split,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CrewView {
    pub id: String,
    pub captain: AccountId,
    pub seats: Vec<Seat>,
    pub split: Split,
    pub version: u32,
    /// Every seat joined: the crew can enlist.
    pub ready: bool,
    pub formed_ns: U64,
    pub jobs: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub admin: AccountId,
    pub factories: Vec<AccountId>,
    pub crews: u32,
    pub pending: Option<Pending>,
}

/// A change the admin may propose.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    /// New code: the sha256 of the wasm, lowercase hex. `upgrade` takes the wasm itself.
    Code {
        sha256: String,
    },
    Admin {
        account: AccountId,
    },
    /// Mask factories whose owners may join and leave for their masks.
    Factories {
        accounts: Vec<AccountId>,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub change: Change,
    pub proposed_ns: U64,
    pub ready_ns: U64,
}

/// What a mask factory's `get_mask` says, as far as this contract reads it.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct MaskOwner {
    pub account: AccountId,
    pub owner: AccountId,
}

#[ext_contract(ext_factory)]
#[allow(dead_code)]
trait Factory {
    fn get_mask(&self, name: String) -> Option<MaskOwner>;
}

#[ext_contract(ext_jobs)]
#[allow(dead_code)]
trait Jobs {
    fn enlist_crew(&mut self, id: String, ticket: CrewTicket) -> u32;
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Crews,
    ByMask,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Crews {
    admin: AccountId,
    factories: Vec<AccountId>,
    /// Crews in the order they were formed; a disbanded crew leaves nothing behind.
    crews: IterableMap<String, Crew>,
    /// Every crew a mask has joined.
    by_mask: LookupMap<AccountId, Vec<String>>,
    pending: Option<Pending>,
}

#[near]
impl Crews {
    /// The account is created, funded, given this code and initialized in one transaction that adds no key.
    #[init]
    pub fn new(admin: AccountId, factories: Vec<AccountId>) -> Self {
        require!(factories.len() <= 8 && distinct(&factories), "factories: at most 8 accounts, no repeats");
        Self {
            admin,
            factories,
            crews: IterableMap::new(Key::Crews),
            by_mask: LookupMap::new(Key::ByMask),
            pending: None,
        }
    }

    // -------------------------------------------------------------------------------------------------------------
    // The captain
    // -------------------------------------------------------------------------------------------------------------

    /// Forms crew `id` with these masks and this split. The deposit pays the crew's record and `SEAT_BYTES` a seat;
    /// the rest comes back. A seat the captain holds itself is joined at once; every other mask joins on its own.
    #[payable]
    pub fn form(&mut self, id: String, members: Vec<Member>, split: Split) -> CrewView {
        let captain = env::predecessor_account_id();
        require!(id_ok(&id), "id: 3 to 32 lowercase letters, digits or -");
        require!(!self.crews.contains_key(&id), "this crew id is taken");
        check_roster(&members, &split);
        let reserve = cost_of(members.len() as u64 * SEAT_BYTES);
        let before = env::storage_usage();
        let seats = seats_for(&members, &captain);
        self.crews.insert(
            id.clone(),
            Crew {
                captain: captain.clone(),
                seats,
                split,
                version: 1,
                formed_ns: env::block_timestamp(),
                jobs: 0,
                reserve,
            },
        );
        let record = self.grown_since(before);
        self.index_joined(&id, true);
        self.settle_deposit(&captain, cost_of(record.max(0) as u64) + reserve, 0);
        let view = self.view(&id);
        event("form", &view);
        view
    }

    /// The captain changes the roster or the split: a new version, and every seat joins again.
    #[payable]
    pub fn reform(&mut self, id: String, members: Vec<Member>, split: Split) -> CrewView {
        let mut crew = self.only_captain(&id);
        check_roster(&members, &split);
        // The masks' lists are paid for by the seats' reserve: what they free is measured apart from the record.
        self.index_joined(&id, false);
        let old = crew.reserve;
        let before = self.usage();
        crew.seats = seats_for(&members, &crew.captain);
        crew.split = split;
        crew.version += 1;
        crew.reserve = cost_of(members.len() as u64 * SEAT_BYTES);
        let (captain, new) = (crew.captain.clone(), crew.reserve);
        self.crews.insert(id.clone(), crew);
        let grown = self.grown_since(before);
        self.index_joined(&id, true);
        let (charge, refund) = (new + cost_of(grown.max(0) as u64), old + cost_of((-grown).max(0) as u64));
        self.settle_deposit(&captain, charge, refund);
        let view = self.view(&id);
        event("reform", &view);
        view
    }

    /// The captain disbands the crew; the storage it freed goes back to the captain. Jobs it is on keep its roster.
    pub fn disband(&mut self, id: String) {
        let crew = self.only_captain(&id);
        self.index_joined(&id, false);
        let before = self.usage();
        self.crews.remove(&id);
        let freed = -self.grown_since(before);
        self.settle_deposit(&crew.captain, 0, crew.reserve + cost_of(freed.max(0) as u64));
        event("disband", &Named { id: &id });
    }

    /// The captain enlists the crew in job `job` on the jobs contract `jobs`, once every seat joined. The job takes
    /// the roster and the split of this version and keeps them to its end; each member takes the bond its owner (or the
    /// keeper) locked for it there first (`jobs.bond`).
    pub fn enlist(&mut self, id: String, jobs: AccountId, job: String) -> Promise {
        let crew = self.only_captain(&id);
        require!(self.pending_code().is_none(), "new code is waiting to apply: no crew enlists until it has");
        require!(crew.seats.iter().all(|s| s.joined), "every mask joins this version of the crew first");
        let ticket = CrewTicket {
            crew: id.clone(),
            version: crew.version,
            members: crew.seats.iter().map(|s| Member { mask: s.mask.clone(), role: s.role }).collect(),
            split: crew.split,
        };
        ext_jobs::ext(jobs.clone()).with_static_gas(ENLIST_GAS).enlist_crew(job.clone(), ticket).then(
            Self::ext(env::current_account_id()).with_static_gas(ON_ENLISTED_GAS).on_enlisted(
                id,
                crew.version,
                jobs,
                job,
            ),
        )
    }

    // -------------------------------------------------------------------------------------------------------------
    // Masks and their owners
    // -------------------------------------------------------------------------------------------------------------

    /// A mask joins `version` of the crew with its own key: it agrees to the roster and the split as they are.
    pub fn join(&mut self, id: String, version: u32) -> CrewView {
        let mask = env::predecessor_account_id();
        self.set_joined(&id, Some(version), &mask, true);
        self.view(&id)
    }

    /// A mask leaves: its seat is no longer joined, and the crew cannot enlist until it joins again or the captain
    /// reforms without it.
    pub fn leave(&mut self, id: String) -> CrewView {
        let mask = env::predecessor_account_id();
        self.set_joined(&id, None, &mask, false);
        self.view(&id)
    }

    /// The owner of a mask forged by a known factory joins for it: the contract asks the factory who owns the mask.
    pub fn join_for(&mut self, id: String, version: u32, mask: AccountId) -> Promise {
        self.ask_owner(id, Some(version), mask, true)
    }

    pub fn leave_for(&mut self, id: String, mask: AccountId) -> Promise {
        self.ask_owner(id, None, mask, false)
    }

    /// The factory's word on who owns the mask: only its owner's join or leave goes through.
    #[private]
    pub fn on_owner(
        &mut self,
        id: String,
        version: Option<u32>,
        mask: AccountId,
        signer: AccountId,
        join: bool,
        #[callback_result] view: Result<Option<MaskOwner>, PromiseError>,
    ) -> bool {
        let owner = match view {
            Ok(Some(v)) if v.account == mask => v.owner,
            _ => {
                log!("the factory knows no mask {}", mask);
                return false;
            }
        };
        if owner != signer {
            log!("{} does not own {}", signer, mask);
            return false;
        }
        match self.crews.get(&id) {
            Some(c) if version.is_none_or(|v| v == c.version) && c.seats.iter().any(|s| s.mask == mask) => {}
            _ => {
                log!("crew {} changed while the factory answered: nothing done", id);
                return false;
            }
        }
        self.set_joined(&id, version, &mask, join);
        true
    }

    #[private]
    pub fn on_enlisted(
        &mut self,
        id: String,
        version: u32,
        jobs: AccountId,
        job: String,
        #[callback_result] entrant: Result<u32, PromiseError>,
    ) -> Option<u32> {
        let Ok(entrant) = entrant else {
            log!("crew {} did not enlist in {} on {}", id, job, jobs);
            return None;
        };
        if let Some(c) = self.crews.get_mut(&id) {
            c.jobs += 1;
        }
        event("enlist", &Enlisted { id: &id, version, jobs: &jobs, job: &job, entrant });
        Some(entrant)
    }

    // -------------------------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------------------------

    pub fn get_crew(&self, id: String) -> Option<CrewView> {
        self.crews.contains_key(&id).then(|| self.view(&id))
    }

    pub fn crews_of(&self, mask: AccountId) -> Vec<CrewView> {
        self.by_mask.get(&mask).map(|ids| ids.iter().map(|i| self.view(i)).collect()).unwrap_or_default()
    }

    /// Crews from `from_index`, at most 50.
    pub fn list_crews(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<CrewView> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(50) as usize;
        self.crews.keys().skip(from).take(limit).map(|id| self.view(id)).collect()
    }

    pub fn config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            factories: self.factories.clone(),
            crews: self.crews.len(),
            pending: self.pending.clone(),
        }
    }

    // -------------------------------------------------------------------------------------------------------------
    // Governance
    // -------------------------------------------------------------------------------------------------------------

    pub fn propose(&mut self, change: Change) -> Pending {
        self.only_admin();
        require!(self.pending.as_ref().is_none_or(lapsed), "a change is already pending: cancel it first");
        let mut hours = CHANGE_NOTICE_HOURS;
        match &change {
            Change::Code { sha256 } => {
                require!(hex64_ok(sha256), "code: the wasm's sha256 in hex");
                if !self.crews.is_empty() {
                    hours = CHANGE_DELAY_HOURS;
                }
            }
            Change::Factories { accounts } => {
                require!(accounts.len() <= 8 && distinct(accounts), "at most 8 accounts, no repeats")
            }
            Change::Admin { .. } => {}
        }
        let now = env::block_timestamp();
        let p = Pending { change, proposed_ns: U64(now), ready_ns: U64(now + hours * NS_PER_HOUR) };
        event("propose", &p);
        self.pending = Some(p.clone());
        p
    }

    pub fn cancel_change(&mut self) -> Option<Pending> {
        self.only_admin();
        let p = self.pending.take();
        event("cancel_change", &p);
        p
    }

    pub fn apply(&mut self) -> Config {
        let p = self.ready_change();
        match p.change.clone() {
            Change::Code { .. } => env::panic_str("new code comes with upgrade, which takes the wasm"),
            Change::Admin { account } => self.admin = account,
            Change::Factories { accounts } => self.factories = accounts,
        }
        event("apply", &p.change);
        self.pending = None;
        self.config()
    }

    /// Deploys the pending code once its wait is over: the input is the wasm itself. `migrate` runs in the same batch.
    pub fn upgrade(&mut self) -> Promise {
        let p = self.ready_change();
        let Change::Code { sha256 } = &p.change else {
            env::panic_str("the pending change is not new code: use apply");
        };
        let code = env::input().unwrap_or_default();
        require!(&sha256_hex(&code) == sha256, "this wasm is not the proposed code");
        event("upgrade", &p.change);
        self.pending = None;
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            vec![],
            NearToken::from_yoctonear(0),
            MIGRATE_GAS,
        )
    }

    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no crews contract here"));
        near_sdk::borsh::from_slice::<Self>(&raw).unwrap_or_else(|_| env::panic_str("unknown state: nothing migrated"))
    }

    pub fn pending(&self) -> Option<Pending> {
        self.pending.clone()
    }
}

impl Crews {
    fn only_captain(&self, id: &str) -> Crew {
        let crew = self.crews.get(id).cloned().unwrap_or_else(|| env::panic_str("no such crew"));
        require!(env::predecessor_account_id() == crew.captain, "only the crew's captain");
        crew
    }

    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "only the admin proposes changes");
    }

    fn pending_code(&self) -> Option<&Pending> {
        self.pending.as_ref().filter(|p| matches!(p.change, Change::Code { .. }) && !lapsed(p))
    }

    fn ready_change(&self) -> Pending {
        let p = self.pending.clone().unwrap_or_else(|| env::panic_str("no change is pending"));
        require!(env::block_timestamp() >= p.ready_ns.0, "the change is still waiting");
        require!(!lapsed(&p), "the change lapsed: the admin proposes it again");
        p
    }

    fn set_joined(&mut self, id: &str, version: Option<u32>, mask: &AccountId, joined: bool) {
        let crew = self.crews.get(id).unwrap_or_else(|| env::panic_str("no such crew"));
        if let Some(v) = version {
            require!(v == crew.version, "the crew changed: join its current version");
        }
        let at =
            crew.seats.iter().position(|s| &s.mask == mask).unwrap_or_else(|| env::panic_str("no seat for this mask"));
        require!(crew.seats[at].joined != joined, if joined { "already joined" } else { "not joined" });
        let version = crew.version;
        // The mask's list of crews; its entry is paid for by the crew's reserve, set aside at forming.
        self.index(mask, id, joined);
        self.crews.get_mut(id).unwrap().seats[at].joined = joined;
        event(if joined { "join" } else { "leave" }, &Joined { id, version, mask });
    }

    /// The mask must be `<name>.<factory>` for a factory this contract knows; the factory says who owns it.
    fn ask_owner(&mut self, id: String, version: Option<u32>, mask: AccountId, join: bool) -> Promise {
        let crew = self.crews.get(&id).unwrap_or_else(|| env::panic_str("no such crew"));
        require!(crew.seats.iter().any(|s| s.mask == mask), "no seat for this mask");
        let (name, factory) = mask
            .as_str()
            .split_once('.')
            .unwrap_or_else(|| env::panic_str("a mask forged by a factory is <name>.<factory>"));
        let factory: AccountId = factory.parse().unwrap_or_else(|_| env::panic_str("no such factory"));
        require!(self.factories.contains(&factory), "this mask's factory is not one the crews contract knows");
        ext_factory::ext(factory).with_static_gas(FACTORY_GAS).get_mask(name.to_string()).then(
            Self::ext(env::current_account_id()).with_static_gas(ON_OWNER_GAS).on_owner(
                id,
                version,
                mask,
                env::predecessor_account_id(),
                join,
            ),
        )
    }

    /// Adds or removes crew `id` in a mask's list.
    fn index(&mut self, mask: &AccountId, id: &str, add: bool) {
        let mut ids = self.by_mask.get(mask).cloned().unwrap_or_default();
        if add {
            require!(ids.len() < MAX_CREWS_PER_MASK, "a mask joins at most 16 crews at once");
            ids.push(id.to_string());
        } else {
            ids.retain(|i| i != id);
        }
        if ids.is_empty() {
            self.by_mask.remove(mask);
        } else {
            self.by_mask.insert(mask.clone(), ids);
        }
    }

    /// Adds or removes crew `id` in the list of every mask that joined it.
    fn index_joined(&mut self, id: &str, add: bool) {
        let joined: Vec<AccountId> = self
            .crews
            .get(id)
            .map(|c| c.seats.iter().filter(|s| s.joined).map(|s| s.mask.clone()).collect())
            .unwrap_or_default();
        for mask in joined {
            self.index(&mask, id, add);
        }
    }

    /// The storage in use, with every write so far on disk.
    fn usage(&mut self) -> u64 {
        self.crews.flush();
        self.by_mask.flush();
        env::storage_usage()
    }

    /// Bytes the state grew by since `before`, negative when it shrank.
    fn grown_since(&mut self, before: u64) -> i64 {
        self.usage() as i64 - before as i64
    }

    /// The captain pays `charge` out of the attached NEAR and gets `refund` and whatever is left over back.
    fn settle_deposit(&self, to: &AccountId, charge: u128, refund: u128) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit + refund >= charge,
            format!("attach {} yoctoNEAR for the storage", charge.saturating_sub(refund))
        );
        let back = deposit + refund - charge;
        if back > 0 {
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(back)).detach();
        }
    }

    fn view(&self, id: &str) -> CrewView {
        let c = self.crews.get(id).unwrap_or_else(|| env::panic_str("no such crew"));
        CrewView {
            id: id.to_string(),
            captain: c.captain.clone(),
            seats: c.seats.clone(),
            split: c.split,
            version: c.version,
            ready: c.seats.iter().all(|s| s.joined),
            formed_ns: U64(c.formed_ns),
            jobs: c.jobs,
        }
    }
}

fn seats_for(members: &[Member], captain: &AccountId) -> Vec<Seat> {
    members.iter().map(|m| Seat { mask: m.mask.clone(), role: m.role, joined: &m.mask == captain }).collect()
}

fn check_roster(members: &[Member], split: &Split) {
    require!(
        (MIN_CREW..=MAX_CREW).contains(&members.len())
            && distinct(&members.iter().map(|m| m.mask.clone()).collect::<Vec<_>>()),
        "a crew is 2 to 8 masks, no repeats"
    );
    require!(split_ok(split, members), "split: basis points summing to 10000, none for an empty role, a striker");
}

/// Basis points summing to 10000, every member's role paid, no points for a role nobody holds, and a striker.
pub fn split_ok(split: &Split, members: &[Member]) -> bool {
    let sum: u32 = ROLES.iter().map(|r| u32::from(split.of(*r))).sum();
    sum == u32::from(BPS)
        && ROLES.iter().all(|r| (split.of(*r) > 0) == members.iter().any(|m| m.role == *r))
        && members.iter().any(|m| m.role == Role::Striker)
}

/// 3 to 32 lowercase letters, digits or `-`.
pub fn id_ok(id: &str) -> bool {
    (3..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn hex64_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn distinct<T: PartialEq>(list: &[T]) -> bool {
    list.iter().enumerate().all(|(i, a)| !list[..i].contains(a))
}

fn cost_of(bytes: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear() * u128::from(bytes)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn lapsed(p: &Pending) -> bool {
    env::block_timestamp() >= p.ready_ns.0 + CHANGE_LAPSE_HOURS * NS_PER_HOUR
}

/// Logs a NEP-297 event: `EVENT_JSON:{"standard":"maskwars_crews","version":"1.0.0","event":…,"data":…}`.
fn event<T: Serialize>(name: &str, data: &T) {
    #[derive(Serialize)]
    #[serde(crate = "near_sdk::serde")]
    struct Event<'a, T> {
        standard: &'a str,
        version: &'a str,
        event: &'a str,
        data: &'a T,
    }
    let e = Event { standard: "maskwars_crews", version: "1.0.0", event: name, data };
    env::log_str(&format!("EVENT_JSON:{}", near_sdk::serde_json::to_string(&e).unwrap()));
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Named<'a> {
    id: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Joined<'a> {
    id: &'a str,
    version: u32,
    mask: &'a AccountId,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Enlisted<'a> {
    id: &'a str,
    version: u32,
    jobs: &'a AccountId,
    job: &'a str,
    entrant: u32,
}
