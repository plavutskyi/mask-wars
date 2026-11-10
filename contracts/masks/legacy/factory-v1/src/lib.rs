//! The mask factory exactly as it was first merged (`main` at a113cc1), kept only so the sandbox can upgrade a factory
//! with masks in it to the current code (`sandbox/tests/review.rs`). Never deployed from here.
//!
//! MASK WARS mask factory. A person forges a mask: a look, a mind (a model that runs inside a TEE on NEAR AI Cloud),
//! a style, and, if they like, one line of strategy that only the mind can read. The deposit fuels the mask's mind.
//!
//! What forging makes:
//! - the mask's own account, `<name>.<factory>`, created with no access key at all and with the mask code on it as a
//!   global contract (`../mask`). Nobody holds a full key to a mask, the person and the arena included;
//! - a record here: the owner, the look, the model, the style, the sealed strategy and the mind's tank.
//!
//! How the mask races and pays for its mind:
//! - the keeper (the arena's race runner) arms the mask for one race: it holds at most `race_limit` from the tank and
//!   gives the mask two race keys, function-call keys on the arena (`commit`, `reveal`, `claim_drain`, `settle`) and on
//!   the race's target. A race key cannot attach NEAR, so it cannot move the mask's money;
//! - when the race is over, the keeper settles it: what the mind spent, never more than it held, goes to the
//!   treasury that pays NEAR AI; the rest goes back to the tank, and the keys are removed. If the keeper never
//!   settles, anyone releases the hold after `release_minutes`, and the mind pays nothing for that race;
//! - the deposit only ever pays for the mind and the mask's own gas. It is never a prize: prizes come from the teams
//!   and sponsors who open races. What the mask wins lands on its own account, and only its owner takes it out.
//!
//! The owner may pause the mask (its race keys go at once), take back what is left in the tank, and top it up.
//! The factory's account holds no key: its code and its settings change only after a wait anyone can see (`admin`).

mod admin;

pub use admin::{Change, Pending, CHANGE_DELAY_HOURS, CHANGE_NOTICE_HOURS};

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PublicKey,
};

/// The least a person puts in to forge a mask.
pub const MIN_FUEL: NearToken = NearToken::from_near(1);
/// What goes from the deposit onto the mask's own account: its storage and the gas its race keys burn.
pub const MASK_FUND: NearToken = NearToken::from_millinear(300);
/// The least anyone adds to a mask's tank at a time.
pub const MIN_REFUEL: NearToken = NearToken::from_millinear(100);
/// How much one race may spend on the mind, unless the person forging says otherwise, and the bounds they may set.
pub const DEFAULT_RACE_LIMIT: NearToken = NearToken::from_millinear(50);
pub const MIN_RACE_LIMIT: NearToken = NearToken::from_millinear(10);
pub const MAX_RACE_LIMIT: NearToken = NearToken::from_near(1);
/// Masks one person may forge.
pub const MAX_MASKS_PER_OWNER: usize = 8;
/// What a mask's key on the arena may call: the sealed round's methods (RULES.md).
pub const ARENA_METHODS: [&str; 4] = ["commit", "reveal", "claim_drain", "settle"];
/// Gas each race key may burn. A claim prepays 200 TGas at 0.001 NEAR a TGas, and a key's allowance never gets the
/// unused part back; a target key only plays a few calls.
pub const ARENA_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(400);
pub const TARGET_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(100);
pub const MAX_TARGET_METHODS: usize = 4;
/// A sealed strategy: `v1.` and the base64url (no padding) of 32 + 12 + 512 + 16 bytes: the browser's ephemeral
/// X25519 key, the nonce, the line padded to 512 bytes, the AES-GCM tag (`services/brain`).
pub const STRATEGY_BOX_LEN: usize = 3 + 763;
/// Names a person cannot take: the arena's own masks and the words the arena speaks with.
pub const RESERVED: [&str; 19] = [
    "nova", "onyx", "oracle", "wraith", "ronin", "volt", "phantom", "jinx", "maskwars", "admin", "arena", "keeper",
    "treasury", "bounty", "judge", "vault", "safe", "forge", "masks",
];
/// Kept with every mask for the race it is armed for: the race id and two keys.
const TAB_BYTES: u64 = 256;
const NS_PER_MINUTE: u64 = 60_000_000_000;
const INIT_GAS: Gas = Gas::from_tgas(10);
const KEYS_GAS: Gas = Gas::from_tgas(15);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Masks,
    Names,
    Owners,
}

