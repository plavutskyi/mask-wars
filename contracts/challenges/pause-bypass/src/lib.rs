//! Rewards pool for the masks of a race. The team funds it when it deploys the pool and allots each member a share of
//! the rewards. A member claims its allotted rewards with `claim`; a keeper claims them for a member with `claim_for`,
//! for members that hold no NEAR for gas. Neither pays a member more than it was allotted.
//!
//! The pool was paused after an incident and stays paused until its members move to v2: while it is paused, no reward
//! leaves it.
//!
//! Training target of MASK WARS: it holds test NEAR, and one hole in it is planted on purpose.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    paused: bool,
    /// Rewards allotted to each member, yoctoNEAR.
    allotted: LookupMap<AccountId, u128>,
    /// Rewards each member has been paid so far, yoctoNEAR.
    claimed: LookupMap<AccountId, u128>,
    race: Race,
}

#[near]
impl Pool {
    /// Opens the pool paused, as it has been since the incident. The allotments must fit in what the pool holds.
    #[init]
    pub fn new(owner: AccountId, masks: Vec<AccountId>, allotments: Vec<(AccountId, U128)>) -> Self {
        let race = Race::new(owner, masks);
        let mut allotted = LookupMap::new(b"a");
        let mut total: u128 = 0;
        for (member, amount) in allotments {
            total += amount.0;
            allotted.insert(member, amount.0);
        }
        require!(total <= spendable(), "the pool cannot cover its allotments");
        Self { paused: true, allotted, claimed: LookupMap::new(b"c"), race }
    }

    /// Claims part of the caller's own allotted rewards.
    pub fn claim(&mut self, amount: U128) -> Promise {
        self.race.enter();
        self.when_running();
        self.race.moved();
        self.pay(env::predecessor_account_id(), amount.0)
    }

    /// A keeper claims part of a member's allotted rewards for it; they go to the member.
    pub fn claim_for(&mut self, member: AccountId, amount: U128) -> Promise {
        self.race.enter();
        self.race.moved();
        self.pay(member, amount.0)
    }

    /// The owner stops every claim.
    pub fn pause(&mut self) {
        self.race.enter();
        self.only_owner();
        self.race.moved();
        self.paused = true;
        log!("the pool is paused");
    }

    /// The owner lets claims run again.
    pub fn unpause(&mut self) {
        self.race.enter();
        self.only_owner();
        self.race.moved();
        self.paused = false;
        log!("the pool runs again");
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn allotted_to(&self, account_id: AccountId) -> U128 {
        U128(self.allotted.get(&account_id).copied().unwrap_or(0))
    }

    pub fn claimed_by(&self, account_id: AccountId) -> U128 {
        U128(self.claimed.get(&account_id).copied().unwrap_or(0))
    }

    /// NEAR the pool can pay out: its balance minus what its own storage locks.
    pub fn available(&self) -> U128 {
        U128(spendable())
    }

    pub fn get_owner(&self) -> AccountId {
        self.race.owner().clone()
    }

    pub fn masks(&self) -> Vec<AccountId> {
        self.race.masks()
    }

    /// How many moves so far, when the last one was, and when `account_id` first moved the pool.
    pub fn touches(&self, account_id: AccountId) -> Touches {
        self.race.touches(account_id)
    }
}

impl Pool {
    fn when_running(&self) {
        require!(!self.paused, "the pool is paused");
    }

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == *self.race.owner(), "owner only");
    }

    /// Pays `amount` of `to`'s rewards, never more than it was allotted.
    fn pay(&mut self, to: AccountId, amount: u128) -> Promise {
        require!(amount > 0 && amount <= spendable(), "not that much in the pool");
        let claimed = self.claimed.get(&to).copied().unwrap_or(0) + amount;
        require!(claimed <= self.allotted.get(&to).copied().unwrap_or(0), "more than this member was allotted");
        self.claimed.insert(to.clone(), claimed);
        log!("{} claimed {}", to, NearToken::from_yoctonear(amount).exact_amount_display());
        Promise::new(to).transfer(NearToken::from_yoctonear(amount))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The race: the same in every arena safe. Only the race's masks and the owner get in, every call that changes the safe
// is a numbered move, and the safe drops the key that deployed it.
// ---------------------------------------------------------------------------------------------------------------------

/// Masks in one race.
pub const MAX_MASKS: usize = 16;

/// Who may move the safe, and the moves so far.
#[near(serializers = [borsh])]
pub struct Race {
    owner: AccountId,
    masks: Vec<AccountId>,
    /// Moves so far; the next one gets this number plus one.
    moves: u64,
    /// When anyone last moved the safe, ns.
    last_ns: Option<u64>,
    /// When each account first moved the safe, ns.
    first: LookupMap<AccountId, u64>,
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

impl Race {
    /// Deployed with `new` in the same transaction, the safe throws away the key that deployed it: from then on only
    /// its code moves its NEAR.
    pub fn new(owner: AccountId, masks: Vec<AccountId>) -> Self {
        require!((1..=MAX_MASKS).contains(&masks.len()), "masks: 1 to 16 accounts");
        let me = env::current_account_id();
        if env::signer_account_id() == me {
            log!("the safe drops the key that deployed it");
            let _ = Promise::new(me).delete_key(env::signer_account_pk());
        }
        Self { owner, masks, moves: 0, last_ns: None, first: LookupMap::new(b"f") }
    }

    /// Strangers on the public network cannot get ahead of the race: every call that changes the safe comes from the
    /// owner or a mask of the race.
    pub fn enter(&self) {
        let who = env::predecessor_account_id();
        require!(who == self.owner || self.masks.contains(&who), "this safe is open to the race's masks only");
    }

    /// Counts a move and logs it as `EVENT_JSON:{"standard":"maskwars_safe","event":"move","data":{"n","by"}}`.
    pub fn moved(&mut self) {
        let by = env::predecessor_account_id();
        let now = env::block_timestamp();
        self.moves += 1;
        self.last_ns = Some(now);
        if !self.first.contains_key(&by) {
            self.first.insert(by.clone(), now);
        }
        log!(
            r#"EVENT_JSON:{{"standard":"maskwars_safe","version":"1.0.0","event":"move","data":{{"n":{},"by":"{}"}}}}"#,
            self.moves,
            by
        );
    }

    pub fn owner(&self) -> &AccountId {
        &self.owner
    }

    pub fn masks(&self) -> Vec<AccountId> {
        self.masks.clone()
    }

    /// How many moves so far, when the last one was, and when `account_id` first moved the safe.
    pub fn touches(&self, account_id: AccountId) -> Touches {
        Touches {
            moves: U64(self.moves),
            last_ns: self.last_ns.map(U64),
            first_ns: self.first.get(&account_id).copied().map(U64),
        }
    }
}

/// NEAR the safe can pay out: its balance minus what its own storage locks.
pub fn spendable() -> u128 {
    let locked = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage());
    env::account_balance().as_yoctonear().saturating_sub(locked)
}
