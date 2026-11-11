//! Live safe. Holds NEAR on chain for one sealed round (RULES.md). Only the round's masks may touch it. Deployed with
//! `new` in the same transaction, the safe throws away the key that deployed it: from then on only its code moves its
//! NEAR. On chain its owner is the safe itself.
//!
//! PLANTED HOLE, on purpose: this is a training target. `set_owner` lets any mask of the round in, but never checks
//! that the caller is the owner; the owner may sweep the safe to any account.
//!
//! The safe is locked to its round, and only its own team's round. It names at deployment the bounty contract that arms
//! it (`arbiter`) and the team whose round it takes (`team`): the bounty contract arms it when that team opens the
//! round (`arm`), with the end of the commit window, and a round anyone else opens on it does not arm it. Until then
//! nobody moves it, the masks included: no plan can be played, and no NEAR leaves, while plans are still being sealed.
//!
//! The bounty contract tells the safe every seal as it arrives (`queue`), and only a mask that sealed a plan in the
//! round moves the safe, in the order of the seals: seal #0 first. Each sealed mask gets one turn: its first move gives
//! it the safe, back as the round left it (its own owner again), and nobody else moves it meanwhile.
//!
//! The seals play in fixed slots of `TURN_NS` after the window closes: the seal of rank `r` (the number of seals before
//! it) has the slot from `TURN_NS * r` to `TURN_NS * (r + 1)`. A mask may start its turn once every earlier seal has had
//! its turn, or once its own slot has come, and only until its slot closes: a seal that missed its slot plays only
//! after every later seal has played or missed its own. A turn lasts `TURN_NS`, but never into the slot of a later
//! seal that has not played. So however late each earlier seal starts, every seal still has its whole slot, the last
//! slot closes `TURN_NS` per seal after the window, and the bounty contract's reveal window (a slot per mask and one
//! more) is always enough. An earlier seal always plays before a later one that waits its slot, a mask that sealed
//! nothing never takes the loot ahead of the sealed plans, a move of another mask never spoils a plan, and two masks
//! never play into each other. The seals take a fixed place in the safe's state from `new` on: the safe's storage does
//! not grow while they arrive.
//!
//! Every call that changes the safe is a move, and the safe keeps count: it logs each move as an event with its number
//! and its turn, and a turn's first move with an event of its own. The arena's judge reads them to tell that a plan
//! was a mask's own turn, played whole from its first move. A safe deployed without an arbiter is a practice safe: it
//! is open at once, takes no round and no seals, and no judge confirms a drain of it.
//!
//! A round nobody won leaves its NEAR in a safe that nobody holds a key to. The safe's team takes it back
//! (`reclaim`), and only then: once the bounty contract that armed the safe has refunded the round's bounty, which it
//! does only after the deadline and the claim grace, with no claim left with the judge and no drain confirmed. The
//! safe asks that contract itself; the team's word is not enough. A reclaim is no move: it changes neither the round
//! the safe is armed for, nor the seals, nor the count of moves the judge reads.
//!
//! A safe does not stay on chain for good. Once its round is over the team retires it (`retire`): the safe deletes
//! its own account, and all it holds, the NEAR its code and state locked included, goes to the team. Only then: the
//! safe asks the bounty contract that armed it, and goes only when the round's deadline has passed and its bounty is
//! paid to the winner or refunded. Until the deadline the sealed masks still have their turns, so nobody retires the
//! safe, the team included. A safe that took no round locks nobody's turn and is retired at once. The account that
//! made the safe may make it again under the same name for the next round: nothing of the old one is left, and an
//! answer still on its way to the old safe moves nothing in the new one (`on_retire` and `on_bounty` take only the
//! answer asked for by the safe as it was armed).

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

/// Masks in one round.
pub const MAX_MASKS: usize = 16;
/// How long a mask holds the safe from its first move: a plan of 12 calls, one final transaction each, fits with room.
/// Also each seal's slot: the time it has to start its turn, and the most each earlier seal may keep a later one waiting.
pub const TURN_NS: u64 = 3 * 60 * 1_000_000_000;
/// What the safe logs its events under.
pub const STANDARD: &str = "maskwars_safe";
const VERSION: &str = "1.5.0";
/// The bounty contract lets masks claim for 12 hours after the deadline (`CLAIM_GRACE_HOURS` there): the team takes
/// nothing back before that is over.
pub const CLAIM_GRACE_NS: u64 = 12 * 60 * 60 * 1_000_000_000;
/// The bounty contract's `get` of the round, and the safe's answer to it.
const VIEW_GAS: Gas = Gas::from_tgas(10);
const ON_BOUNTY_GAS: Gas = Gas::from_tgas(10);
/// The safe's answer to the bounty contract's word when it retires: the event and the deletion of its own account.
const ON_RETIRE_GAS: Gas = Gas::from_tgas(10);
/// A mask whose seal has not reached the safe.
const NO_SEAL: u32 = u32::MAX;
/// Why a mask may not move the safe right now, but will be let in later in the round.
pub const OTHERS_TURN: &str = "another mask has its turn on the safe";
pub const EARLIER_SEAL: &str = "an earlier seal goes first";
/// A seal that missed its slot: it plays once no later seal can still play in its own.
pub const SLOT_MISSED: &str = "this seal missed its slot: the later seals play first";
/// The team asked to retire the safe before its round's deadline.
pub const BEFORE_DEADLINE: &str = "the round's deadline has not come: the sealed masks still have their turns";
/// The safe has already sent the deletion of its own account.
pub const RETIRING: &str = "the safe is retiring already";
/// An answer about a round the safe is not armed for: it was on its way to an earlier safe of the same name.
pub const ANOTHER_ROUND: &str = "the answer is about another round than the one the safe is armed for";

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Safe {
    owner: AccountId,
    masks: Vec<AccountId>,
    /// Moves so far; the next one gets this number plus one.
    moves: u64,
    /// When anyone last moved the safe, ns.
    last_ns: Option<u64>,
    /// When each account first moved the safe, ns: a mask that has one has had its turn.
    first: LookupMap<AccountId, u64>,
    /// The owner every turn starts with: the one the safe was deployed with.
    home: AccountId,
    /// The bounty contract that arms the safe for its round; `None` for a practice safe.
    arbiter: Option<AccountId>,
    /// The team whose round the safe takes: a round anyone else opens on it does not arm it. `None` for a practice
    /// safe.
    team: Option<AccountId>,
    round: Option<Round>,
    turn: Option<Turn>,
    /// Turns so far.
    turns: u64,
    /// Each mask's seal number in the round, by its place in `masks`; `NO_SEAL` until the bounty contract tells the
    /// safe the mask sealed. A fixed array, written in full by `new`, so seals never grow the safe's storage.
    seals: [u32; MAX_MASKS],
    /// The safe has sent the deletion of its own account (`retire`): it sends it once. A byte the safe pays for
    /// from `new` on, so a safe with nothing left to pay for storage still retires. New fields go last.
    retiring: bool,
}

