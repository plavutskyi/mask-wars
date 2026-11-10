//! Payroll vault. The owner pays salaries into members' credit, and members withdraw it. The vault also acts for its
//! members on other contracts with `relay`: it claims an airdrop the vault is eligible for, it votes in a DAO the vault
//! belongs to. A relayed call carries no NEAR.
//!
//! Training target of MASK WARS: it holds test NEAR, and one hole in it is planted on purpose.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::Value;
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

const BOOK_GAS: Gas = Gas::from_tgas(5);
const RELAY_GAS: Gas = Gas::from_tgas(20);
/// Salaries in one payroll run.
pub const MAX_PAYROLL: usize = 16;

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

    /// The owner pays salaries. Each one is booked in a receipt of its own, so one bad entry does not fail the rest.
    pub fn pay_salaries(&mut self, salaries: Vec<(AccountId, U128)>) {
        self.race.enter();
        require!(env::predecessor_account_id() == *self.race.owner(), "owner only");
        require!((1..=MAX_PAYROLL).contains(&salaries.len()), "1 to 16 salaries");
        self.race.moved();
        let me = env::current_account_id();
        for (member, amount) in salaries {
            let _ = Self::ext(me.clone()).with_static_gas(BOOK_GAS).book(member, amount);
        }
    }

    /// Books a salary into a member's credit. Only the vault itself: salaries go through `pay_salaries`.
    #[private]
    pub fn book(&mut self, member: AccountId, amount: U128) {
        let credit = self.credit(&member) + amount.0;
        self.credits.insert(member.clone(), credit);
        log!("salary of {} booked for {}", NearToken::from_yoctonear(amount.0).exact_amount_display(), member);
    }

    /// Calls `method` on `receiver` from the vault's own account, with `args` as JSON and no NEAR attached.
    pub fn relay(&mut self, receiver: AccountId, method: String, args: Value) -> Promise {
        self.race.enter();
        require!(!method.is_empty(), "name the method");
        self.race.moved();
        log!("relay {} on {}", method, receiver);
        Promise::new(receiver).function_call(
            method,
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            RELAY_GAS,
        )
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
