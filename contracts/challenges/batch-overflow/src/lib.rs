//! Savings vault for the masks of a race. Members keep credit here and withdraw it, and they gift credit to each other
//! in batches: tips, payroll, prize splits. Gifts come in whole milliNEAR.
//!
//! Training target of MASK WARS: it holds test NEAR, and one hole in it is planted on purpose.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, NearToken, PanicOnDefault, Promise};

/// 0.001 NEAR in yoctoNEAR.
pub const MILLI: u128 = 1_000_000_000_000_000_000_000;
/// Receivers in one batch.
pub const MAX_BATCH: usize = 16;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    credits: LookupMap<AccountId, u128>,
    race: Race,
}

#[near]
impl Vault {
    /// Opens the vault with its members' credit. It must fit in what the vault holds.
    #[init]
    pub fn new(owner: AccountId, masks: Vec<AccountId>, credits: Vec<(AccountId, U128)>) -> Self {
        let race = Race::new(owner, masks);
        let mut book = LookupMap::new(b"c");
        let mut total: u128 = 0;
        for (member, amount) in credits {
            total += amount.0;
            book.insert(member, amount.0);
        }
        require!(total <= spendable(), "the vault cannot cover that credit");
        Self { credits: book, race }
    }

    /// Adds the attached NEAR to the caller's credit.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        self.race.enter();
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        let who = env::predecessor_account_id();
        let credit = self.credit(&who) + amount;
        self.credits.insert(who, credit);
        self.race.moved();
        U128(credit)
    }

    /// Sends part of the caller's own credit back to the caller.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.race.enter();
        let who = env::predecessor_account_id();
        let credit = self.credit(&who);
        require!(amount.0 > 0 && amount.0 <= credit, "not enough credit");
        self.credits.insert(who.clone(), credit - amount.0);
        self.race.moved();
        Promise::new(who).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Gives `each` yoctoNEAR of the caller's credit to every account in `to`.
    pub fn gift(&mut self, to: Vec<AccountId>, each: U128) {
        self.race.enter();
        require!((1..=MAX_BATCH).contains(&to.len()), "1 to 16 receivers");
        require!(each.0 > 0 && each.0.is_multiple_of(MILLI), "gifts come in whole milliNEAR");
        // The batch is checked in whole milliNEAR: a u32 counts past 4 million NEAR, more than this vault will hold.
        let each_milli = (each.0 / MILLI) as u32;
        let total = u128::from(each_milli) * to.len() as u128 * MILLI;
        let who = env::predecessor_account_id();
        let credit = self.credit(&who);
        require!(total <= credit, "not enough credit");
        self.credits.insert(who.clone(), credit - total);
        for receiver in to {
            let credit = self.credit(&receiver) + each.0;
            self.credits.insert(receiver, credit);
        }
        self.race.moved();
        log!("{} gifted {} each", who, NearToken::from_yoctonear(each.0).exact_amount_display());
    }

    pub fn credit_of(&self, account_id: AccountId) -> U128 {
        U128(self.credit(&account_id))
    }

    /// NEAR the vault can pay out: its balance minus what its own storage locks.
    pub fn available(&self) -> U128 {
        U128(spendable())
    }

    pub fn get_owner(&self) -> AccountId {
        self.race.owner().clone()
    }

    pub fn masks(&self) -> Vec<AccountId> {
        self.race.masks()
    }

    /// How many moves so far, when the last one was, and when `account_id` first moved the vault.
    pub fn touches(&self, account_id: AccountId) -> Touches {
        self.race.touches(account_id)
    }
}

impl Vault {
    fn credit(&self, who: &AccountId) -> u128 {
        self.credits.get(who).copied().unwrap_or(0)
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
