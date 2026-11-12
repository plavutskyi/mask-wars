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
//! ## A copy and its author's share
//!
//! A mask may be a copy: it plays another mask's sealed strategy in a TEE, and its owner agreed, at the copy's forging,
//! to give that strategy's author a share of what the copy wins (`author`, in basis points, fixed for this copy). The
//! share is not a promise the owner can skip: this code counts it and pays it, and nothing else moves it.
//!
//! - **What counts as winnings.** The account keeps a mark: its balance at forging, raised by every deposit put in
//!   through one of its methods (`top_up`) and lowered by every payout. Only balance above the mark is new winnings.
//!   So the forging fund and the owner's top-ups are never shared, and a race's gas, which takes the balance below the
//!   mark, is made up from the next win before anything new is counted: the author's share is of what the copy wins
//!   net of its race gas, and a gas refund that only brings the balance back never counts twice.
//! - **Counted is owed, for good.** Every call that touches the account (`withdraw`, `pay_author`, `top_up`, and the
//!   factory's `add_keys`/`remove_keys` around each race) first counts new winnings and records the author's share as
//!   `owed`. What is owed only grows with new winnings and only shrinks by being paid to the author: no withdraw, no
//!   race gas reaches it, so what the author earned on a copy never goes down.
//! - **One way out.** `withdraw` (the owner) pays the author what is owed first, in the same call, and the owner the
//!   rest; `pay_author` (anyone) pays the author alone. The author's share goes only to the author's own mask account,
//!   fixed in this state at forging, and the author withdraws it from there as that mask's owner.
//!
//! The code is written without the `#[near]` method macros, its arguments are Borsh and it avoids `format!`: every
//! byte of this wasm is stored once as a global contract and paid for at 0.0001 NEAR a byte, and a small contract is
//! easy to read in full. The logic is plain methods on [`Mask`]; `exports` only reads the input and the state.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::{env, require, AccountId, Allowance, CryptoHash, Gas, NearToken, Promise, PublicKey};
use std::num::NonZeroU128;

/// What `contract_source_metadata` returns (NEP-330), as build.rs wrote it for this build: the version, the public
/// repository and, when the build ran in cargo-near's pinned image, how to build these bytes again.
pub const SOURCE_METADATA: &str = include_str!(concat!(env!("OUT_DIR"), "/nep330.json"));

/// What `withdraw` leaves on the account besides its storage: the gas a race burns. A claim prepays up to 300 TGas at
/// 0.001 NEAR a TGas, and the unused part comes back to the account.
pub const GAS_FUND: NearToken = NearToken::from_millinear(250);
/// Keys one `add_keys` adds: a race needs two, one on the arena and one on the target.
pub const MAX_KEYS: usize = 4;
/// Methods one race key may call.
pub const MAX_METHODS: usize = 8;
/// The most gas one race key may burn over its life.
pub const MAX_ALLOWANCE: NearToken = NearToken::from_near(1);
/// The most of its winnings a copy owes its strategy's author: the owner, who pays the fuel and runs the account,
/// stays the majority earner. The factory checks it too; a mask trusts the factory that made it, as it does for its
/// owner, but never takes a share above this.
pub const MAX_AUTHOR_BPS: u16 = 3000;
const MIGRATE_GAS: Gas = Gas::from_tgas(10);
/// The least the factory's `refuel` takes; `fuel` asks no less, so it never sends NEAR the factory would send back.
pub const MIN_REFUEL: NearToken = NearToken::from_millinear(100);
/// Gas for the factory's `refuel`: one record read and written, its view returned.
const REFUEL_GAS: Gas = Gas::from_tgas(20);
/// Gas for `on_fuel`, the mask's own look at how the refuel went.
const ON_FUEL_GAS: Gas = Gas::from_tgas(5);

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

/// The strategy's author this mask copies, and the books of their share. All amounts yoctoNEAR.
#[derive(BorshSerialize, BorshDeserialize, Clone, PartialEq)]
#[cfg_attr(test, derive(Debug))]
#[borsh(crate = "near_sdk::borsh")]
pub struct Author {
    /// The author's own mask account, where the share goes and nowhere else.
    pub account: AccountId,
    /// The share in basis points, fixed at this copy's forging.
    pub bps: u16,
    /// Sent to the author so far.
    pub paid: u128,
    /// Counted and not sent yet. Grows only with new winnings, shrinks only by being paid to the author.
    pub owed: u128,
    /// The account's mark: its highest balance, less what it paid out since and plus the own money put in since. Only
    /// balance above it is new winnings.
    pub mark: u128,
}

/// The mask's whole state, under near-sdk's usual `STATE` key.
#[derive(BorshSerialize, BorshDeserialize, PartialEq)]
#[cfg_attr(test, derive(Debug))]
#[borsh(crate = "near_sdk::borsh")]
pub struct Mask {
    /// The factory that forged this mask: the only account that adds or removes its keys.
    pub factory: AccountId,
    /// The person who forged it: the only account its winnings go to.
    pub owner: AccountId,
    /// Set when this mask is a copy: the author it owes a share of its winnings. `None` for a mask that plays its own
    /// strategy.
    pub author: Option<Author>,
}

/// The mask's state before copies: the first mask code wrote only the factory and the owner. `migrate` reads it so an
/// early mask can move to this code.
#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct MaskV1 {
    pub factory: AccountId,
    pub owner: AccountId,
}

/// A copy's terms as `copy_terms` tells them. All amounts yoctoNEAR.
#[derive(Clone, Copy, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub struct Terms {
    /// Sent to the author so far.
    pub paid: u128,
    /// Counted for the author and not sent yet: with `paid`, what the author earned on this copy. Never goes down.
    pub owed: u128,
    /// What `pay_author` would send the author now: what is owed, with winnings not counted yet, as far as the account
    /// can pay it.
    pub due: u128,
    /// What `withdraw` would send the owner now.
    pub owner: u128,
}