/// The ids a mask may be forged with. The site shows only what is listed here.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Catalog {
    /// Models on NEAR AI Cloud that run in a Confidential TEE, by their canonical id.
    pub models: Vec<String>,
    pub looks: Vec<String>,
    pub styles: Vec<String>,
}

/// The mask contract every new mask gets: a global contract by its code hash.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MaskCode {
    /// SHA-256 of the wasm, lowercase hex: NEAR's code hash of the global contract.
    pub sha256: String,
    /// Published on chain as a global contract (`publish_mask_code`).
    pub published: bool,
}

/// A strategy line, sealed in the browser for the mind's key, which lives in a TEE (`services/brain`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Sealed {
    /// The key it was sealed for, `x25519:<hex>`.
    pub key: String,
    pub sealed: String,
}

/// The race a mask is armed for.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Tab {
    pub race: String,
    /// Taken from the tank for this race: the most its mind may spend.
    pub held: u128,
    /// The race keys on the mask's account; empty once the owner paused it.
    pub keys: Vec<PublicKey>,
    pub armed_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mask {
    pub owner: AccountId,
    pub look: String,
    pub model: String,
    pub style: String,
    pub strategy: Option<Sealed>,
    pub born_ns: u64,
    /// Everything put into the mask, at forging and since: the base of its ×.
    pub fuel: u128,
    /// The tank: what its mind may still spend.
    pub brain: u128,
    /// What its mind has spent, in all races.
    pub spent: u128,
    pub race_limit: u128,
    pub races: u32,
    /// The account exists and races; `false` while the forging batch is still on its way.
    pub ready: bool,
    pub paused: bool,
    pub tab: Option<Tab>,
    /// The mask code on its account, sha256 hex.
    pub code: String,
}

/// A mask as the site, the arena and other agents read it. Amounts are yoctoNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MaskView {
    pub name: String,
    pub account: AccountId,
    pub owner: AccountId,
    pub look: String,
    pub model: String,
    pub style: String,
    /// The mask has a sealed strategy. Its text never leaves the TEE.
    pub strategy: bool,
    pub born_ns: U64,
    pub fuel: U128,
    pub brain: U128,
    pub spent: U128,
    pub race_limit: U128,
    pub races: u32,
    /// `forging`, `ready`, `racing` or `paused`.
    pub state: String,
    pub race: Option<RaceView>,
    pub code: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RaceView {
    pub race: String,
    pub held: U128,
    pub armed_ns: U64,
    /// Race keys still on the mask's account.
    pub keys: Vec<PublicKey>,
}

/// What the site needs to forge, and the factory's settings, as `config` shows them. Amounts are yoctoNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub admin: AccountId,
    pub keeper: AccountId,
    pub treasury: AccountId,
    pub arena: AccountId,
    pub mask_code: MaskCode,
    pub strategy_key: Option<String>,
    pub catalog: Catalog,
    pub release_minutes: u32,
    /// Masks forged so far.
    pub masks: u32,
    /// NEAR in every tank, and NEAR that races hold: it belongs to the masks.
    pub total_brain: U128,
    pub total_held: U128,
    pub min_fuel: U128,
    pub mask_fund: U128,
    pub min_refuel: U128,
    pub race_limit: Limits,
    pub arena_methods: Vec<String>,
    pub pending: Option<Pending>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    pub default: U128,
    pub min: U128,
    pub max: U128,
}