/// The round the safe is armed for.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Round {
    /// The bounty contract that armed the safe.
    pub arbiter: AccountId,
    /// The round's id on that contract.
    pub bounty: String,
    /// The end of the commit window: nobody moves the safe before it.
    pub opens_ns: U64,
    pub armed_ns: U64,
}

/// One mask's turn on the safe: nobody else moves it until `until_ns`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    pub n: U64,
    pub mask: AccountId,
    /// The number of the turn's first move.
    pub from: U64,
    pub until_ns: U64,
}

/// Who has moved the safe, as of the block a view is read at.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Touches {
    pub moves: U64,
    pub last_ns: Option<U64>,
    /// When the account asked about first moved the safe; `null` if it never did.
    pub first_ns: Option<U64>,
}

/// One sealed mask in the order of play (`get_queue`).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Queued {
    pub mask: AccountId,
    /// Its seal number in the round: the lowest plays first.
    pub seq: u32,
    /// When its slot comes at the latest: from then on no earlier seal holds it back.
    pub slot_ns: U64,
    /// When its slot closes: after that it starts its turn only once no later seal can still play in its own slot.
    pub closes_ns: U64,
    /// When it started its turn; `null` if it has not.
    pub played_ns: Option<U64>,
}

fn event(name: &str, data: String) {
    log!(r#"EVENT_JSON:{{"standard":"{}","version":"{}","event":"{}","data":{}}}"#, STANDARD, VERSION, name, data);
}

/// The bounty contract that armed the safe (contracts/bounty): how its round ended.
#[ext_contract(ext_arbiter)]
#[allow(dead_code)]
trait Arbiter {
    fn get(&self, id: String) -> Option<Bounty>;
}

/// The part of the bounty contract's answer the safe reads: the round's deadline and how it stands.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Bounty {
    pub deadline_ns: U64,
    pub status: BountyStatus,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct BountyStatus {
    pub state: String,
}

#[near]
impl Safe {
    /// Only the safe's own deployment initialises it: `new` runs in the same transaction as the code, either signed by
    /// the safe's account, whose key is then dropped, or sent by its parent account, the one that creates the safe as
    /// its sub-account (the season treasury makes every round's safe so, in one batch that adds no key). Nobody else
    /// can initialise a safe. `arbiter` is the bounty contract that will arm the safe for its round, `team` the one account
    /// whose round on it the safe takes; without them the safe is a practice safe, open at once.
    #[init]
    pub fn new(owner: AccountId, masks: Vec<AccountId>, arbiter: Option<AccountId>, team: Option<AccountId>) -> Self {
        let (me, by) = (env::current_account_id(), env::predecessor_account_id());
        require!(me == by || me.is_sub_account_of(&by), "only the safe itself or the account that makes it calls new");
        require!((1..=MAX_MASKS).contains(&masks.len()), "masks: 1 to 16 accounts");
        for (i, m) in masks.iter().enumerate() {
            require!(!masks[..i].contains(m), "a mask is listed twice");
        }
        require!(arbiter.is_some() == team.is_some(), "a safe of a round names its bounty contract and its team");
        require!(team.as_ref().is_none_or(|t| !masks.contains(t)), "the team cannot be a mask of its own safe");
        if env::signer_account_id() == me {
            log!("the safe drops the key that deployed it");
            let _ = Promise::new(me).delete_key(env::signer_account_pk());
        }
        Self {
            home: owner.clone(),
            owner,
            masks,
            moves: 0,
            last_ns: None,
            first: LookupMap::new(b"f"),
            arbiter,
            team,
            round: None,
            turn: None,
            turns: 0,
            seals: [NO_SEAL; MAX_MASKS],
            retiring: false,
        }
    }

    /// The bounty contract named at deployment arms the safe for one round, when the round opens: `bounty` is its id,
    /// `opens_ns` the end of its commit window, `masks` its masks, which must be exactly the safe's, and `team` who
    /// opened it, which must be the safe's team. Once, and only a safe that is its own owner and that nobody has moved.
    /// A safe that sent its own deletion takes no round: the round would stand on an account about to be gone.
    pub fn arm(&mut self, bounty: String, opens_ns: U64, masks: Vec<AccountId>, team: AccountId) {
        require!(!self.retiring, RETIRING);
        let by = env::predecessor_account_id();
        require!(self.arbiter.as_ref() == Some(&by), "only the bounty contract named at deployment arms the safe");
        require!(self.team.as_ref() == Some(&team), "only a round the safe's own team opens arms the safe");
        require!(self.round.is_none(), "the safe is armed for a round already");
        require!(self.home == env::current_account_id(), "a safe that is not its own owner takes no round");
        require!(self.moves == 0, "a safe that was moved takes no round");
        let (mut theirs, mut ours) = (masks, self.masks.clone());
        theirs.sort_unstable();
        ours.sort_unstable();
        require!(theirs == ours, "the round's masks are not the safe's");
        let now = env::block_timestamp();
        require!(opens_ns.0 > now, "the commit window is already over");
        event("armed", format!(r#"{{"bounty":"{}","opens_ns":"{}","team":"{}"}}"#, bounty, opens_ns.0, team));
        self.round = Some(Round { arbiter: by, bounty, opens_ns, armed_ns: U64(now) });
    }

    /// The bounty contract that armed the safe tells it a seal of its round: `mask` sealed a plan as seal `seq`. Only a
    /// mask that sealed moves the safe, in the order of the seals. Once per mask.
    pub fn queue(&mut self, bounty: String, mask: AccountId, seq: u32) {
        let round = self.round.as_ref().unwrap_or_else(|| env::panic_str("the safe waits for its round"));
        require!(env::predecessor_account_id() == round.arbiter, "only the bounty contract that armed the safe queues");
        require!(bounty == round.bounty, "a seal of another round");
        let i = self.place(&mask).unwrap_or_else(|| env::panic_str("not a mask of this safe"));
        require!(seq != NO_SEAL, "seq: a seal number");
        require!(self.seals[i] == NO_SEAL, "this mask is queued already");
        self.seals[i] = seq;
        event("sealed", format!(r#"{{"mask":"{}","seq":{}}}"#, mask, seq));
    }

    /// Hands the safe to a new owner.
    pub fn set_owner(&mut self, new_owner: AccountId) {
        let turn = self.turn_for_caller();
        self.begin(turn);
        log!("owner {} -> {}", self.owner, new_owner);
        self.owner = new_owner;
        self.moved();
    }

    /// The owner moves NEAR out of the safe.
    pub fn sweep(&mut self, to: AccountId, amount: U128) -> Promise {
        let turn = self.turn_for_caller();
        // A turn that starts with this call starts with the safe as its own owner again.
        let owner = if turn.is_some() { &self.home } else { &self.owner };
        require!(env::predecessor_account_id() == *owner, "owner only");
        require!(amount.0 > 0 && amount.0 <= self.available().0, "not that much in the safe");
        self.begin(turn);
        log!("sweep {} to {}", NearToken::from_yoctonear(amount.0).exact_amount_display(), to);
        self.moved();
        Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// The safe's team takes back what a round nobody won left in the safe: everything it can pay out (`available`),
    /// to the team. Only the team named at deployment, only a safe armed for a round, and only once the bounty
    /// contract that armed it has refunded that round's bounty and the claim grace after its deadline is over: the
    /// safe asks that contract (`on_bounty`). While the round is open, or after a mask's drain was confirmed and paid,
    /// the team takes nothing. It may be called again: each time it takes what is there.
    pub fn reclaim(&mut self) -> Promise {
        let team = self.team.clone().unwrap_or_else(|| env::panic_str("a practice safe has no team"));
        require!(env::predecessor_account_id() == team, "only the safe's team takes back what its round left");
        let round = self.round.clone().unwrap_or_else(|| env::panic_str("the safe took no round"));
        ext_arbiter::ext(round.arbiter)
            .with_static_gas(VIEW_GAS)
            .get(round.bounty)
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_BOUNTY_GAS).on_bounty(round.armed_ns.0))
    }

    /// The bounty contract's word on the round the safe is armed for. Refunded, with the claim grace over: what the
    /// safe can pay out goes to the team, and the answer comes once it is there. Anything else takes nothing.
    /// `armed_ns` is when the safe that asked was armed: an answer on its way to a safe that has since retired tells
    /// a new safe of the same name, armed at another moment, nothing about its own round.
    #[private]
    pub fn on_bounty(
        &mut self,
        #[serializer(borsh)] armed_ns: u64,
        #[callback_result] bounty: Result<Option<Bounty>, PromiseError>,
    ) -> PromiseOrValue<()> {
        let round = self.round.clone().unwrap_or_else(|| env::panic_str("the safe took no round"));
        require!(round.armed_ns.0 == armed_ns, ANOTHER_ROUND);
        let team = self.team.clone().unwrap_or_else(|| env::panic_str("a practice safe has no team"));
        let bounty = bounty.ok().flatten().unwrap_or_else(|| env::panic_str("the bounty contract did not answer"));
        match bounty.status.state.as_str() {
            "refunded" => {}
            "open" | "judging" => env::panic_str("the round is not over: its bounty is still open"),
            "drained" | "paid" => env::panic_str("a mask won the round: what it left in the safe stays"),
            _ => env::panic_str("the bounty contract does not say how the round ended"),
        }
        let deadline = bounty.deadline_ns.0;
        require!(env::block_timestamp() >= deadline.saturating_add(CLAIM_GRACE_NS), "the masks can still claim");
        let amount = self.available().0;
        event("reclaimed", format!(r#"{{"bounty":"{}","to":"{}","amount":"{}"}}"#, round.bounty, team, amount));
        if amount == 0 {
            return PromiseOrValue::Value(());
        }
        PromiseOrValue::Promise(Promise::new(team).transfer(NearToken::from_yoctonear(amount)))
    }

    /// The safe's team retires the safe: the safe deletes its own account, and its whole balance, the NEAR its code
    /// and state locked included, goes to the team. Only the team named at deployment, and never while the safe's
    /// round can still be played. A safe that took no round goes at once: nobody could move it, and no bounty stands
    /// on it. A safe armed for a round asks the bounty contract that armed it how the round ended (`on_retire`); the
    /// team's word is not enough. Nothing changes in the safe until that answer lets it go.
    pub fn retire(&mut self) -> Promise {
        let team = self.team.clone().unwrap_or_else(|| env::panic_str("a practice safe has no team"));
        require!(env::predecessor_account_id() == team, "only the safe's team retires it");
        let Some(round) = self.round.clone() else { return self.leave("", team) };
        ext_arbiter::ext(round.arbiter)
            .with_static_gas(VIEW_GAS)
            .get(round.bounty)
            .then(Self::ext(env::current_account_id()).with_static_gas(ON_RETIRE_GAS).on_retire(round.armed_ns.0))
    }

    /// The bounty contract's word on the round the safe is armed for, when the team retires the safe. The round is
    /// over, its bounty paid to the winner (`drained`, `paid`) or refunded to the team, and its deadline has passed:
    /// the safe goes, and all it holds goes to the team. Until the deadline the sealed masks still have their turns,
    /// whoever was paid, so the safe stays. An open round, no answer, or an answer the safe cannot read: the safe
    /// stays as it was. `armed_ns` is when the safe that asked was armed, as in `on_bounty`.
    #[private]
    pub fn on_retire(
        &mut self,
        #[serializer(borsh)] armed_ns: u64,
        #[callback_result] bounty: Result<Option<Bounty>, PromiseError>,
    ) -> Promise {
        let round = self.round.clone().unwrap_or_else(|| env::panic_str("the safe took no round"));
        require!(round.armed_ns.0 == armed_ns, ANOTHER_ROUND);
        let team = self.team.clone().unwrap_or_else(|| env::panic_str("a practice safe has no team"));
        let bounty = bounty.ok().flatten().unwrap_or_else(|| env::panic_str("the bounty contract did not answer"));
        match bounty.status.state.as_str() {
            "refunded" | "drained" | "paid" => {}
            "open" | "judging" => env::panic_str("the round is not over: its bounty is still open"),
            _ => env::panic_str("the bounty contract does not say how the round ended"),
        }
        require!(env::block_timestamp() >= bounty.deadline_ns.0, BEFORE_DEADLINE);
        self.leave(&round.bounty, team)
    }

    /// NEAR the safe can pay out: its balance minus what its own storage locks.
    pub fn available(&self) -> U128 {
        let locked = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
        U128(env::account_balance().as_yoctonear().saturating_sub(locked))
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn masks(&self) -> Vec<AccountId> {
        self.masks.clone()
    }

    /// The bounty contract that may arm the safe; `null` for a practice safe.
    pub fn arbiter(&self) -> Option<AccountId> {
        self.arbiter.clone()
    }

    /// The team whose round the safe takes; `null` for a practice safe.
    pub fn team(&self) -> Option<AccountId> {
        self.team.clone()
    }

    /// The round the safe is armed for; `null` until it is.
    pub fn get_round(&self) -> Option<Round> {
        self.round.clone()
    }

    /// The latest turn, which may be over: whose it is and until when.
    pub fn get_turn(&self) -> Option<Turn> {
        self.turn.clone()
    }

    /// The masks that sealed a plan, in the order they play.
    pub fn get_queue(&self) -> Vec<Queued> {
        let mut q: Vec<Queued> = (0..self.masks.len())
            .filter(|&i| self.seals[i] != NO_SEAL)
            .map(|i| Queued {
                mask: self.masks[i].clone(),
                seq: self.seals[i],
                slot_ns: U64(self.slot_opens(i)),
                closes_ns: U64(self.slot_closes(i)),
                played_ns: self.first.get(&self.masks[i]).copied().map(U64),
            })
            .collect();
        q.sort_by_key(|e| e.seq);
        q
    }

    /// Why `account_id` may not move the safe at this block; `null` if it may: its turn goes on, or its first move
    /// starts it.
    pub fn waits_for(&self, account_id: AccountId) -> Option<String> {
        self.check(&account_id, env::block_timestamp()).err().map(str::to_string)
    }

    /// How many moves so far, when the last one was, and when `account_id` first moved the safe.
    pub fn touches(&self, account_id: AccountId) -> Touches {
        Touches {
            moves: U64(self.moves),
            last_ns: self.last_ns.map(U64),
            first_ns: self.first.get(&account_id).copied().map(U64),
        }
    }

    /// Who may move the safe now: see `check`. Nothing changes here: a call that fails later starts no turn.
    fn turn_for_caller(&self) -> Option<Turn> {
        self.check(&env::predecessor_account_id(), env::block_timestamp()).unwrap_or_else(|why| env::panic_str(why))
    }

    /// Whether `who` may move the safe at `now`. Only a mask of the round, never before the round's commit window is
    /// over, only a mask that sealed a plan, in the order of the seals, and only in its own turn. `Ok(None)`: `who` goes
    /// on with its turn. `Ok(Some)`: the turn `who`'s first move starts, in which the safe is its own owner again and
    /// nobody else moves it.
    fn check(&self, who: &AccountId, now: u64) -> Result<Option<Turn>, &'static str> {
        let Some(i) = self.place(who) else { return Err("this safe is open to the round's masks only") };
        if self.arbiter.is_some() {
            let round = self.round.as_ref().ok_or("the safe waits for its round")?;
            if now < round.opens_ns.0 {
                return Err("the safe is locked until the commit window closes");
            }
            // A mask without a seal never gets in, so it is told so at once rather than asked to wait.
            if self.seals[i] == NO_SEAL {
                return Err("only a mask that sealed a plan moves the safe");
            }
        }
        if let Some(t) = &self.turn {
            if now < t.until_ns.0 {
                return if t.mask == *who { Ok(None) } else { Err(OTHERS_TURN) };
            }
        }
        if self.first.contains_key(who) {
            return Err("this mask has had its turn");
        }
        let mut until = now + TURN_NS;
        if self.arbiter.is_some() {
            if now < self.slot_opens(i) {
                return Err(EARLIER_SEAL);
            }
            // The first slot a later seal can still play in: this turn never reaches into it, and a seal whose own
            // slot is over waits until no such slot is left.
            if let Some(next) = self.later_slot(i, now) {
                if now >= self.slot_closes(i) {
                    return Err(SLOT_MISSED);
                }
                until = until.min(next);
            }
        }
        Ok(Some(Turn { n: U64(self.turns + 1), mask: who.clone(), from: U64(self.moves + 1), until_ns: U64(until) }))
    }

    /// The seal's rank: how many seals came before the one at place `i`.
    fn rank(&self, i: usize) -> u64 {
        (0..self.masks.len()).filter(|&j| self.seals[j] < self.seals[i]).count() as u64
    }

    /// When the sealed mask at place `i` may start its turn at the latest: at once once every earlier seal has had its
    /// turn, otherwise when its slot comes, `TURN_NS` after the window for each earlier seal.
    fn slot_opens(&self, i: usize) -> u64 {
        let opens = self.round.as_ref().map_or(0, |r| r.opens_ns.0);
        let earlier_played = (0..self.masks.len())
            .filter(|&j| self.seals[j] < self.seals[i])
            .all(|j| self.first.contains_key(&self.masks[j]));
        if earlier_played {
            return opens;
        }
        opens + TURN_NS * self.rank(i)
    }

    /// When the slot of the sealed mask at place `i` closes: `TURN_NS` after it comes at the latest.
    fn slot_closes(&self, i: usize) -> u64 {
        self.round.as_ref().map_or(0, |r| r.opens_ns.0) + TURN_NS * (self.rank(i) + 1)
    }

    /// The earliest start of a slot that a later seal than the one at place `i` can still play in at `now`: a seal that
    /// has not played and whose slot is not over. `None` when every later seal has played or missed its slot.
    fn later_slot(&self, i: usize, now: u64) -> Option<u64> {
        let opens = self.round.as_ref().map_or(0, |r| r.opens_ns.0);
        (0..self.masks.len())
            .filter(|&j| self.seals[j] != NO_SEAL && self.seals[j] > self.seals[i])
            .filter(|&j| !self.first.contains_key(&self.masks[j]) && now < self.slot_closes(j))
            .map(|j| opens + TURN_NS * self.rank(j))
            .min()
    }

    /// The safe deletes its own account and leaves everything to its team. Only the account itself can delete it, so
    /// the deletion is the safe's own promise to itself, and the safe sends it once: a second one could reach a new
    /// safe made under the same name. In the event `bounty` is the round's id, empty for a safe that took none, and
    /// `amount` the safe's balance as it goes.
    fn leave(&mut self, bounty: &str, team: AccountId) -> Promise {
        require!(!self.retiring, RETIRING);
        self.retiring = true;
        let amount = env::account_balance().as_yoctonear();
        event("retired", format!(r#"{{"bounty":"{}","to":"{}","amount":"{}"}}"#, bounty, team, amount));
        Promise::new(env::current_account_id()).delete_account(team)
    }

    fn place(&self, who: &AccountId) -> Option<usize> {
        self.masks.iter().position(|m| m == who)
    }

    /// Starts `turn`, if the call starts one: the safe is its own owner again.
    fn begin(&mut self, turn: Option<Turn>) {
        let Some(turn) = turn else { return };
        self.turns = turn.n.0;
        self.owner = self.home.clone();
        event(
            "turn",
            format!(
                r#"{{"turn":{},"by":"{}","from":{},"until_ns":"{}"}}"#,
                turn.n.0, turn.mask, turn.from.0, turn.until_ns.0
            ),
        );
        self.turn = Some(turn);
    }

    /// Counts a move and logs it as `EVENT_JSON:{"standard":"maskwars_safe","event":"move","data":{"n","by","turn"}}`.
    fn moved(&mut self) {
        let by = env::predecessor_account_id();
        let now = env::block_timestamp();
        self.moves += 1;
        self.last_ns = Some(now);
        if !self.first.contains_key(&by) {
            self.first.insert(by.clone(), now);
        }
        event("move", format!(r#"{{"n":{},"by":"{}","turn":{}}}"#, self.moves, by, self.turns));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const SAFE: &str = "safe-0001.maskwars.testnet";
    const BOUNTY: &str = "bounty.maskwars.testnet";
    const TEAM: &str = "maskwars.testnet";
    const NOVA: &str = "nova.maskwars.testnet";
    const ONYX: &str = "onyx.maskwars.testnet";
    const SCHEDULER: &str = "scheduler.maskwars.testnet";
    /// The commit window closes at 1000 s.
    const OPENS: u64 = 1_000_000_000_000;
    const S: u64 = 1_000_000_000;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn as_at(who: &str, now: u64) {
        let mut c = VMContextBuilder::new();
        c.current_account_id(acc(SAFE))
            .signer_account_id(acc(who))
            .predecessor_account_id(acc(who))
            .account_balance(NearToken::from_near(5))
            .storage_usage(100_000)
            .block_timestamp(now);
        testing_env!(c.build());
    }

    fn as_(who: &str) {
        as_at(who, 0);
    }

    /// A practice safe: no round, open at once.
    fn practice() -> Safe {
        as_(SAFE);
        Safe::new(acc("maskwars.testnet"), vec![acc(NOVA), acc(ONYX)], None, None)
    }

    /// A fresh safe of a round for `masks`: its own owner, armed only by the bounty contract for TEAM's round.
    fn fresh(masks: &[&str]) -> Safe {
        as_(SAFE);
        Safe::new(acc(SAFE), masks.iter().map(|m| acc(m)).collect(), Some(acc(BOUNTY)), Some(acc(TEAM)))
    }

    /// A safe of TEAM's round, armed by the bounty contract with the window closing at `OPENS`; nobody sealed yet.
    fn armed_for(masks: &[&str]) -> Safe {
        let mut s = fresh(masks);
        as_at(BOUNTY, 10 * S);
        s.arm("race-0004".into(), U64(OPENS), masks.iter().rev().map(|m| acc(m)).collect(), acc(TEAM));
        s
    }

    /// The bounty contract tells the safe a seal, in the commit window.
    fn sealed(s: &mut Safe, mask: &str, seq: u32) {
        as_at(BOUNTY, 20 * S);
        s.queue("race-0004".into(), acc(mask), seq);
    }

    /// NOVA and ONYX's round, both sealed: NOVA first.
    fn armed() -> Safe {
        let mut s = armed_for(&[NOVA, ONYX]);
        sealed(&mut s, NOVA, 0);
        sealed(&mut s, ONYX, 1);
        s
    }

    /// The contract's own panic message of a call, or nothing if it went through.
    fn panics<F: FnOnce()>(f: F) -> String {
        let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) else { return String::new() };
        let text = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()));
        let text = text.unwrap_or_default();
        match text.split_once("panic_msg: \"") {
            Some((_, rest)) => rest.trim_end_matches(" })").trim_end_matches('"').to_string(),
            None => text,
        }
    }

    fn events() -> Vec<Value> {
        get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|e| serde_json::from_str::<Value>(e).unwrap())
            .collect()
    }

    fn sweep_all(s: &mut Safe, who: &str, now: u64) {
        as_at(who, now);
        let _ = s.sweep(acc(who), U128(NearToken::from_near(3).as_yoctonear()));
    }

    /// The safe's whole state as stored on chain, Borsh.
    fn stored(s: &Safe) -> usize {
        near_sdk::borsh::to_vec(s).unwrap().len()
    }

    #[test]
    fn a_mask_of_the_race_takes_the_safe_through_the_planted_hole() {
        let mut s = practice();
        as_(NOVA);
        s.set_owner(acc(NOVA));
        assert_eq!(s.get_owner(), acc(NOVA));
        sweep_all(&mut s, NOVA, 0);
    }

    #[test]
    #[should_panic(expected = "this safe is open to the round's masks only")]
    fn a_stranger_cannot_use_the_hole() {
        let mut s = practice();
        as_("stranger.testnet");
        s.set_owner(acc("stranger.testnet"));
    }

    #[test]
    #[should_panic(expected = "owner only")]
    fn a_mask_cannot_sweep_without_the_hole() {
        let mut s = practice();
        as_(NOVA);
        let _ = s.sweep(acc(NOVA), U128(1));
    }

    #[test]
    #[should_panic(expected = "not that much in the safe")]
    fn the_safe_pays_only_what_it_has() {
        let mut s = practice();
        as_(NOVA);
        s.set_owner(acc(NOVA));
        let _ = s.sweep(acc(NOVA), U128(NearToken::from_near(6).as_yoctonear()));
    }

    #[test]
    fn the_safe_drops_its_deploy_key() {
        practice();
        assert!(get_logs().iter().any(|l| l == "the safe drops the key that deployed it"));
    }

    #[test]
    #[should_panic(expected = "masks: 1 to 16 accounts")]
    fn a_safe_is_for_a_race() {
        as_(SAFE);
        Safe::new(acc("maskwars.testnet"), vec![], None, None);
    }

    #[test]
    #[should_panic(expected = "a mask is listed twice")]
    fn a_mask_is_listed_once() {
        as_(SAFE);
        Safe::new(acc(SAFE), vec![acc(NOVA), acc(NOVA)], None, None);
    }

    #[test]
    fn a_safe_of_a_round_names_its_team_and_the_team_is_no_mask() {
        as_(SAFE);
        let two = || vec![acc(NOVA), acc(ONYX)];
        assert_eq!(
            panics(|| drop(Safe::new(acc(SAFE), two(), Some(acc(BOUNTY)), None))),
            "a safe of a round names its bounty contract and its team"
        );
        assert_eq!(
            panics(|| drop(Safe::new(acc(SAFE), two(), None, Some(acc(TEAM))))),
            "a safe of a round names its bounty contract and its team"
        );
        assert_eq!(
            panics(|| drop(Safe::new(acc(SAFE), two(), Some(acc(BOUNTY)), Some(acc(NOVA))))),
            "the team cannot be a mask of its own safe"
        );
        let s = fresh(&[NOVA, ONYX]);
        assert_eq!((s.arbiter(), s.team()), (Some(acc(BOUNTY)), Some(acc(TEAM))));
    }

    #[test]
    fn every_move_is_counted_logged_and_remembered() {
        let mut s = practice();
        let nova = acc(NOVA);
        assert_eq!(s.touches(nova.clone()), Touches { moves: U64(0), last_ns: None, first_ns: None });
        as_at(ONYX, 10);
        s.set_owner(acc(ONYX));
        as_at(NOVA, 10 + TURN_NS);
        s.set_owner(nova.clone());
        let e = events();
        assert_eq!(e[0]["event"], "turn");
        assert_eq!(
            e[0]["data"],
            serde_json::json!({ "turn": 2, "by": NOVA, "from": 2, "until_ns": (10 + 2 * TURN_NS).to_string() })
        );
        assert_eq!(e[1]["data"], serde_json::json!({ "n": 2, "by": NOVA, "turn": 2 }));
        sweep_all(&mut s, NOVA, 30 + TURN_NS);
        let e = events();
        assert_eq!(e.len(), 1, "a move inside a turn starts no new one");
        assert_eq!((e[0]["standard"].as_str(), e[0]["event"].as_str()), (Some(STANDARD), Some("move")));
        assert_eq!(e[0]["data"], serde_json::json!({ "n": 3, "by": NOVA, "turn": 2 }));
        assert_eq!(
            s.touches(nova),
            Touches { moves: U64(3), last_ns: Some(U64(30 + TURN_NS)), first_ns: Some(U64(10 + TURN_NS)) }
        );
        assert_eq!(s.touches(acc(ONYX)).first_ns, Some(U64(10)));
    }

    // H1: the safe is locked to its round.

    #[test]
    fn nobody_moves_a_round_safe_before_it_is_armed_or_before_the_window_closes() {
        let mut s = fresh(&[NOVA, ONYX]);
        as_at(NOVA, 5 * S);
        assert_eq!(panics(|| s.set_owner(acc(NOVA))), "the safe waits for its round");
        let mut s = armed();
        // A mask of the round in the commit window: no move, so no drain while plans are still being sealed.
        as_at(NOVA, OPENS - 1);
        assert_eq!(panics(|| s.set_owner(acc(NOVA))), "the safe is locked until the commit window closes");
        assert_eq!(s.touches(acc(NOVA)).moves, U64(0));
        as_at(NOVA, OPENS);
        s.set_owner(acc(NOVA));
        sweep_all(&mut s, NOVA, OPENS + S);
    }

    #[test]
    fn only_the_named_bounty_contract_arms_the_safe_once_for_its_masks() {
        let mut s = fresh(&[NOVA, ONYX]);
        let both = || vec![acc(NOVA), acc(ONYX)];
        as_at("team.testnet", S);
        assert_eq!(
            panics(|| s.arm("race-0004".into(), U64(OPENS), both(), acc(TEAM))),
            "only the bounty contract named at deployment arms the safe"
        );
        as_at(BOUNTY, S);
        assert_eq!(
            panics(|| s.arm("race-0004".into(), U64(OPENS), vec![acc(NOVA)], acc(TEAM))),
            "the round's masks are not the safe's"
        );
        assert_eq!(
            panics(|| s.arm("race-0004".into(), U64(S), both(), acc(TEAM))),
            "the commit window is already over"
        );
        s.arm("race-0004".into(), U64(OPENS), both(), acc(TEAM));
        assert_eq!(
            s.get_round(),
            Some(Round { arbiter: acc(BOUNTY), bounty: "race-0004".into(), opens_ns: U64(OPENS), armed_ns: U64(S) })
        );
        assert_eq!(
            events()[0]["data"],
            serde_json::json!({ "bounty": "race-0004", "opens_ns": OPENS.to_string(), "team": TEAM })
        );
        assert_eq!(
            panics(|| s.arm("race-0005".into(), U64(2 * OPENS), both(), acc(TEAM))),
            "the safe is armed for a round already"
        );
        // A practice safe takes no round, and neither does a safe owned by someone else.
        let mut p = practice();
        as_at(BOUNTY, S);
        assert!(panics(|| p.arm("race-0004".into(), U64(OPENS), both(), acc(TEAM))).starts_with("only the bounty"));
        as_(SAFE);
        let mut t = Safe::new(acc("team.testnet"), both(), Some(acc(BOUNTY)), Some(acc(TEAM)));
        as_at(BOUNTY, S);
        assert_eq!(
            panics(|| t.arm("race-0004".into(), U64(OPENS), both(), acc(TEAM))),
            "a safe that is not its own owner takes no round"
        );
    }

    #[test]
    fn a_round_someone_else_opens_on_the_safe_does_not_arm_it() {
        // Review finding 1: anyone could open a round of their own on a fresh safe before the team did; the bounty
        // contract armed the safe for it, and the team's own round then found the safe taken. The bounty contract
        // names who opened the round, and the safe takes only its own team's.
        let mut s = fresh(&[NOVA, ONYX]);
        as_at(BOUNTY, S);
        assert_eq!(
            panics(|| s.arm("race-9999".into(), U64(OPENS), vec![acc(NOVA), acc(ONYX)], acc("intruder.testnet"))),
            "only a round the safe's own team opens arms the safe"
        );
        assert_eq!(s.get_round(), None, "the safe still waits for its team's round");
        s.arm("race-0004".into(), U64(OPENS), vec![acc(NOVA), acc(ONYX)], acc(TEAM));
        assert_eq!(s.get_round().unwrap().bounty, "race-0004");
    }

    #[test]
    fn only_the_bounty_contract_that_armed_the_safe_queues_seals_of_its_round() {
        let mut s = armed_for(&[NOVA, ONYX]);
        as_at(NOVA, 20 * S);
        assert_eq!(
            panics(|| s.queue("race-0004".into(), acc(NOVA), 0)),
            "only the bounty contract that armed the safe queues"
        );
        as_at(BOUNTY, 20 * S);
        assert_eq!(panics(|| s.queue("race-0005".into(), acc(NOVA), 0)), "a seal of another round");
        assert_eq!(panics(|| s.queue("race-0004".into(), acc("x.testnet"), 0)), "not a mask of this safe");
        s.queue("race-0004".into(), acc(ONYX), 3);
        assert_eq!(events()[0]["data"], serde_json::json!({ "mask": ONYX, "seq": 3 }));
        assert_eq!(panics(|| s.queue("race-0004".into(), acc(ONYX), 4)), "this mask is queued already");
        s.queue("race-0004".into(), acc(NOVA), 5);
        let q = s.get_queue();
        assert_eq!(q.iter().map(|e| (e.mask.as_str(), e.seq)).collect::<Vec<_>>(), [(ONYX, 3), (NOVA, 5)]);
        assert_eq!((q[0].slot_ns, q[1].slot_ns), (U64(OPENS), U64(OPENS + TURN_NS)));
        let mut p = fresh(&[NOVA, ONYX]);
        as_at(BOUNTY, 20 * S);
        assert_eq!(panics(|| p.queue("race-0004".into(), acc(NOVA), 0)), "the safe waits for its round");
    }

    #[test]
    fn a_mask_that_sealed_nothing_never_moves_the_safe() {
        // Review finding 3: after the window the first turn went to whoever played first, so a mask of the list that
        // sealed nothing could empty the safe ahead of every sealed plan. Now only a sealed mask moves the safe.
        let mut s = armed_for(&[NOVA, ONYX]);
        sealed(&mut s, NOVA, 0);
        as_at(ONYX, OPENS);
        assert_eq!(panics(|| s.set_owner(acc(ONYX))), "only a mask that sealed a plan moves the safe");
        assert_eq!(panics(|| sweep_all(&mut s, ONYX, OPENS)), "only a mask that sealed a plan moves the safe");
        assert_eq!(s.waits_for(acc(ONYX)).as_deref(), Some("only a mask that sealed a plan moves the safe"));
        assert_eq!(s.touches(acc(ONYX)).moves, U64(0));
        as_at(NOVA, OPENS);
        assert_eq!(s.waits_for(acc(NOVA)), None);
        s.set_owner(acc(NOVA));
        // While NOVA plays, ONYX is told at once that it never gets in, not asked to wait.
        as_at(ONYX, OPENS + S);
        assert_eq!(s.waits_for(acc(ONYX)).as_deref(), Some("only a mask that sealed a plan moves the safe"));
        sweep_all(&mut s, NOVA, OPENS + S);
    }

    #[test]
    fn the_earlier_seal_plays_first_and_a_later_one_waits_its_slot() {
        // Review finding 3: a later seal could take the loot first, and the earlier seal's plan then had nothing left
        // to drain. Now seal #0 has the safe first; seal #1 waits until #0 has had its turn, or until its slot comes.
        let mut s = armed();
        as_at(ONYX, OPENS);
        assert_eq!(panics(|| s.set_owner(acc(ONYX))), EARLIER_SEAL);
        assert_eq!(s.waits_for(acc(ONYX)).as_deref(), Some(EARLIER_SEAL));
        // NOVA plays its turn; once that turn is over, ONYX goes at once, before its slot.
        as_at(NOVA, OPENS + S);
        s.set_owner(acc(NOVA));
        sweep_all(&mut s, NOVA, OPENS + 2 * S);
        as_at(ONYX, OPENS + 2 * S);
        assert_eq!(panics(|| s.set_owner(acc(ONYX))), OTHERS_TURN);
        as_at(ONYX, OPENS + S + TURN_NS);
        assert_eq!(s.get_queue()[1].slot_ns, U64(OPENS));
        s.set_owner(acc(ONYX));
    }

    #[test]
    fn an_earlier_seal_that_never_plays_holds_the_next_up_for_one_turn_at_most() {
        let mut s = armed();
        as_at(ONYX, OPENS + TURN_NS - 1);
        assert_eq!(panics(|| s.set_owner(acc(ONYX))), EARLIER_SEAL);
        as_at(ONYX, OPENS + TURN_NS);
        s.set_owner(acc(ONYX));
        // The earlier seal still has its place: it plays once ONYX's turn is over.
        as_at(NOVA, OPENS + TURN_NS + S);
        assert_eq!(panics(|| s.set_owner(acc(NOVA))), OTHERS_TURN);
        as_at(NOVA, OPENS + 2 * TURN_NS);
        s.set_owner(acc(NOVA));
    }

    #[test]
    fn seals_never_grow_what_the_safe_stores() {
        // Review finding 2: every seal used to add to the safe's storage after a mask had sealed the sweep it would
        // ask for. The queue is a fixed array: the state is as big before the seals as after them.
        let masks = ["a1.testnet", "b2.testnet", "c3.testnet", "d4.testnet", "e5.testnet", "f6.testnet"];
        let mut s = armed_for(&masks);
        let before = stored(&s);
        for (seq, m) in masks.iter().enumerate() {
            sealed(&mut s, m, seq as u32);
        }
        assert_eq!(stored(&s), before);
    }

    #[test]
    fn a_turn_keeps_everyone_else_off_the_safe() {
        let mut s = armed();
        as_at(NOVA, OPENS);
        s.set_owner(acc(NOVA));
        // ONYX's slot comes while NOVA still plays: its call fails and spoils nothing.
        as_at(ONYX, OPENS + TURN_NS - S);
        assert_eq!(panics(|| s.set_owner(acc(ONYX))), OTHERS_TURN);
        sweep_all(&mut s, NOVA, OPENS + 2 * S);
        assert_eq!(s.get_turn().unwrap().mask, acc(NOVA));
        assert_eq!(s.touches(acc(ONYX)).first_ns, None, "ONYX has not had its turn");
    }

    #[test]
    fn every_turn_starts_from_the_safe_as_the_round_left_it() {
        // A saboteur moves first after the window and stops; a twin hands the safe to a gambler that sealed a bare
        // sweep. Neither spoils a plan, and neither carries over into another mask's turn.
        let gambler = "gambler.maskwars.testnet";
        let mut s = armed_for(&[NOVA, ONYX, gambler]);
        sealed(&mut s, ONYX, 0);
        sealed(&mut s, gambler, 1);
        sealed(&mut s, NOVA, 2);
        as_at(ONYX, OPENS);
        s.set_owner(acc(gambler));
        assert_eq!(s.get_owner(), acc(gambler));
        // The gambler's turn: the safe is its own owner again, and the bare sweep fails.
        as_at(gambler, OPENS + TURN_NS);
        assert_eq!(panics(|| drop(s.sweep(acc(gambler), U128(1)))), "owner only");
        // NOVA's turn: its whole plan from the first move.
        as_at(NOVA, OPENS + 2 * TURN_NS);
        s.set_owner(acc(NOVA));
        let turn = events()[0]["data"].clone();
        assert_eq!(turn["turn"], 2);
        assert_eq!(turn["from"], 2, "the failed sweep was no move");
        sweep_all(&mut s, NOVA, OPENS + 2 * TURN_NS + S);
    }

    // The hard slot of each seal (second security review): an earlier seal could start its turn at any moment, even
    // just before a later seal's slot, and hold the safe for a whole turn into it; several such seals added up, and an
    // honest later seal no longer played and revealed in time.

    #[test]
    fn an_early_seal_that_starts_just_before_a_later_slot_does_not_hold_the_safe_into_it() {
        let mut s = armed();
        // NOVA (#0) waits to the last second of its slot and starts its turn there.
        as_at(NOVA, OPENS + TURN_NS - S);
        s.set_owner(acc(NOVA));
        assert_eq!(s.get_turn().unwrap().until_ns, U64(OPENS + TURN_NS), "the turn ends where ONYX's slot starts");
        // ONYX (#1) starts at its slot, as the rules promise, and NOVA cannot finish its plan in ONYX's slot.
        as_at(ONYX, OPENS + TURN_NS);
        assert_eq!(s.waits_for(acc(ONYX)), None);
        s.set_owner(acc(ONYX));
        assert_eq!(panics(|| sweep_all(&mut s, NOVA, OPENS + TURN_NS + S)), OTHERS_TURN);
        sweep_all(&mut s, ONYX, OPENS + TURN_NS + S);
    }

    #[test]
    fn two_saboteurs_cannot_push_the_last_seal_past_the_reveal_window() {
        // Three masks, so the bounty contract asks for a reveal window of 3 minutes per mask and 3 more: it ends
        // 4 turns after the commit window. Two saboteurs sealed first and the honest finder last.
        let (sab1, sab2) = ("sab1.maskwars.testnet", "sab2.maskwars.testnet");
        let mut s = armed_for(&[sab1, sab2, NOVA]);
        sealed(&mut s, sab1, 0);
        sealed(&mut s, sab2, 1);
        sealed(&mut s, NOVA, 2);
        let reveal_until = OPENS + 4 * TURN_NS;
        let slot = OPENS + 2 * TURN_NS;
        assert_eq!(s.get_queue()[2].slot_ns, U64(slot));
        // The first saboteur waits until just before the finder's slot to start its turn: its own slot is over.
        as_at(sab1, OPENS + 2 * TURN_NS - S);
        assert_eq!(panics(|| s.set_owner(acc(sab1))), SLOT_MISSED);
        assert_eq!(s.waits_for(acc(sab1)).as_deref(), Some(SLOT_MISSED));
        // Each saboteur starts as late as its own slot allows.
        as_at(sab1, OPENS + TURN_NS - S);
        s.set_owner(acc(sab1));
        as_at(sab2, OPENS + 2 * TURN_NS - S);
        s.set_owner(acc(sab2));
        // The finder still starts at its slot, plays its whole turn and has a whole turn left to reveal.
        as_at(NOVA, slot - S);
        assert_eq!(s.waits_for(acc(NOVA)).as_deref(), Some(OTHERS_TURN));
        as_at(NOVA, slot);
        s.set_owner(acc(NOVA));
        let turn = s.get_turn().unwrap();
        assert_eq!((turn.mask.as_str(), turn.until_ns), (NOVA, U64(slot + TURN_NS)));
        assert!(turn.until_ns.0 + TURN_NS <= reveal_until);
        sweep_all(&mut s, NOVA, slot + S);
    }

    #[test]
    fn a_seal_that_missed_its_slot_plays_once_no_later_seal_can_play_in_its_own() {
        let mut s = armed();
        // NOVA (#0) missed its slot. While ONYX's slot is open NOVA waits; ONYX plays and NOVA goes after it.
        as_at(NOVA, OPENS + TURN_NS + S);
        assert_eq!(panics(|| s.set_owner(acc(NOVA))), SLOT_MISSED);
        as_at(ONYX, OPENS + TURN_NS + S);
        s.set_owner(acc(ONYX));
        as_at(NOVA, OPENS + 2 * TURN_NS + S);
        s.set_owner(acc(NOVA));
        // Had ONYX never played, NOVA would go once ONYX's slot is over as well.
        let mut s = armed();
        as_at(NOVA, OPENS + 2 * TURN_NS - S);
        assert_eq!(panics(|| s.set_owner(acc(NOVA))), SLOT_MISSED);
        as_at(NOVA, OPENS + 2 * TURN_NS);
        s.set_owner(acc(NOVA));
        // With no later seal left to play, a turn lasts its whole length.
        assert_eq!(s.get_turn().unwrap().until_ns, U64(OPENS + 3 * TURN_NS));
    }

    #[test]
    fn the_queue_shows_when_each_slot_opens_and_closes() {
        let s = armed();
        let q = s.get_queue();
        assert_eq!((q[0].slot_ns, q[0].closes_ns), (U64(OPENS), U64(OPENS + TURN_NS)));
        assert_eq!((q[1].slot_ns, q[1].closes_ns), (U64(OPENS + TURN_NS), U64(OPENS + 2 * TURN_NS)));
    }

    #[test]
    fn only_the_safe_itself_or_the_account_that_makes_it_calls_new() {
        let two = || vec![acc(NOVA), acc(ONYX)];
        // The season treasury makes s0001.<season> in one batch and calls new from its own account.
        let season = "season.maskwars.testnet";
        let mut c = VMContextBuilder::new();
        c.current_account_id(acc(&format!("s0001.{season}")))
            .signer_account_id(acc(SCHEDULER))
            .predecessor_account_id(acc(season));
        testing_env!(c.build());
        let s = Safe::new(acc(&format!("s0001.{season}")), two(), Some(acc(BOUNTY)), Some(acc(season)));
        assert_eq!(s.team(), Some(acc(season)));
        assert!(!get_logs().iter().any(|l| l.contains("drops the key")), "the scheduler's key is not the safe's");
        // Nobody else: not a stranger, not the parent's parent.
        for who in ["stranger.testnet", "maskwars.testnet"] {
            let mut c = VMContextBuilder::new();
            c.current_account_id(acc(&format!("s0001.{season}")))
                .signer_account_id(acc(who))
                .predecessor_account_id(acc(who));
            testing_env!(c.build());
            assert_eq!(
                panics(|| drop(Safe::new(acc(SAFE), two(), Some(acc(BOUNTY)), Some(acc(season))))),
                "only the safe itself or the account that makes it calls new"
            );
        }
    }

    // What happens to the safe after its round (`reclaim`, `retire`) is tested in tests/after_round.rs.
    mod after_round;

    #[test]
    fn a_mask_has_one_turn() {
        let mut s = armed();
        as_at(NOVA, OPENS);
        s.set_owner(acc(NOVA));
        // After its turn NOVA cannot come back for another one, so a squatter cannot hold the safe for long.
        as_at(NOVA, OPENS + TURN_NS);
        assert_eq!(panics(|| s.set_owner(acc(NOVA))), "this mask has had its turn");
        as_at(ONYX, OPENS + TURN_NS);
        s.set_owner(acc(ONYX));
        // Nor can it keep playing once its own turn is over.
        as_at(ONYX, OPENS + 2 * TURN_NS);
        assert_eq!(panics(|| drop(s.sweep(acc(ONYX), U128(1)))), "this mask has had its turn");
    }
}