impl Mask {
    /// Runs in the factory's own batch, right after it creates this account: the factory is the predecessor, and the
    /// account is its direct sub-account. The batch is atomic, so nobody else can get here first. `author` is set when
    /// the factory forges a copy: the author's mask account and the share, which the factory has already bounded. The
    /// copy's mark starts at the balance it is forged with: the forging fund is the owner's, never winnings.
    pub fn init(owner: AccountId, author: Option<(AccountId, u16)>) -> Self {
        require!(!env::state_exists(), "the mask is already forged");
        let factory = env::predecessor_account_id();
        let me = env::current_account_id();
        require!(me.is_sub_account_of(&factory), "only the factory that made this account");
        require!(owner != factory && owner != me, "the owner is a person, not the mask");
        let author = author.map(|(account, bps)| {
            require!(account != me && account != owner, "the author is another mask");
            require!(bps > 0 && bps <= MAX_AUTHOR_BPS, "the author's share is more than 0 and at most 30%");
            Author { account, bps, paid: 0, owed: 0, mark: env::account_balance().as_yoctonear() }
        });
        Self { factory, owner, author }
    }

    /// The state `migrate` finds: this code's own, or the first mask code's shorter one, which becomes a mask with no
    /// author. `None` for anything else. Read from the raw bytes: near-sdk's `state_read` would panic on the old layout
    /// before the second reading is ever tried.
    pub fn from_state(raw: &[u8]) -> Option<Self> {
        if let Ok(m) = Self::try_from_slice(raw) {
            return Some(m);
        }
        let v1 = MaskV1::try_from_slice(raw).ok()?;
        Some(Self { factory: v1.factory, owner: v1.owner, author: None })
    }

