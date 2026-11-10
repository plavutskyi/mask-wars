//! Yield pool. Members own it in whole shares: one share was 1 NEAR at launch, and the rewards the pool earned since
//! made every share worth more. A member puts NEAR in for shares at the current price (`deposit`) and takes NEAR out
//! either by shares (`redeem`) or by amount (`withdraw`). Everything the pool can pay out belongs to its shares.
//!
//! Training target of MASK WARS: it holds test NEAR, and one hole in it is planted on purpose.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    shares: LookupMap<AccountId, u64>,
    total_shares: u64,
    race: Race,
}

#[near]
impl Pool {
    /// Opens the pool with the shares its launch members hold.
    #[init]
    pub fn new(owner: AccountId, masks: Vec<AccountId>, shares: Vec<(AccountId, u64)>) -> Self {
        let race = Race::new(owner, masks);
        let mut book = LookupMap::new(b"s");
        let mut total: u64 = 0;
        for (member, n) in shares {
            total += n;
            book.insert(member, n);
        }
        require!(total > 0, "the pool starts with shares");
        Self { shares: book, total_shares: total, race }
    }

    /// Buys shares with the attached NEAR at the current price, rounded down. Returns the shares bought.
    #[payable]
    pub fn deposit(&mut self) -> u64 {
        self.race.enter();
        let amount = env::attached_deposit().as_yoctonear();
        // The balance already holds the deposit; the price is what the pool held before it.
        let assets = spendable() - amount;
        let bought = to_shares(amount * u128::from(self.total_shares) / assets);
        require!(bought > 0, "too little for one share");
        let who = env::predecessor_account_id();
        let mine = self.shares_of(who.clone()) + bought;
        self.shares.insert(who, mine);
        self.total_shares += bought;
        self.race.moved();
        bought
    }

    /// Sells `shares` of the caller's for their part of the pool, rounded down.
    pub fn redeem(&mut self, shares: u64) -> Promise {
        self.race.enter();
        let who = env::predecessor_account_id();
        let mine = self.shares_of(who.clone());
        require!(shares > 0 && shares <= mine, "not enough shares");
        let amount = u128::from(shares) * spendable() / u128::from(self.total_shares);
        self.burn(&who, mine, shares);
        self.race.moved();
        self.pay(who, amount)
    }

    /// Takes `amount` yoctoNEAR out of the pool and burns the caller's shares it was worth.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.race.enter();
        let assets = spendable();
        require!(amount.0 > 0 && amount.0 <= assets, "not that much in the pool");
        let who = env::predecessor_account_id();
        let mine = self.shares_of(who.clone());
        let burn = to_shares(amount.0 * u128::from(self.total_shares) / assets);
        require!(burn <= mine, "not enough shares");
        self.burn(&who, mine, burn);
        self.race.moved();
        self.pay(who, amount.0)
    }

    pub fn shares_of(&self, account_id: AccountId) -> u64 {
        self.shares.get(&account_id).copied().unwrap_or(0)
    }

    pub fn total_shares(&self) -> u64 {
        self.total_shares
    }

    /// Everything the pool holds for its shares, yoctoNEAR.
    pub fn total_assets(&self) -> U128 {
        U128(spendable())
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
    fn burn(&mut self, who: &AccountId, mine: u64, shares: u64) {
        if mine == shares {
            self.shares.remove(who);
        } else {
            self.shares.insert(who.clone(), mine - shares);
        }
        self.total_shares -= shares;
    }

    fn pay(&self, to: AccountId, amount: u128) -> Promise {
        log!("{} takes {}", to, NearToken::from_yoctonear(amount).exact_amount_display());
        Promise::new(to).transfer(NearToken::from_yoctonear(amount))
    }
}

fn to_shares(n: u128) -> u64 {
    u64::try_from(n).unwrap_or_else(|_| env::panic_str("too many shares"))
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
