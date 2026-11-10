//! The mask code exactly as it was first merged (`main` at 9b20798), kept only so the sandbox can move a mask forged with
//! it to the current code (`sandbox/tests/copy.rs`): its state holds just the factory and the owner. Never deployed
//! from here.
//!
//! A mask's own account. A person forges a mask in the factory (`../factory`), and the factory creates the mask's
//! account, `<name>.<factory>`, with no access key at all and with this code on it. From then on:
//!
//! - nobody holds a full key to the mask, the person and the arena included: the account can only do what this
//!   code lets it do;
//! - race keys come only from the factory, when its keeper arms the mask for a race: function-call keys, each for one
//!   receiver and a fixed list of methods, with a gas allowance. A race key cannot attach NEAR, so it cannot move the
//!   mask's money; and it never calls the mask itself;
//! - what the mask wins stays on its account, and only the person who forged it takes it out (`withdraw`).
//!
//! The code is written without the `#[near]` method macros, its arguments are Borsh and it avoids `format!`: every
//! byte of this wasm is stored once as a global contract and paid for at 0.0001 NEAR a byte, and a small contract is
//! easy to read in full. The logic is plain methods on [`Mask`]; `exports` only reads the input and the state.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{env, require, AccountId, Allowance, CryptoHash, Gas, NearToken, Promise, PublicKey};
use std::num::NonZeroU128;

/// What `withdraw` leaves on the account besides its storage: the gas a race burns. A claim prepays up to 300 TGas at
/// 0.001 NEAR a TGas, and the unused part comes back to the account.
pub const GAS_FUND: NearToken = NearToken::from_millinear(250);
/// Keys one `add_keys` adds: a race needs two, one on the arena and one on the target.
pub const MAX_KEYS: usize = 4;
/// Methods one race key may call.
pub const MAX_METHODS: usize = 8;
/// The most gas one race key may burn over its life.
pub const MAX_ALLOWANCE: NearToken = NearToken::from_near(1);
const MIGRATE_GAS: Gas = Gas::from_tgas(10);

/// A function-call key for one race: `public_key` may call `method_names` on `receiver_id` and burn at most
/// `allowance` yoctoNEAR of gas. The factory sends a list of these, Borsh-encoded.
#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq)]
#[cfg_attr(test, derive(Debug))]
#[borsh(crate = "near_sdk::borsh")]
pub struct RaceKey {
    pub public_key: PublicKey,
    pub receiver_id: AccountId,
    pub method_names: Vec<String>,
    pub allowance: u128,
}

/// The mask's whole state, under near-sdk's usual `STATE` key.
#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct Mask {
    /// The factory that forged this mask: the only account that adds or removes its keys.
    pub factory: AccountId,
    /// The person who forged it: the only account its winnings go to.
    pub owner: AccountId,
}

impl Mask {
    /// Runs in the factory's own batch, right after it creates this account: the factory is the predecessor, and the
    /// account is its direct sub-account. The batch is atomic, so nobody else can get here first.
    pub fn init(owner: AccountId) -> Self {
        require!(!env::state_exists(), "the mask is already forged");
        let factory = env::predecessor_account_id();
        require!(env::current_account_id().is_sub_account_of(&factory), "only the factory that made this account");
        require!(owner != factory && owner != env::current_account_id(), "the owner is a person, not the mask");
        Self { factory, owner }
    }

    /// Adds race keys. Only the factory, when its keeper arms the mask for a race. Each key is a function-call key:
    /// one receiver, a fixed list of methods, a gas allowance. A full-access key is never added.
    pub fn add_keys(&self, keys: Vec<RaceKey>) -> Promise {
        self.only_factory();
        require!(!keys.is_empty() && keys.len() <= MAX_KEYS, "1 to 4 keys at a time");
        let me = env::current_account_id();
        let mut batch = Promise::new(me.clone());
        for key in keys {
            require!(key.receiver_id != me, "a race key never calls the mask itself");
            require!(
                !key.method_names.is_empty()
                    && key.method_names.len() <= MAX_METHODS
                    && key.method_names.iter().all(|m| method_ok(m)),
                "a race key calls 1 to 8 named methods"
            );
            let allowance = NonZeroU128::new(key.allowance)
                .filter(|a| a.get() <= MAX_ALLOWANCE.as_yoctonear())
                .unwrap_or_else(|| env::panic_str("a race key burns more than 0 and at most 1 NEAR of gas"));
            batch = batch.add_access_key_allowance(
                key.public_key,
                Allowance::Limited(allowance),
                key.receiver_id,
                key.method_names.join(","),
            );
        }
        batch
    }