    /// Adds race keys. Only the factory, when its keeper arms the mask for a race. Each key is a function-call key:
    /// one receiver, a fixed list of methods, a gas allowance. A full-access key is never added. A copy counts its
    /// winnings first, so the race starts from a fresh count.
    pub fn add_keys(&mut self, keys: Vec<RaceKey>) -> Promise {
        self.only_factory();
        require!(!keys.is_empty() && keys.len() <= MAX_KEYS, "1 to 4 keys at a time");
        self.count();
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

    /// Removes race keys. Only the factory: when the race is settled, or when the owner pauses the mask. A copy counts
    /// what the race won, so the author's share of it is recorded as soon as the race is over.
    pub fn remove_keys(&mut self, keys: Vec<PublicKey>) -> Promise {
        self.only_factory();
        require!(!keys.is_empty() && keys.len() <= MAX_KEYS, "1 to 4 keys at a time");
        self.count();
        let mut batch = Promise::new(env::current_account_id());
        for key in keys {
            batch = batch.delete_key(key);
        }
        batch
    }

    /// Counts what a copy won since its last call: the balance above its mark, this call's own deposit left out. The
    /// author's share of it is recorded as owed and the mark rises to the balance. A balance at or under the mark
    /// counts nothing: race gas burned, or a gas prepay still on its way back. This call's deposit is the payer's own
    /// money: it raises the mark and is never counted. A mask with no author counts nothing.
    fn count(&mut self) {
        let Some(a) = self.author.as_mut() else { return };
        let deposit = env::attached_deposit().as_yoctonear();
        let before = env::account_balance().as_yoctonear().saturating_sub(deposit);
        if before > a.mark {
            a.owed = a.owed.saturating_add(share(before - a.mark, a.bps));
            a.mark = before;
        }
        a.mark = a.mark.saturating_add(deposit);
    }

    /// The copy's terms now, as if it counted: a view, it changes nothing.
    pub fn terms(&self) -> Option<Terms> {
        let a = self.author.as_ref()?;
        let balance = env::account_balance().as_yoctonear();
        let fresh = if balance > a.mark { share(balance - a.mark, a.bps) } else { 0 };
        let free = free();
        let due = a.owed.saturating_add(fresh).min(free);
        Some(Terms { paid: a.paid, owed: a.owed, due, owner: free - due })
    }

    /// The owner takes out its winnings: everything above the account's storage and gas fund. A copy pays its author
    /// what is owed first, in this same call, to the author's own mask account, and the owner the rest; so the
    /// author's share never waits on the account after the owner took theirs. Only the person who forged the mask.
    /// Returns the owner's transfer; the author's goes alongside it.
    pub fn withdraw(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "only the mask's owner withdraws");
        self.count();
        let free = free();
        let to_author = self.author.as_ref().map_or(0, |a| a.owed.min(free));
        let amount = free - to_author;
        require!(amount > 0, "nothing above the gas fund and the author's share to withdraw");
        if to_author > 0 {
            self.pay(to_author).detach();
        }
        if let Some(a) = self.author.as_mut() {
            a.mark = a.mark.saturating_sub(amount);
        }
        let mut line = String::from("withdraw ");
        push_u128(&mut line, amount);
        line.push_str(" to ");
        line.push_str(self.owner.as_str());
        env::log_str(&line);
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount))
    }

    /// Pays the copy's author what is owed, as far as the account can, to their own mask account and nowhere else.
    /// Anyone may call it, so the author never depends on the owner: the destination is fixed in this state, so a call
    /// can only move the share to the author. A mask with no author has nothing to pay.
    pub fn pay_author(&mut self) -> Promise {
        self.count();
        let owed = self.author.as_ref().map_or(0, |a| a.owed.min(free()));
        require!(owed > 0, "no author share to pay");
        self.pay(owed)
    }

    /// The mask pays for its own mind: what it won goes from its account into its tank in the factory that forged it
    /// (`refuel` for this very mask, and nowhere else). Only the owner, who could as well withdraw it, and exactly what
    /// `withdraw` would pay them: the gas fund stays, so the mask keeps racing, and a copy pays its author what is owed
    /// first, in this same call, so fuel never comes out of the author's share. Like a payout it lowers a copy's mark.
    /// No argument, like `withdraw`: a wallet calls it as it is.
    pub fn fuel(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "only the mask's owner fuels its mind");
        require!(env::attached_deposit().is_zero(), "fuel takes no deposit: it spends what the mask holds");
        self.count();
        let free = free();
        let to_author = self.author.as_ref().map_or(0, |a| a.owed.min(free));
        let amount = free - to_author;
        require!(
            amount >= MIN_REFUEL.as_yoctonear(),
            "less than 0.1 NEAR, the factory's least refuel, above the gas fund"
        );
        if to_author > 0 {
            self.pay(to_author).detach();
        }
        if let Some(a) = self.author.as_mut() {
            a.mark = a.mark.saturating_sub(amount);
        }
        let me = env::current_account_id();
        let name = me.as_str().strip_suffix(self.factory.as_str()).and_then(|n| n.strip_suffix('.'));
        let name = name.unwrap_or_else(|| env::panic_str("the mask is not an account of its factory"));
        let mut line = String::from("fuel ");
        push_u128(&mut line, amount);
        line.push_str(" to ");
        line.push_str(self.factory.as_str());
        env::log_str(&line);
        // `{"name":"<name>"}`: a mask's name is lowercase letters and digits, nothing to escape.
        let mut args = String::from("{\"name\":\"");
        args.push_str(name);
        args.push_str("\"}");
        Promise::new(self.factory.clone())
            .function_call("refuel".to_string(), args.into_bytes(), NearToken::from_yoctonear(amount), REFUEL_GAS)
            .then(Promise::new(me.clone()).function_call(
                "on_fuel".to_string(),
                near_sdk::borsh::to_vec(&amount).unwrap_or_default(),
                NearToken::from_yoctonear(0),
                ON_FUEL_GAS,
            ))
    }

    /// The mask's own answer to its `fuel`: when the factory refused the refuel, NEAR gives `amount` back to the mask,
    /// and a copy raises its mark by it again, so the owner's own NEAR coming back is never counted as winnings the
    /// author takes a share of. Only the mask itself, in the callback of `fuel`.
    pub fn on_fuel(&mut self, amount: u128) {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the mask itself");
        // Only a failed refuel counts: a refuel that went through answers with the mask's record, longer than the 0
        // bytes asked for here, and that is `TooLong`, not a failure.
        if env::promise_results_count() != 1
            || !matches!(env::promise_result_checked(0, 0), Err(near_sdk::PromiseError::Failed))
        {
            return;
        }
        env::log_str("fuel refused: the NEAR comes back to the mask");
        if let Some(a) = self.author.as_mut() {
            a.mark = a.mark.saturating_add(amount);
        }
    }

    /// Adds the attached NEAR to the mask's account as its owner's own money, for its race gas: never counted as
    /// winnings, so a copy's author takes no share of it, and the owner can take it back out. Anyone may.
    pub fn top_up(&mut self) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "a top-up attaches NEAR to add");
        self.count();
        let mut line = String::from("top_up ");
        push_u128(&mut line, deposit);
        env::log_str(&line);
    }

    /// Sends `amount` of what is owed to the author and books it: owed down, paid up, the mark down by what left.
    fn pay(&mut self, amount: u128) -> Promise {
        let a = self.author.as_mut().unwrap_or_else(|| env::panic_str("no author share to pay"));
        a.owed -= amount;
        a.paid = a.paid.saturating_add(amount);
        a.mark = a.mark.saturating_sub(amount);
        let mut line = String::from("pay_author ");
        push_u128(&mut line, amount);
        line.push_str(" to ");
        line.push_str(a.account.as_str());
        env::log_str(&line);
        Promise::new(a.account.clone()).transfer(NearToken::from_yoctonear(amount))
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

/// What the account can pay out now: its balance above its storage and gas fund.
fn free() -> u128 {
    let keep = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage())).saturating_add(GAS_FUND);
    env::account_balance().saturating_sub(keep).as_yoctonear()
}