/// One race key, as the mask contract takes it (Borsh). The mask contract checks it again.
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct RaceKey {
    public_key: PublicKey,
    receiver_id: AccountId,
    method_names: Vec<String>,
    allowance: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    /// Proposes changes and keeps the catalog.
    admin: AccountId,
    /// Arms masks for races and settles what their minds spent.
    keeper: AccountId,
    /// Where the minds' spending goes: the account that pays NEAR AI.
    treasury: AccountId,
    /// The bounty contract: every mask's arena key calls it.
    arena: AccountId,
    mask_code: MaskCode,
    /// The mind's public key for sealing strategies, `x25519:<hex>`; `None` until the TEE has made one.
    strategy_key: Option<String>,
    catalog: Catalog,
    /// After this long anyone may release a race the keeper never settled.
    release_minutes: u32,
    masks: LookupMap<String, Mask>,
    /// Names in the order they were forged.
    names: Vector<String>,
    owners: LookupMap<AccountId, Vec<String>>,
    /// Sum of every tank, and of what races hold: NEAR that belongs to the masks.
    total_brain: u128,
    total_held: u128,
    pending: Option<Pending>,
}

#[near]
impl Factory {
    /// The factory's account is created, funded, given this code and initialized in one transaction that adds no key.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        admin: AccountId,
        keeper: AccountId,
        treasury: AccountId,
        arena: AccountId,
        mask_code: String,
        strategy_key: Option<String>,
        catalog: Catalog,
        release_minutes: u32,
    ) -> Self {
        require!(hex64_ok(&mask_code), "mask_code: the mask wasm's sha256 in hex");
        require!(strategy_key.as_deref().is_none_or(strategy_key_ok), "strategy_key: x25519:<64 hex>");
        require!(catalog_ok(&catalog), "catalog: 1 to 16 ids in each list, each a model or a slug");
        require!((1..=7 * 24 * 60).contains(&release_minutes), "release_minutes: 1 minute to 7 days");
        Self {
            admin,
            keeper,
            treasury,
            arena,
            mask_code: MaskCode { sha256: mask_code, published: false },
            strategy_key,
            catalog,
            release_minutes,
            masks: LookupMap::new(Key::Masks),
            names: Vector::new(Key::Names),
            owners: LookupMap::new(Key::Owners),
            total_brain: 0,
            total_held: 0,
            pending: None,
        }
    }

    // -------------------------------------------------------------------------------------------------------------
    // The person
    // -------------------------------------------------------------------------------------------------------------

    /// Forges a mask named `name`: its account `<name>.<factory>` with no key, the mask code, and its record. The
    /// attached NEAR pays the record's storage, `MASK_FUND` for the mask's own account, and the rest fills its tank.
    /// `strategy` is a line sealed in the browser for the mind's key; `race_limit` caps one race's spending.
    #[payable]
    pub fn forge(
        &mut self,
        name: String,
        look: String,
        model: String,
        style: String,
        strategy: Option<String>,
        race_limit: Option<U128>,
    ) -> Promise {
        let owner = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(self.mask_code.published, "the forge opens once the mask code is published");
        require!(name_ok(&name), "name: 3 to 16 lowercase letters and digits, starting with a letter");
        require!(!RESERVED.contains(&name.as_str()), "this name belongs to the arena");
        require!(!self.masks.contains_key(&name), "this name is taken");
        require!(!owner.is_sub_account_of(env::current_account_id()), "a mask does not forge masks");
        require!(self.catalog.looks.contains(&look), "pick a look from the catalog");
        require!(self.catalog.models.contains(&model), "pick a model from the catalog");
        require!(self.catalog.styles.contains(&style), "pick a style from the catalog");
        let strategy = strategy.map(|sealed| {
            let key =
                self.strategy_key.clone().unwrap_or_else(|| env::panic_str("strategies open once the mind has a key"));
            require!(sealed_ok(&sealed), "strategy: a sealed box, v1.<base64url>");
            Sealed { key, sealed }
        });
        let race_limit = race_limit.map_or(DEFAULT_RACE_LIMIT.as_yoctonear(), |l| l.0);
        require!(
            (MIN_RACE_LIMIT.as_yoctonear()..=MAX_RACE_LIMIT.as_yoctonear()).contains(&race_limit),
            "race_limit: 0.01 to 1 NEAR"
        );
        require!(deposit >= MIN_FUEL.as_yoctonear(), "forging takes at least 1 NEAR");
        let mut mine = self.owners.get(&owner).cloned().unwrap_or_default();
        require!(mine.len() < MAX_MASKS_PER_OWNER, "one person forges at most 8 masks");

        let before = env::storage_usage();
        let mask = Mask {
            owner: owner.clone(),
            look,
            model,
            style,
            strategy,
            born_ns: env::block_timestamp(),
            fuel: deposit,
            brain: 0,
            spent: 0,
            race_limit,
            races: 0,
            ready: false,
            paused: false,
            tab: None,
            code: self.mask_code.sha256.clone(),
        };
        self.masks.insert(name.clone(), mask);
        self.names.push(name.clone());
        mine.push(name.clone());
        self.owners.insert(owner.clone(), mine);
        self.masks.flush();
        self.owners.flush();
        self.names.flush();
        let bytes = env::storage_usage().saturating_sub(before) + TAB_BYTES;
        let storage = env::storage_byte_cost().as_yoctonear() * u128::from(bytes);
        let fund = MASK_FUND.as_yoctonear();
        let brain = deposit
            .checked_sub(storage + fund)
            .filter(|b| *b >= race_limit)
            .unwrap_or_else(|| env::panic_str("the deposit must cover the mask's account and at least one race"));
        let m = self.masks.get_mut(&name).unwrap();
        m.brain = brain;
        self.total_brain += brain;

        let account = self.account_of(&name);
        let code = hex32(&self.mask_code.sha256);
        Promise::new(account)
            .create_account()
            .transfer(NearToken::from_yoctonear(fund))
            .use_global_contract(code)
            .function_call(
                "init".to_string(),
                near_sdk::borsh::to_vec(&owner).unwrap(),
                NearToken::from_yoctonear(0),
                INIT_GAS,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_forged(name))
    }

    /// Adds the attached NEAR to the mask's tank. Anyone may: the owner, or a fan of the mask.
    #[payable]
    pub fn refuel(&mut self, name: String) -> MaskView {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= MIN_REFUEL.as_yoctonear(), "refuel with at least 0.1 NEAR");
        let m = self.ready_mask(&name);
        m.brain += deposit;
        m.fuel += deposit;
        self.total_brain += deposit;
        let by = env::predecessor_account_id();
        event("refuel", &Moved { name: &name, by: Some(&by), amount: U128(deposit) });
        self.view(&name)
    }

    /// The owner takes back what is left in the tank: `amount`, or all of it. What a race holds stays with the race.
    pub fn unfuel(&mut self, name: String, amount: Option<U128>) -> Promise {
        let owner = self.only_owner(&name);
        let m = self.ready_mask(&name);
        let amount = amount.map_or(m.brain, |a| a.0);
        require!(amount > 0 && amount <= m.brain, "the tank does not hold that much");
        m.brain -= amount;
        self.total_brain -= amount;
        event("unfuel", &Moved { name: &name, by: None, amount: U128(amount) });
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount))
    }

    /// The owner stops the mask: its race keys go at once, and the keeper arms it for no new race. The race it is in
    /// is still settled, for what its mind spent until now.
    pub fn pause(&mut self, name: String) -> MaskView {
        self.only_owner(&name);
        let account = self.account_of(&name);
        let m = self.ready_mask(&name);
        require!(!m.paused, "the mask is already paused");
        m.paused = true;
        let keys = m.tab.as_mut().map(|t| std::mem::take(&mut t.keys)).unwrap_or_default();
        if !keys.is_empty() {
            remove_keys(account, keys);
        }
        event("pause", &Named { name: &name });
        self.view(&name)
    }

    pub fn resume(&mut self, name: String) -> MaskView {
        self.only_owner(&name);
        let m = self.ready_mask(&name);
        require!(m.paused, "the mask is not paused");
        m.paused = false;
        event("resume", &Named { name: &name });
        self.view(&name)
    }

    /// The owner moves the mask to the factory's current mask code, published as a global contract.
    pub fn renew(&mut self, name: String) -> Promise {
        self.only_owner(&name);
        require!(self.mask_code.published, "the new mask code is not published yet");
        let code = self.mask_code.sha256.clone();
        let account = self.account_of(&name);
        let m = self.ready_mask(&name);
        require!(m.tab.is_none(), "renew between races");
        require!(m.code != code, "the mask already runs the current code");
        Promise::new(account)
            .function_call(
                "use_code".to_string(),
                near_sdk::borsh::to_vec(&hex32(&code)).unwrap(),
                NearToken::from_yoctonear(0),
                KEYS_GAS,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_renewed(name, code))
    }

    // -------------------------------------------------------------------------------------------------------------
    // The keeper
    // -------------------------------------------------------------------------------------------------------------

    /// Arms a mask for the race `race`: holds what its mind may spend in it, at most `race_limit`, and gives its
    /// account two race keys: `arena_key` on the arena for the sealed round, `target_key` on `target` for
    /// `target_methods`. Only the keeper.
    pub fn arm(
        &mut self,
        name: String,
        race: String,
        arena_key: PublicKey,
        target: AccountId,
        target_key: PublicKey,
        target_methods: Vec<String>,
    ) -> Promise {
        self.only_keeper();
        require!(race_ok(&race), "race: 1 to 64 letters, digits, - or _");
        require!(arena_key != target_key, "one key per receiver");
        let me = env::current_account_id();
        let account = self.account_of(&name);
        require!(
            target != self.arena && target != me && target != account && !target.is_sub_account_of(&me),
            "the target is neither the arena, the factory nor a mask"
        );
        require!(
            (1..=MAX_TARGET_METHODS).contains(&target_methods.len()) && target_methods.iter().all(|m| method_ok(m)),
            "target_methods: 1 to 4 method names"
        );
        let arena = self.arena.clone();
        let m = self.ready_mask(&name);
        require!(!m.paused, "the owner paused this mask");
        require!(m.tab.is_none(), "the mask is already in a race");
        let held = m.race_limit.min(m.brain);
        require!(held > 0, "the mind is out of fuel");
        m.brain -= held;
        m.tab = Some(Tab {
            race: race.clone(),
            held,
            keys: vec![arena_key.clone(), target_key.clone()],
            armed_ns: env::block_timestamp(),
        });
        self.total_brain -= held;
        self.total_held += held;
        let keys = vec![
            RaceKey {
                public_key: arena_key,
                receiver_id: arena,
                method_names: ARENA_METHODS.iter().map(|m| m.to_string()).collect(),
                allowance: ARENA_KEY_ALLOWANCE.as_yoctonear(),
            },
            RaceKey {
                public_key: target_key,
                receiver_id: target.clone(),
                method_names: target_methods,
                allowance: TARGET_KEY_ALLOWANCE.as_yoctonear(),
            },
        ];
        Promise::new(account)
            .function_call(
                "add_keys".to_string(),
                near_sdk::borsh::to_vec(&keys).unwrap(),
                NearToken::from_yoctonear(0),
                KEYS_GAS,
            )
            .then(Self::ext(me).with_static_gas(CALLBACK_GAS).on_armed(name, race, target))
    }

    /// Settles the race the mask is armed for: `spent`, never more than the race held, goes to the treasury; the rest
    /// goes back to the tank; the race keys are removed. Only the keeper.
    pub fn settle(&mut self, name: String, race: String, spent: U128) -> MaskView {
        self.only_keeper();
        let treasury = self.treasury.clone();
        let account = self.account_of(&name);
        let m = self.ready_mask(&name);
        let tab = m.tab.take().unwrap_or_else(|| env::panic_str("the mask is in no race"));
        require!(tab.race == race, "the mask is armed for another race");
        require!(spent.0 <= tab.held, "the mind cannot spend more than the race held");
        m.brain += tab.held - spent.0;
        m.spent += spent.0;
        m.races += 1;
        self.total_held -= tab.held;
        self.total_brain += tab.held - spent.0;
        if spent.0 > 0 {
            Promise::new(treasury).transfer(NearToken::from_yoctonear(spent.0)).detach();
        }
        if !tab.keys.is_empty() {
            remove_keys(account, tab.keys);
        }
        event("settle", &Settled { name: &name, race: &race, spent, back: U128(tab.held - spent.0) });
        self.view(&name)
    }

    /// Releases a race the keeper never settled: after `release_minutes` anyone may. The whole hold goes back to the
    /// tank, the mind pays nothing for that race, and the race keys are removed.
    pub fn release(&mut self, name: String) -> MaskView {
        let release_ns = u64::from(self.release_minutes) * NS_PER_MINUTE;
        let account = self.account_of(&name);
        let m = self.ready_mask(&name);
        let armed = m.tab.as_ref().unwrap_or_else(|| env::panic_str("the mask is in no race")).armed_ns;
        require!(env::block_timestamp() >= armed + release_ns, "the keeper still has time to settle");
        let tab = m.tab.take().unwrap();
        m.brain += tab.held;
        self.total_held -= tab.held;
        self.total_brain += tab.held;
        if !tab.keys.is_empty() {
            remove_keys(account, tab.keys);
        }
        event("release", &Settled { name: &name, race: &tab.race, spent: U128(0), back: U128(tab.held) });
        self.view(&name)
    }

    // -------------------------------------------------------------------------------------------------------------
    // Callbacks
    // -------------------------------------------------------------------------------------------------------------

    /// The mask's account is made, or the batch failed: then the record goes and the deposit goes back in full.
    #[private]
    pub fn on_forged(&mut self, name: String, #[callback_result] made: Result<(), PromiseError>) -> Option<MaskView> {
        let m = self.masks.get_mut(&name).unwrap_or_else(|| env::panic_str("no such forge"));
        if made.is_ok() {
            m.ready = true;
            let view = self.view(&name);
            event("forge", &view);
            return Some(view);
        }
        let m = self.masks.remove(&name).unwrap();
        self.total_brain -= m.brain;
        // The failed name is almost always the last one forged; keep the order of the others.
        if !self.names.is_empty() && self.names[self.names.len() - 1] == name {
            self.names.pop();
        } else if let Some(i) = (0..self.names.len()).rev().find(|i| self.names[*i] == name) {
            self.names.swap_remove(i);
        }
        let mut mine = self.owners.get(&m.owner).cloned().unwrap_or_default();
        mine.retain(|n| *n != name);
        if mine.is_empty() {
            self.owners.remove(&m.owner);
        } else {
            self.owners.insert(m.owner.clone(), mine);
        }
        env::log_str(&format!("forging {name} failed: the deposit goes back to {}", m.owner));
        Promise::new(m.owner).transfer(NearToken::from_yoctonear(m.fuel)).detach();
        None
    }

    /// The race keys are on the mask, or adding them failed: then the hold goes back to the tank.
    #[private]
    pub fn on_armed(
        &mut self,
        name: String,
        race: String,
        target: AccountId,
        #[callback_result] added: Result<(), PromiseError>,
    ) -> bool {
        if added.is_ok() {
            event("arm", &Armed { name: &name, race: &race, target: &target });
            return true;
        }
        let m = self.masks.get_mut(&name).unwrap();
        if let Some(tab) = m.tab.take_if(|t| t.race == race) {
            m.brain += tab.held;
            self.total_held -= tab.held;
            self.total_brain += tab.held;
        }
        env::log_str(&format!("arming {name} for {race} failed: the hold goes back to the tank"));
        false
    }

    #[private]
    pub fn on_renewed(
        &mut self,
        name: String,
        code: String,
        #[callback_result] moved: Result<(), PromiseError>,
    ) -> bool {
        if moved.is_err() {
            env::log_str(&format!("{name} stays on its code"));
            return false;
        }
        let m = self.masks.get_mut(&name).unwrap();
        m.code = code.clone();
        event("renew", &Renewed { name: &name, code: &code });
        true
    }

    // -------------------------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------------------------

    pub fn get_mask(&self, name: String) -> Option<MaskView> {
        self.masks.contains_key(&name).then(|| self.view(&name))
    }

    /// Masks in the order they were forged, from `from_index`, at most 50.
    pub fn list_masks(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<MaskView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(50);
        (from..self.names.len().min(from.saturating_add(limit))).map(|i| self.view(&self.names[i])).collect()
    }

    pub fn masks_of(&self, owner: AccountId) -> Vec<MaskView> {
        self.owners.get(&owner).map(|names| names.iter().map(|n| self.view(n)).collect()).unwrap_or_default()
    }

    /// What the mask's next race may spend on its mind: 0 while it is forging, paused, racing or out of fuel.
    pub fn budget(&self, name: String) -> U128 {
        U128(
            self.masks
                .get(&name)
                .filter(|m| m.ready && !m.paused && m.tab.is_none())
                .map_or(0, |m| m.race_limit.min(m.brain)),
        )
    }

    /// The sealed strategy, for the mind in its TEE: the key it was sealed for and the box. `None` without one.
    pub fn get_sealed_strategy(&self, name: String) -> Option<Sealed> {
        self.masks.get(&name)?.strategy.clone()
    }

    /// Whether `name` can be forged now.
    pub fn name_free(&self, name: String) -> bool {
        name_ok(&name) && !RESERVED.contains(&name.as_str()) && !self.masks.contains_key(&name)
    }

    /// Everything the site needs to forge: the catalog, the mind's key, the limits.
    pub fn config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            keeper: self.keeper.clone(),
            treasury: self.treasury.clone(),
            arena: self.arena.clone(),
            mask_code: self.mask_code.clone(),
            strategy_key: self.strategy_key.clone(),
            catalog: self.catalog.clone(),
            release_minutes: self.release_minutes,
            masks: self.names.len(),
            total_brain: U128(self.total_brain),
            total_held: U128(self.total_held),
            min_fuel: U128(MIN_FUEL.as_yoctonear()),
            mask_fund: U128(MASK_FUND.as_yoctonear()),
            min_refuel: U128(MIN_REFUEL.as_yoctonear()),
            race_limit: Limits {
                default: U128(DEFAULT_RACE_LIMIT.as_yoctonear()),
                min: U128(MIN_RACE_LIMIT.as_yoctonear()),
                max: U128(MAX_RACE_LIMIT.as_yoctonear()),
            },
            arena_methods: ARENA_METHODS.iter().map(|m| m.to_string()).collect(),
            pending: self.pending.clone(),
        }
    }
}

