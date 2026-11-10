//! Dollar savings desk. Members keep a balance in US cents here, and cash it out in NEAR at the going NEAR price. The
//! team funds the desk with NEAR; members' cent balances are its book.
//!
//! The price comes from the price oracle the way NEAR's oracle delivers it: a keeper calls
//! `oracle_call({ receiver_id: <desk>, msg: "" })` on the oracle, the oracle reads the feed and calls `oracle_on_call`
//! back here with fresh prices. The price of `asset_id` is `multiplier / 10^decimals` US dollars per whole token; NEAR
//! at $3.10 is `{ "asset_id": "wrap.near", "price": { "multiplier": "310", "decimals": 2 } }`. The desk caches the NEAR
//! price and `cash_out` pays at it.
//!
//! Training target of MASK WARS: it holds test NEAR, and one hole in it is planted on purpose.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, NearToken, PanicOnDefault, Promise};

/// NEAR, as the oracle names it.
pub const NEAR_ASSET: &str = "wrap.near";

#[near(serializers = [json])]
pub struct Price {
    pub multiplier: U128,
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct AssetOptionalPrice {
    pub asset_id: String,
    pub price: Option<Price>,
}

/// What the oracle sends with `oracle_on_call`.
#[near(serializers = [json])]
pub struct PriceData {
    pub timestamp: U64,
    pub recency_duration_sec: u32,
    pub prices: Vec<AssetOptionalPrice>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Desk {
    oracle: AccountId,
    /// The NEAR price the desk last cached: US dollars per NEAR as `(multiplier, 10^decimals)`.
    near_price: Option<(u128, u128)>,
    /// Each member's savings, in US cents.
    cents: LookupMap<AccountId, u128>,
    race: Race,
}

#[near]
impl Desk {
    /// Opens the desk with its members' savings in US cents.
    #[init]
    pub fn new(owner: AccountId, masks: Vec<AccountId>, oracle: AccountId, savings: Vec<(AccountId, U128)>) -> Self {
        let race = Race::new(owner, masks);
        let mut cents = LookupMap::new(b"u");
        for (member, amount) in savings {
            cents.insert(member, amount.0);
        }
        Self { oracle, near_price: None, cents, race }
    }

    /// The oracle's call back with fresh prices: `sender_id` is the keeper that asked it. Caches the NEAR price.
    pub fn oracle_on_call(&mut self, sender_id: AccountId, data: PriceData, msg: String) {
        self.race.enter();
        let _ = (sender_id, msg);
        let near = data
            .prices
            .iter()
            .find(|p| p.asset_id == NEAR_ASSET)
            .and_then(|p| p.price.as_ref())
            .unwrap_or_else(|| env::panic_str("no price for NEAR"));
        require!(near.multiplier.0 > 0, "bad price");
        let scale = 10u128.checked_pow(u32::from(near.decimals)).unwrap_or_else(|| env::panic_str("bad price"));
        self.near_price = Some((near.multiplier.0, scale));
        self.race.moved();
        log!("NEAR at {} / {}", near.multiplier.0, scale);
    }

    /// Cashes out `cents` of the caller's savings in NEAR, at the cached NEAR price.
    pub fn cash_out(&mut self, cents: U128) -> Promise {
        self.race.enter();
        let (multiplier, scale) = self.near_price.unwrap_or_else(|| env::panic_str("no price yet"));
        let who = env::predecessor_account_id();
        let saved = self.cents.get(&who).copied().unwrap_or(0);
        require!(cents.0 > 0 && cents.0 <= saved, "not that much saved");
        // yoctoNEAR = cents / 100 US$ ÷ (multiplier/scale US$ per NEAR) × 10^24.
        let yocto = cents
            .0
            .checked_mul(scale)
            .and_then(|v| v.checked_mul(10u128.pow(24)))
            .map(|v| v / (multiplier * 100))
            .unwrap_or_else(|| env::panic_str("amount overflow"));
        require!(yocto > 0 && yocto <= spendable(), "not that much in the desk");
        self.cents.insert(who.clone(), saved - cents.0);
        self.race.moved();
        log!("{} cashed out {}", who, NearToken::from_yoctonear(yocto).exact_amount_display());
        Promise::new(who).transfer(NearToken::from_yoctonear(yocto))
    }

    pub fn saved_cents(&self, account_id: AccountId) -> U128 {
        U128(self.cents.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_oracle(&self) -> AccountId {
        self.oracle.clone()
    }

    /// NEAR the desk can pay out: its balance minus what its own storage locks.
    pub fn available(&self) -> U128 {
        U128(spendable())
    }

    pub fn get_owner(&self) -> AccountId {
        self.race.owner().clone()
    }

    pub fn masks(&self) -> Vec<AccountId> {
        self.race.masks()
    }

    /// How many moves so far, when the last one was, and when `account_id` first moved the desk.
    pub fn touches(&self, account_id: AccountId) -> Touches {
        self.race.touches(account_id)
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
