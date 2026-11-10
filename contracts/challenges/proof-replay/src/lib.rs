//! Bridge exit. Liquidity providers deposit NEAR here. When a user locks funds on the other chain,
//! the bridge signs a proof `"<receiver>:<amount in yocto>:<nonce>"` with its ed25519 key, and
//! `claim` pays the receiver out of the pool.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Bridge {
    bridge_key: [u8; 32],
    credits: LookupMap<AccountId, u128>,
    claimed: u128,
}

#[near]
impl Bridge {
    #[init]
    pub fn new(bridge_key: Base64VecU8) -> Self {
        let bridge_key: [u8; 32] = bridge_key.0.try_into().unwrap_or_else(|_| env::panic_str("key must be 32 bytes"));
        Self { bridge_key, credits: LookupMap::new(b"c"), claimed: 0 }
    }

    /// Liquidity: adds the attached NEAR to the caller's credit.
    #[payable]
    pub fn deposit(&mut self) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach NEAR to deposit");
        let who = env::predecessor_account_id();
        let credit = self.credits.get(&who).copied().unwrap_or(0) + amount;
        self.credits.insert(who, credit);
        U128(credit)
    }

    /// Liquidity: sends part of the caller's own credit back to the caller.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let credit = self.credits.get(&who).copied().unwrap_or(0);
        require!(amount.0 > 0 && amount.0 <= credit, "not enough credit");
        self.credits.insert(who.clone(), credit - amount.0);
        Promise::new(who).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Pays out a transfer from the other chain once the bridge has signed it.
    pub fn claim(&mut self, receiver: AccountId, amount: U128, nonce: u64, signature: Base64VecU8) -> Promise {
        let signature: [u8; 64] =
            signature.0.try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"));
        let message = format!("{}:{}:{}", receiver, amount.0, nonce);
        require!(env::ed25519_verify(&signature, message.as_bytes(), &self.bridge_key), "bad proof");
        self.claimed += amount.0;
        log!("claim {} paid", nonce);
        Promise::new(receiver).transfer(NearToken::from_yoctonear(amount.0))
    }

    pub fn credit_of(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).copied().unwrap_or(0))
    }

    pub fn total_claimed(&self) -> U128 {
        U128(self.claimed)
    }
}
