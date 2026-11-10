//! Savings vault. Anyone deposits NEAR and withdraws it later.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    credits: LookupMap<AccountId, u128>,
    total: u128,
}

#[near]
impl Vault {
    #[init]
    pub fn new() -> Self {
        Self { credits: LookupMap::new(b"c"), total: 0 }
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

    /// Sends NEAR back to the caller and lowers their credit.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        require!(amount.0 > 0, "nothing to withdraw");
        require!(amount.0 <= self.total, "not enough in the vault");
        let who = env::predecessor_account_id();
        let credit = self.credits.get(&who).copied().unwrap_or(0);
        self.credits.insert(who.clone(), credit.saturating_sub(amount.0));
        self.total -= amount.0;
        Promise::new(who).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn credit_of(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).copied().unwrap_or(0))
    }

    pub fn total_deposits(&self) -> U128 {
        U128(self.total)
    }
}