impl Factory {
    fn account_of(&self, name: &str) -> AccountId {
        format!("{name}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("no such mask"))
    }

    fn ready_mask(&mut self, name: &str) -> &mut Mask {
        let m = self.masks.get_mut(name).unwrap_or_else(|| env::panic_str("no such mask"));
        require!(m.ready, "the mask is still being forged");
        m
    }

    fn only_owner(&self, name: &str) -> AccountId {
        let m = self.masks.get(name).unwrap_or_else(|| env::panic_str("no such mask"));
        require!(env::predecessor_account_id() == m.owner, "only the mask's owner");
        m.owner.clone()
    }

    fn only_keeper(&self) {
        require!(env::predecessor_account_id() == self.keeper, "only the keeper arms and settles races");
    }

    fn view(&self, name: &str) -> MaskView {
        let m = self.masks.get(name).unwrap_or_else(|| env::panic_str("no such mask"));
        let state = if !m.ready {
            "forging"
        } else if m.paused {
            "paused"
        } else if m.tab.is_some() {
            "racing"
        } else {
            "ready"
        };
        MaskView {
            name: name.to_string(),
            account: self.account_of(name),
            owner: m.owner.clone(),
            look: m.look.clone(),
            model: m.model.clone(),
            style: m.style.clone(),
            strategy: m.strategy.is_some(),
            born_ns: U64(m.born_ns),
            fuel: U128(m.fuel),
            brain: U128(m.brain),
            spent: U128(m.spent),
            race_limit: U128(m.race_limit),
            races: m.races,
            state: state.into(),
            race: m.tab.as_ref().map(|t| RaceView {
                race: t.race.clone(),
                held: U128(t.held),
                armed_ns: U64(t.armed_ns),
                keys: t.keys.clone(),
            }),
            code: m.code.clone(),
        }
    }
}

/// Removes race keys from a mask's account. The factory knows exactly which keys it added, so this does not fail.
fn remove_keys(account: AccountId, keys: Vec<PublicKey>) {
    Promise::new(account)
        .function_call(
            "remove_keys".to_string(),
            near_sdk::borsh::to_vec(&keys).unwrap(),
            NearToken::from_yoctonear(0),
            KEYS_GAS,
        )
        .detach();
}

/// Logs a NEP-297 event: `EVENT_JSON:{"standard":"maskwars_masks","version":"1.0.0","event":…,"data":…}`.
pub(crate) fn event<T: Serialize>(name: &str, data: &T) {
    #[derive(Serialize)]
    #[serde(crate = "near_sdk::serde")]
    struct Event<'a, T> {
        standard: &'a str,
        version: &'a str,
        event: &'a str,
        data: &'a T,
    }
    let e = Event { standard: "maskwars_masks", version: "1.0.0", event: name, data };
    env::log_str(&format!("EVENT_JSON:{}", near_sdk::serde_json::to_string(&e).unwrap()));
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Named<'a> {
    name: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Moved<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    by: Option<&'a AccountId>,
    amount: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Armed<'a> {
    name: &'a str,
    race: &'a str,
    target: &'a AccountId,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Settled<'a> {
    name: &'a str,
    race: &'a str,
    spent: U128,
    back: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Renewed<'a> {
    name: &'a str,
    code: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub(crate) struct Code<'a> {
    pub(crate) sha256: &'a str,
}

/// 3 to 16 lowercase letters and digits, starting with a letter: the mask's name and the first part of its account.
pub fn name_ok(name: &str) -> bool {
    (3..=16).contains(&name.len())
        && name.as_bytes()[0].is_ascii_lowercase()
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// A race id as the bounty contract names races, e.g. `race-0004`.
pub fn race_ok(race: &str) -> bool {
    (1..=64).contains(&race.len()) && race.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A method name: 1 to 64 lowercase letters, digits or `_`.
pub fn method_ok(m: &str) -> bool {
    (1..=64).contains(&m.len()) && m.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A catalog id: a model id like `deepseek-ai/DeepSeek-V4.1-Flash-1017`, or a slug like `porcelain`.
pub fn id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
}

pub fn catalog_ok(c: &Catalog) -> bool {
    [&c.models, &c.looks, &c.styles].iter().all(|list| {
        (1..=16).contains(&list.len())
            && list.iter().all(|id| id_ok(id))
            && list.iter().enumerate().all(|(i, id)| !list[..i].contains(id))
    })
}

pub fn hex64_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The mind's key for sealing strategies: `x25519:` and 32 bytes in lowercase hex.
pub fn strategy_key_ok(s: &str) -> bool {
    s.strip_prefix("x25519:").is_some_and(hex64_ok)
}

/// A sealed strategy: `v1.` and exactly the base64url of one sealed box, so every strategy looks the same size.
pub fn sealed_ok(s: &str) -> bool {
    s.len() == STRATEGY_BOX_LEN
        && s.starts_with("v1.")
        && s.bytes().skip(3).all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 64 hex digits to 32 bytes; the caller has checked the hex.
pub fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("not hex"));
    }
    out
}