/// `bps` basis points of `amount`, rounded down, without overflow.
pub fn share(amount: u128, bps: u16) -> u128 {
    let bps = u128::from(bps);
    amount / 10_000 * bps + amount % 10_000 * bps / 10_000
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
        let bytes = env::input().unwrap_or_default();
        // The factory sends `(owner, author?)`; the first factory, before copies, sent only `owner`. Read either.
        let m = if let Ok((owner, author)) = <(AccountId, Option<(AccountId, u16)>)>::try_from_slice(&bytes) {
            Mask::init(owner, author)
        } else if let Ok(owner) = AccountId::try_from_slice(&bytes) {
            Mask::init(owner, None)
        } else {
            env::panic_str("bad arguments")
        };
        env::state_write(&m);
    }

    #[no_mangle]
    pub extern "C" fn add_keys() {
        let mut m = mask();
        let p = m.add_keys(input());
        env::state_write(&m);
        p.as_return().detach();
    }

    #[no_mangle]
    pub extern "C" fn remove_keys() {
        let mut m = mask();
        let p = m.remove_keys(input());
        env::state_write(&m);
        p.as_return().detach();
    }

    #[no_mangle]
    pub extern "C" fn withdraw() {
        let mut m = mask();
        let p = m.withdraw();
        env::state_write(&m);
        p.as_return().detach();
    }

    #[no_mangle]
    pub extern "C" fn pay_author() {
        let mut m = mask();
        let p = m.pay_author();
        env::state_write(&m);
        p.as_return().detach();
    }

    #[no_mangle]
    pub extern "C" fn fuel() {
        let mut m = mask();
        let p = m.fuel();
        env::state_write(&m);
        p.as_return().detach();
    }

    #[no_mangle]
    pub extern "C" fn on_fuel() {
        let mut m = mask();
        m.on_fuel(input());
        env::state_write(&m);
    }

    #[no_mangle]
    pub extern "C" fn top_up() {
        let mut m = mask();
        m.top_up();
        env::state_write(&m);
    }

    /// A copy's terms, for the site to read: `<author account>|<bps>|<paid>|<owed>|<due>|<owner>`, all amounts in
    /// yoctoNEAR (`Terms`). Empty when the mask has no author. Built by hand so this wasm keeps no JSON code.
    #[no_mangle]
    pub extern "C" fn copy_terms() {
        let m = mask();
        let mut out = String::new();
        if let (Some(a), Some(t)) = (&m.author, m.terms()) {
            out.push_str(a.account.as_str());
            for n in [u128::from(a.bps), t.paid, t.owed, t.due, t.owner] {
                out.push('|');
                push_u128(&mut out, n);
            }
        }
        env::value_return(out.as_bytes());
    }

    /// NEP-330: where this code's source is. A view: it reads and writes nothing.
    #[no_mangle]
    pub extern "C" fn contract_source_metadata() {
        env::value_return(SOURCE_METADATA.as_bytes());
    }

    #[no_mangle]
    pub extern "C" fn use_code() {
        mask().use_code(input()).as_return().detach();
    }

    /// Run by `use_code` in the same batch as the new code; keeps the state, reading an early mask's shorter one too.
    #[no_mangle]
    pub extern "C" fn migrate() {
        require!(env::predecessor_account_id() == env::current_account_id(), "only the mask itself migrates");
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no mask here"));
        let m = Mask::from_state(&raw).unwrap_or_else(|| env::panic_str("unknown state: nothing migrated"));
        env::state_write(&m);
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

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;
    use near_sdk::NearToken;

    const ONE: u128 = 10u128.pow(24);

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn pk(n: u8) -> PublicKey {
        let mut bytes = vec![0u8; 33];
        bytes[1] = n;
        PublicKey::try_from(bytes).unwrap()
    }

    fn as_(who: &str, balance: u128) {
        let mut c = VMContextBuilder::new();
        c.current_account_id(acc("kira.masks.near"))
            .signer_account_id(acc(who))
            .predecessor_account_id(acc(who))
            .account_balance(NearToken::from_yoctonear(balance))
            .storage_usage(400);
        testing_env!(c.build());
    }

    fn mask() -> Mask {
        as_("masks.near", ONE / 2);
        Mask::init(acc("ann.near"), None)
    }

    /// A copy of NINA's mask with a 30% author share; its winnings sit on its account.
    fn copy(bps: u16, balance: u128) -> Mask {
        as_("masks.near", balance);
        Mask::init(acc("ann.near"), Some((acc("nina.masks.near"), bps)))
    }

    fn key(receiver: &str, methods: &[&str], allowance: u128) -> RaceKey {
        RaceKey {
            public_key: pk(1),
            receiver_id: acc(receiver),
            method_names: methods.iter().map(|m| m.to_string()).collect(),
            allowance,
        }
    }

    fn added_keys() -> Vec<(AccountId, String, Option<u128>)> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                MockAction::AddKeyWithFunctionCall { receiver_id, method_names, allowance, .. } => {
                    Some((receiver_id, method_names.join(","), allowance.map(|a| a.as_yoctonear())))
                }
                MockAction::AddKeyWithFullAccess { .. } => panic!("a full-access key"),
                _ => None,
            })
            .collect()
    }

    /// What the account transferred to `to`, in one call.
    fn sent_to(to: &str) -> Vec<u128> {
        get_created_receipts()
            .into_iter()
            .filter(|r| r.receiver_id == acc(to))
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
                _ => None,
            })
            .collect()
    }

    fn storage() -> u128 {
        env::storage_byte_cost().as_yoctonear() * 400
    }

    #[test]
    fn the_code_says_where_its_source_is() {
        // NEP-330 as near-sdk writes it. A plain build has no build_info; the build in cargo-near's pinned image adds
        // it (contracts/README.md, "Source on chain").
        let head =
            format!(r#"{{"version":"{}","link":"https://github.com/plavutskyi/mask-wars"#, env!("CARGO_PKG_VERSION"));
        assert!(SOURCE_METADATA.starts_with(&head), "{SOURCE_METADATA}");
        assert!(SOURCE_METADATA.contains(r#"","standards":[{"standard":"nep330","version":"1.3.0"}],"build_info":"#));
        if option_env!("NEP330_BUILD_INFO_BUILD_ENVIRONMENT").is_none() {
            assert!(SOURCE_METADATA.ends_with(r#","build_info":null}"#), "{SOURCE_METADATA}");
        }
    }

    #[test]
    fn only_the_parent_factory_initializes() {
        let m = mask();
        assert_eq!((m.factory.as_str(), m.owner.as_str(), m.author.is_some()), ("masks.near", "ann.near", false));
    }

    #[test]
    #[should_panic(expected = "only the factory that made this account")]
    fn a_stranger_cannot_initialize() {
        as_("bob.near", ONE);
        Mask::init(acc("bob.near"), None);
    }

    #[test]
    #[should_panic(expected = "the owner is a person, not the mask")]
    fn the_mask_does_not_own_itself() {
        as_("masks.near", ONE);
        Mask::init(acc("kira.masks.near"), None);
    }

    #[test]
    fn the_factory_adds_function_call_keys_only() {
        let mut m = mask();
        let _ = m.add_keys(vec![
            key("arena.near", &["commit", "reveal", "claim_drain", "settle"], ONE / 2),
            key("safe-0007.near", &["set_owner", "sweep"], ONE / 10),
        ]);
        assert_eq!(
            added_keys(),
            vec![
                (acc("arena.near"), "commit,reveal,claim_drain,settle".into(), Some(ONE / 2)),
                (acc("safe-0007.near"), "set_owner,sweep".into(), Some(ONE / 10)),
            ]
        );
    }

    #[test]
    #[should_panic(expected = "only the factory that forged this mask")]
    fn the_owner_cannot_add_keys() {
        let mut m = mask();
        as_("ann.near", ONE);
        let _ = m.add_keys(vec![key("arena.near", &["commit"], ONE / 2)]);
    }

    #[test]
    #[should_panic(expected = "a race key never calls the mask itself")]
    fn a_key_never_calls_the_mask() {
        let mut m = mask();
        let _ = m.add_keys(vec![key("kira.masks.near", &["withdraw"], ONE / 2)]);
    }

    #[test]
    #[should_panic(expected = "a race key calls 1 to 8 named methods")]
    fn a_key_without_methods_would_call_anything() {
        let mut m = mask();
        let _ = m.add_keys(vec![key("arena.near", &[], ONE / 2)]);
    }

    #[test]
    #[should_panic(expected = "a race key calls 1 to 8 named methods")]
    fn method_names_are_plain() {
        let mut m = mask();
        let _ = m.add_keys(vec![key("arena.near", &["commit,withdraw"], ONE / 2)]);
    }

    #[test]
    #[should_panic(expected = "at most 1 NEAR of gas")]
    fn an_unlimited_key_is_refused() {
        let mut m = mask();
        let _ = m.add_keys(vec![key("arena.near", &["commit"], 0)]);
    }

    #[test]
    #[should_panic(expected = "at most 1 NEAR of gas")]
    fn a_greedy_allowance_is_refused() {
        let mut m = mask();
        let _ = m.add_keys(vec![key("arena.near", &["commit"], ONE + 1)]);
    }

    #[test]
    fn the_factory_removes_keys() {
        let mut m = mask();
        let _ = m.remove_keys(vec![pk(1), pk(2)]);
        let deleted = get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter(|a| matches!(a, MockAction::DeleteKey { .. }))
            .count();
        assert_eq!(deleted, 2);
    }

    #[test]
    fn the_owner_takes_the_winnings_and_the_gas_fund_stays() {
        let mut m = mask();
        as_("ann.near", 2 * ONE);
        let _ = m.withdraw();
        assert_eq!(sent_to("ann.near"), vec![2 * ONE - storage() - GAS_FUND.as_yoctonear()]);
        assert!(get_logs()[0].starts_with("withdraw "));
    }

    #[test]
    #[should_panic(expected = "only the mask's owner withdraws")]
    fn nobody_else_withdraws() {
        let mut m = mask();
        as_("masks.near", 2 * ONE);
        let _ = m.withdraw();
    }

    #[test]
    #[should_panic(expected = "nothing above the gas fund")]
    fn the_gas_fund_is_not_for_withdrawal() {
        let mut m = mask();
        as_("ann.near", GAS_FUND.as_yoctonear());
        let _ = m.withdraw();
    }

    /// The factory calls the mask gets: receiver, method, args and deposit.
    fn calls_to(to: &str) -> Vec<(String, Vec<u8>, u128)> {
        get_created_receipts()
            .into_iter()
            .filter(|r| r.receiver_id == acc(to))
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
                    Some((String::from_utf8(method_name).unwrap(), args, attached_deposit.as_yoctonear()))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_mask_fuels_its_own_mind_with_what_it_won() {
        let mut m = mask();
        as_("ann.near", 2 * ONE);
        let _ = m.fuel();
        let won = 2 * ONE - storage() - GAS_FUND.as_yoctonear();
        assert_eq!(calls_to("masks.near"), vec![("refuel".to_string(), br#"{"name":"kira"}"#.to_vec(), won)]);
        assert!(sent_to("ann.near").is_empty(), "nothing goes to the owner");
        assert_eq!(get_logs(), vec![format!("fuel {won} to masks.near")]);
    }

    #[test]
    #[should_panic(expected = "only the mask's owner fuels its mind")]
    fn nobody_else_spends_the_winnings_on_fuel() {
        let mut m = mask();
        as_("masks.near", 2 * ONE);
        let _ = m.fuel();
    }

    #[test]
    #[should_panic(expected = "fuel takes no deposit")]
    fn fuel_spends_only_what_the_mask_holds() {
        let mut m = mask();
        paying("ann.near", 2 * ONE, ONE);
        let _ = m.fuel();
    }

    /// The factory refused the refuel: NEAR gives the NEAR back to the copy, and its mark rises by it again, so the
    /// owner's own NEAR coming back is never counted as winnings. A refuel that went through changes nothing.
    #[test]
    fn a_refused_refuel_puts_the_mark_back() {
        use near_sdk::test_vm_config;
        use near_sdk::PromiseResult;
        let mut m = copy(BPS, FUND);
        as_("ann.near", FUND + ONE);
        let _ = m.fuel();
        let mark = m.author.as_ref().unwrap().mark;
        let callback = |result: PromiseResult| {
            let mut c = VMContextBuilder::new();
            c.current_account_id(acc("kira.masks.near"))
                .predecessor_account_id(acc("kira.masks.near"))
                .storage_usage(400);
            testing_env!(
                c.build(),
                test_vm_config(),
                near_sdk::RuntimeFeesConfig::test(),
                Default::default(),
                vec![result]
            );
        };
        callback(PromiseResult::Successful(b"{}".to_vec()));
        m.on_fuel(ONE / 2);
        assert_eq!(m.author.as_ref().unwrap().mark, mark, "a refuel that went through");
        callback(PromiseResult::Failed);
        m.on_fuel(ONE / 2);
        assert_eq!(m.author.as_ref().unwrap().mark, mark + ONE / 2, "a refused one: the mark is back up");
    }

    #[test]
    #[should_panic(expected = "only the mask itself")]
    fn nobody_else_answers_for_the_refuel() {
        let mut m = mask();
        as_("ann.near", ONE);
        m.on_fuel(1);
    }

    #[test]
    #[should_panic(expected = "less than 0.1 NEAR")]
    fn fuel_is_worth_a_refuel() {
        let mut m = mask();
        as_("ann.near", storage() + GAS_FUND.as_yoctonear() + ONE / 20);
        let _ = m.fuel();
    }

    // ---- a copy and its author's share -------------------------------------------------------------------------
    //
    // The copy is this account (`kira.masks.near`), forged by ANN; its author is NINA's mask (`nina.masks.near`), owed
    // 30%. The copy is forged with the factory's fund, `FUND`, above its keep (storage and gas fund).

    const FUND: u128 = ONE * 3 / 10;
    const BPS: u16 = 3000;

    fn keep() -> u128 {
        storage() + GAS_FUND.as_yoctonear()
    }

    /// A call by `who` with `deposit` attached to an account holding `balance`: inside the call the account holds both,
    /// as NEAR runs it.
    fn paying(who: &str, balance: u128, deposit: u128) {
        let mut c = VMContextBuilder::new();
        c.current_account_id(acc("kira.masks.near"))
            .signer_account_id(acc(who))
            .predecessor_account_id(acc(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_yoctonear(balance))
            .storage_usage(400);
        testing_env!(c.build());
    }

    /// The factory's calls around a race: `add_keys` when the keeper arms it, `remove_keys` when it settles. A copy
    /// counts its winnings in both.
    fn arm(m: &mut Mask, balance: u128) {
        as_("masks.near", balance);
        let _ = m.add_keys(vec![key("arena.near", &["commit"], ONE / 2)]);
    }

    fn settle(m: &mut Mask, balance: u128) {
        as_("masks.near", balance);
        let _ = m.remove_keys(vec![pk(1)]);
    }

    /// What the author earned on the copy: paid and counted. It never goes down.
    fn earned(m: &Mask) -> u128 {
        let a = m.author.as_ref().unwrap();
        a.paid + a.owed
    }

    #[test]
    #[should_panic(expected = "at most 30%")]
    fn a_copy_owes_at_most_thirty_percent() {
        as_("masks.near", ONE);
        Mask::init(acc("ann.near"), Some((acc("nina.masks.near"), MAX_AUTHOR_BPS + 1)));
    }

    #[test]
    #[should_panic(expected = "the author is another mask")]
    fn the_author_is_not_the_copy_itself() {
        as_("masks.near", ONE);
        Mask::init(acc("ann.near"), Some((acc("kira.masks.near"), 2000)));
    }

    /// A copy won 1 NEAR. The owner's withdraw pays the author their 30% in the same call, to the author's own mask,
    /// and the owner the rest: the prize's 70% and the forging fund above the keep, which is the owner's own.
    #[test]
    fn the_owner_s_withdraw_pays_the_author_s_share_in_the_same_call() {
        let mut m = copy(BPS, FUND);
        as_("ann.near", FUND + ONE);
        let _ = m.withdraw();
        assert_eq!(sent_to("nina.masks.near"), vec![ONE * 3 / 10], "the author got 30% of the prize, at once");
        assert_eq!(sent_to("ann.near"), vec![FUND + ONE * 7 / 10 - keep()], "the owner got the rest");
        let logs = get_logs();
        assert!(logs.iter().any(|l| l == &format!("pay_author {} to nina.masks.near", ONE * 3 / 10)), "{logs:?}");
        assert!(logs.iter().any(|l| l.starts_with("withdraw ") && l.ends_with(" to ann.near")), "{logs:?}");
        let a = m.author.as_ref().unwrap();
        assert_eq!((a.paid, a.owed), (ONE * 3 / 10, 0));
    }

    /// A copy won 1 NEAR and its owner fuels its mind with it: the author gets their 30% first, in the same call, and
    /// only the owner's part goes to the tank. Nothing the author earned is spent on fuel.
    #[test]
    fn a_copy_s_fuel_pays_the_author_first() {
        let mut m = copy(BPS, FUND);
        as_("ann.near", FUND + ONE);
        let _ = m.fuel();
        assert_eq!(sent_to("nina.masks.near"), vec![ONE * 3 / 10], "the author got 30% of the prize, at once");
        let fuel = FUND + ONE * 7 / 10 - keep();
        assert_eq!(calls_to("masks.near"), vec![("refuel".to_string(), br#"{"name":"kira"}"#.to_vec(), fuel)]);
        let a = m.author.as_ref().unwrap();
        assert_eq!((a.paid, a.owed), (ONE * 3 / 10, 0));
        assert_eq!(a.mark, FUND + ONE - ONE * 3 / 10 - fuel, "the mark fell by all that left");
    }

    /// Review finding 3, the attack: the owner takes their 70%, then the copy keeps racing and its gas burns the
    /// balance. In the code under review the author's 30% waited on the account after the owner's withdraw, and race gas
    /// burned it: `pay_author` then sent 0.1 NEAR instead of 0.3. Now the withdraw paid the author in the same call,
    /// nothing of theirs is left for gas to burn, and what they earned stays 0.3.
    #[test]
    fn race_gas_after_the_owner_s_withdraw_never_burns_the_author_s_share() {
        let mut m = copy(BPS, FUND);
        as_("ann.near", FUND + ONE);
        let _ = m.withdraw();
        assert_eq!(sent_to("nina.masks.near"), vec![ONE * 3 / 10]);
        // Two races burn 0.2 NEAR of gas from the gas fund.
        arm(&mut m, keep() - ONE / 10);
        settle(&mut m, keep() - ONE / 5);
        assert_eq!(earned(&m), ONE * 3 / 10, "the author's earnings did not go down");
        let paid = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            as_("bob.near", keep() - ONE / 5);
            let _ = m.pay_author();
        }));
        assert!(paid.is_err(), "nothing more is owed: the author already has their 0.3");
    }

    /// The author's counted share is a reserve no race gas reaches: the race that won is settled (the share is counted),
    /// then the owner leaves the prize on the account and the copy burns 0.5 NEAR of gas in later races. The author is
    /// still paid the full 30%, and the owner takes what is left.
    #[test]
    fn a_counted_share_is_paid_in_full_whatever_gas_burns_after() {
        let mut m = copy(BPS, FUND);
        arm(&mut m, FUND);
        settle(&mut m, FUND + ONE);
        assert_eq!(m.author.as_ref().unwrap().owed, ONE * 3 / 10, "the race's win is counted when it settles");
        arm(&mut m, FUND + ONE - ONE / 4);
        settle(&mut m, FUND + ONE / 2);
        assert_eq!(earned(&m), ONE * 3 / 10);
        as_("bob.near", FUND + ONE / 2);
        let _ = m.pay_author();
        assert_eq!(sent_to("nina.masks.near"), vec![ONE * 3 / 10], "the author got the full 30%");
        as_("ann.near", FUND + ONE / 5);
        let _ = m.withdraw();
        assert_eq!(sent_to("ann.near"), vec![FUND + ONE / 5 - keep()], "the owner takes what the gas left");
        assert!(sent_to("nina.masks.near").is_empty());
    }

    /// A race key's transaction prepays its gas from the balance, and NEAR sends the unused part back later. A count in
    /// between (anyone may call `pay_author`) finds the balance under the mark and counts nothing; the refund only
    /// brings the balance back toward the mark, so it is never counted as winnings.
    #[test]
    fn a_gas_refund_is_never_counted_as_winnings() {
        let mut m = copy(BPS, FUND);
        settle(&mut m, FUND + ONE);
        // A claim prepays 0.2 NEAR; somebody counts while the refund is on its way.
        as_("bob.near", FUND + ONE - ONE / 5);
        let _ = m.pay_author();
        assert_eq!(sent_to("nina.masks.near"), vec![ONE * 3 / 10]);
        // 0.15 comes back; the race burned 0.05.
        as_("bob.near", FUND + ONE * 7 / 10 - ONE / 20);
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| m.clone_for_test().pay_author()));
        assert!(again.is_err(), "the refund is not winnings: nothing new is owed");
        assert_eq!(earned(&m), ONE * 3 / 10);
    }

    /// The share is of what the copy wins net of its race gas: gas burned before a win is made up from it first.
    #[test]
    fn race_gas_before_a_win_is_made_up_from_it_first() {
        let mut m = copy(BPS, FUND);
        arm(&mut m, FUND);
        settle(&mut m, FUND - ONE / 20);
        assert_eq!(earned(&m), 0);
        arm(&mut m, FUND - ONE / 20);
        settle(&mut m, FUND - ONE / 20 + ONE);
        assert_eq!(m.author.as_ref().unwrap().owed, (ONE - ONE / 20) * 3 / 10, "30% of the 0.95 NEAR net");
    }

    /// Review finding 6, the attack: the copy is forged with 0.3 NEAR, above its keep. In the code under review that
    /// was counted as winnings, and `pay_author` sent the author 30% of the owner's own forging money. Now the mark
    /// starts at the forging balance: nothing is owed until the copy wins.
    #[test]
    #[should_panic(expected = "no author share to pay")]
    fn the_forging_fund_is_never_shared() {
        let mut m = copy(BPS, FUND);
        as_("bob.near", FUND);
        let _ = m.pay_author();
    }

    /// The owner's money put in through `top_up` is their own: the author takes no share of it, the owner takes it
    /// back out, and the author's 30% is of the prize alone.
    #[test]
    fn the_owner_s_top_up_is_never_shared() {
        let mut m = copy(BPS, FUND);
        paying("ann.near", FUND, ONE);
        m.top_up();
        assert_eq!(get_logs(), vec![format!("top_up {ONE}")]);
        let none = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            as_("bob.near", FUND + ONE);
            m.clone_for_test().pay_author()
        }));
        assert!(none.is_err(), "a top-up is not winnings");
        // The copy wins 1 NEAR.
        as_("ann.near", FUND + 2 * ONE);
        let _ = m.withdraw();
        assert_eq!(sent_to("nina.masks.near"), vec![ONE * 3 / 10], "30% of the prize, none of the top-up");
        assert_eq!(sent_to("ann.near"), vec![FUND + 2 * ONE - ONE * 3 / 10 - keep()]);
    }

    /// NEAR attached to `withdraw` by mistake is the owner's own money too, not winnings.
    #[test]
    fn a_deposit_on_withdraw_is_the_owner_s_own() {
        let mut m = copy(BPS, FUND);
        paying("ann.near", FUND + ONE, ONE / 2);
        let _ = m.withdraw();
        assert_eq!(sent_to("nina.masks.near"), vec![ONE * 3 / 10], "30% of the prize, none of the deposit");
    }

    #[test]
    #[should_panic(expected = "a top-up attaches NEAR")]
    fn a_top_up_attaches_near() {
        let mut m = copy(BPS, FUND);
        as_("ann.near", FUND);
        m.top_up();
    }

    /// The owner cannot reach a counted share: when race gas left less on the account than the author is owed, the
    /// owner's withdraw finds nothing for them, and the author is paid what there is, the rest still owed and paid
    /// first from the next win.
    #[test]
    fn the_owner_never_withdraws_into_the_author_s_share() {
        let mut m = copy(BPS, FUND);
        settle(&mut m, FUND + ONE);
        // Race gas burns until only 0.2 NEAR is left above the keep; the author is owed 0.3.
        let owner = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            as_("ann.near", keep() + ONE / 5);
            m.clone_for_test().withdraw()
        }));
        assert!(owner.is_err(), "nothing above the author's share for the owner");
        as_("bob.near", keep() + ONE / 5);
        let _ = m.pay_author();
        assert_eq!(sent_to("nina.masks.near"), vec![ONE / 5]);
        let a = m.author.as_ref().unwrap();
        assert_eq!((a.paid, a.owed), (ONE / 5, ONE / 10), "the rest stays owed");
        // The next win of 1 NEAR: the gas burned since the count is made up from it first, then its share is counted.
        let mark = FUND + ONE - ONE / 5;
        settle(&mut m, keep() + ONE);
        assert_eq!(m.author.as_ref().unwrap().owed, ONE / 10 + share(keep() + ONE - mark, BPS));
        assert_eq!(earned(&m), ONE / 5 + ONE / 10 + share(keep() + ONE - mark, BPS), "earned only went up");
    }

    #[test]
    #[should_panic(expected = "only the mask's owner withdraws")]
    fn a_stranger_cannot_withdraw_a_copy() {
        let mut m = copy(BPS, FUND);
        as_("nina.near", FUND + ONE);
        let _ = m.withdraw();
    }

    /// Anyone may pay the author, and only ever the author's own account.
    #[test]
    fn anyone_pays_the_author_and_only_the_author() {
        let mut m = copy(BPS, FUND);
        as_("bob.near", FUND + ONE);
        let _ = m.pay_author();
        let to: Vec<AccountId> = get_created_receipts().into_iter().map(|r| r.receiver_id).collect();
        assert_eq!(to, vec![acc("nina.masks.near")]);
        assert_eq!(sent_to("nina.masks.near"), vec![ONE * 3 / 10]);
    }

    #[test]
    #[should_panic(expected = "no author share to pay")]
    fn a_plain_mask_pays_no_author() {
        let mut m = mask();
        as_("bob.near", 2 * ONE);
        let _ = m.pay_author();
    }

    /// What the site reads: what the author was paid and is owed (earned, never down), what `pay_author` would send now,
    /// what the owner's `withdraw` would.
    #[test]
    fn the_terms_tell_the_author_and_the_owner_their_parts() {
        let mut m = copy(BPS, FUND);
        as_("bob.near", FUND + ONE);
        let t = m.terms().unwrap();
        assert_eq!(t, Terms { paid: 0, owed: 0, due: ONE * 3 / 10, owner: FUND + ONE - keep() - ONE * 3 / 10 });
        settle(&mut m, FUND + ONE);
        as_("bob.near", FUND + ONE);
        assert_eq!(m.terms().unwrap().owed, ONE * 3 / 10, "counted at settle");
        assert!(mask().terms().is_none(), "a plain mask has no terms");
    }

    #[test]
    fn share_rounds_down_without_overflow() {
        assert_eq!(share(ONE, 3000), ONE * 3 / 10);
        assert_eq!(share(9_999, 3000), 2_999);
        assert_eq!(share(u128::MAX, 3000), u128::MAX / 10_000 * 3000 + u128::MAX % 10_000 * 3000 / 10_000);
    }

    // ---- moving to new code ------------------------------------------------------------------------------------

    /// Review finding 7: the first mask code wrote only the factory and the owner. near-sdk's `state_read` panics on
    /// those bytes, so in the code under review `migrate` never reached its second reading and an early mask could not
    /// move. Now the raw state is read as this code's, then as the first one's.
    #[test]
    fn an_early_mask_s_state_moves_to_this_code() {
        let v1 = near_sdk::borsh::to_vec(&MaskV1 { factory: acc("masks.near"), owner: acc("ann.near") }).unwrap();
        assert!(Mask::try_from_slice(&v1).is_err(), "the old bytes are not this code's state");
        let m = Mask::from_state(&v1).expect("read as the first code's state");
        assert_eq!(m, Mask { factory: acc("masks.near"), owner: acc("ann.near"), author: None });
    }

    #[test]
    fn this_code_s_state_reads_as_it_is() {
        let c = copy(BPS, FUND);
        let raw = near_sdk::borsh::to_vec(&c).unwrap();
        assert_eq!(Mask::from_state(&raw), Some(c));
        assert_eq!(Mask::from_state(b"not a mask"), None);
    }

    #[test]
    #[should_panic(expected = "only the factory that forged this mask")]
    fn only_the_factory_moves_the_code() {
        let m = mask();
        as_("ann.near", ONE);
        let _ = m.use_code([7; 32]);
    }

    impl Mask {
        fn clone_for_test(&self) -> Mask {
            Mask::try_from_slice(&near_sdk::borsh::to_vec(self).unwrap()).unwrap()
        }
    }
}
