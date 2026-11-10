//! Savings vault. Anyone deposits NEAR and withdraws their own credit. The owner can sweep the vault
//! to a safe account in an emergency.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    credits: LookupMap<AccountId, u128>,
    total: u128,
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { owner, credits: LookupMap::new(b"c"), total: 0 }
    }

    /// Adds the attached NEAR to the caller's credit.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        let who = env::predecessor_account_id();
        let credit = self.credits.get(&who).copied().unwrap_or(0) + amount;
        self.credits.insert(who, credit);
        self.total += amount;
        U128(credit)
    }

    /// Sends part of the caller's own credit back to the caller.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let credit = self.credits.get(&who).copied().unwrap_or(0);
        require!(amount.0 > 0 && amount.0 <= credit, "not enough credit");
        self.credits.insert(who.clone(), credit - amount.0);
        self.total -= amount.0;
        Promise::new(who).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Hands the vault to a new owner.
    pub fn set_owner(&mut self, new_owner: AccountId) {
        log!("owner {} -> {}", self.owner, new_owner);
        self.owner = new_owner;
    }

    /// Emergency exit: the owner moves funds to a safe account.
    pub fn sweep(&mut self, to: AccountId, amount: U128) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "owner only");
        Promise::new(to).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn credit_of(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).copied().unwrap_or(0))
    }

    pub fn total_deposits(&self) -> U128 {
        U128(self.total)
    }
}