    /// Removes race keys. Only the factory: when the race is settled, or when the owner pauses the mask.
    pub fn remove_keys(&self, keys: Vec<PublicKey>) -> Promise {
        self.only_factory();
        require!(!keys.is_empty() && keys.len() <= MAX_KEYS, "1 to 4 keys at a time");
        let mut batch = Promise::new(env::current_account_id());
        for key in keys {
            batch = batch.delete_key(key);
        }
        batch
    }

    /// The owner takes out everything above the account's storage and its gas fund: the winnings.
    pub fn withdraw(&self) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "only the mask's owner withdraws");
        let keep = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage())).saturating_add(GAS_FUND);
        let amount = env::account_balance().saturating_sub(keep);
        require!(!amount.is_zero(), "nothing above the gas fund to withdraw");
        let mut line = String::from("withdraw ");
        push_u128(&mut line, amount.as_yoctonear());
        line.push_str(" to ");
        line.push_str(self.owner.as_str());
        env::log_str(&line);
        Promise::new(self.owner.clone()).transfer(amount)
    }

    /// Moves the mask to another code the factory published as a global contract. Only the factory, and the factory
    /// does it only when the owner asks. `migrate` runs in the same batch: code without it is refused, and the mask
    /// stays as it was.
    pub fn use_code(&self, code_hash: CryptoHash) -> Promise {
        self.only_factory();
        Promise::new(env::current_account_id()).use_global_contract(code_hash).function_call(
            "migrate".to_string(),
            vec![],
            NearToken::from_yoctonear(0),
            MIGRATE_GAS,
        )
    }

    fn only_factory(&self) {
        require!(env::predecessor_account_id() == self.factory, "only the factory that forged this mask");
    }
}

/// The contract's methods as NEAR calls them. Each reads its Borsh input and the state and returns the promise it
/// builds, so the factory's callback sees whether the keys, the transfer or the new code really went through.
#[cfg(target_arch = "wasm32")]
mod exports {
    use super::*;

    fn input<T: BorshDeserialize>() -> T {
        T::try_from_slice(&env::input().unwrap_or_default()).unwrap_or_else(|_| env::panic_str("bad arguments"))
    }

    fn mask() -> Mask {
        env::state_read().unwrap_or_else(|| env::panic_str("no mask here"))
    }

    #[no_mangle]
    pub extern "C" fn init() {
        env::state_write(&Mask::init(input()));
    }

    #[no_mangle]
    pub extern "C" fn add_keys() {
        mask().add_keys(input()).as_return().detach();
    }

    #[no_mangle]
    pub extern "C" fn remove_keys() {
        mask().remove_keys(input()).as_return().detach();
    }

    #[no_mangle]
    pub extern "C" fn withdraw() {
        mask().withdraw().as_return().detach();
    }

    #[no_mangle]
    pub extern "C" fn use_code() {
        mask().use_code(input()).as_return().detach();
    }

    /// Run by `use_code` in the same batch as the new code; this version keeps the state as it is.
    #[no_mangle]
    pub extern "C" fn migrate() {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the mask itself migrates");
        let _ = mask();
    }
}

/// Writes `n` in decimal without `core::fmt`, which would cost this wasm kilobytes.
fn push_u128(out: &mut String, mut n: u128) {
    let mut digits = [0u8; 39];
    let mut i = digits.len();
    loop {
        i -= 1;
        digits[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    out.extend(digits[i..].iter().map(|d| char::from(*d)));
}

/// A method name: 1 to 64 lowercase letters, digits or `_`.
pub fn method_ok(m: &str) -> bool {
    (1..=64).contains(&m.len()) && m.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
