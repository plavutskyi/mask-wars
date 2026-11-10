//! Who can change the factory, and how slowly. The factory's account holds no key: nobody can deploy code to it or
//! move its NEAR by hand. Its admin proposes one change at a time, the change waits in the open (`pending`), and then
//! anyone applies it:
//!
//! - once any mask exists, every change waits `CHANGE_DELAY_HOURS`: an owner who does not like it has three days to
//!   take their NEAR back (`unfuel`) and their winnings out of the mask. The winnings sit on the mask's own account,
//!   where the factory cannot count them, and new factory code could move every mask to new code: so the wait holds
//!   even when every tank here is empty;
//! - before the first mask is forged, the notice is `CHANGE_NOTICE_HOURS`;
//! - a change nobody applies lapses `CHANGE_LAPSE_HOURS` after it is ready: an old proposal cannot be applied by
//!   surprise months later.
//!
//! The catalog (models, looks, styles) changes at once: it only decides what new masks may be forged with. The teams
//! whose rounds masks race in wait like any other change: a new team could send masks into rounds of its own.

use crate::{
    catalog_ok, event, hex64_ok, strategy_key_ok, teams_ok, Catalog, Code, Config, Factory, FactoryExt, FactoryV1,
    MaskCode, CALLBACK_GAS,
};
use near_sdk::json_types::U64;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

/// Long enough for every owner to take their NEAR out first.
pub const CHANGE_DELAY_HOURS: u64 = 72;
/// The least any change waits in the open.
pub const CHANGE_NOTICE_HOURS: u64 = 1;
/// How long a ready change may still be applied.
pub const CHANGE_LAPSE_HOURS: u64 = 24;
/// What NEAR burns for each byte of a global contract: 0.0001 NEAR.
pub const GLOBAL_CODE_BYTE_COST: u128 = 100_000_000_000_000_000_000;
const NS_PER_HOUR: u64 = 3_600_000_000_000;
const MIGRATE_GAS: Gas = Gas::from_tgas(50);

/// A change the admin may propose.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    /// New factory code: the sha256 of the wasm, lowercase hex. `upgrade` takes the wasm itself.
    Code {
        sha256: String,
    },
    /// New mask code for masks forged from now on, and for owners who `renew`. `publish_mask_code` puts it on chain.
    MaskCode {
        sha256: String,
    },
    Admin {
        account: AccountId,
    },
    Keeper {
        account: AccountId,
    },
    Treasury {
        account: AccountId,
    },
    Arena {
        account: AccountId,
    },
    /// The mind's public key for sealing new strategies, `x25519:<hex>`, made in its TEE (`services/brain`).
    StrategyKey {
        key: String,
    },
    /// The teams whose rounds masks are armed for. New variants go last: a pending change is kept in Borsh.
    Teams {
        accounts: Vec<AccountId>,
    },
}

/// A proposed change and when it may apply.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub change: Change,
    pub proposed_ns: U64,
    /// From then on it applies while no mask has been forged.
    pub notice_ns: U64,
    /// From then on it applies in any case.
    pub ready_ns: U64,
}

#[near]
impl Factory {
    /// The admin proposes one change. It shows in `pending` at once and applies after the wait. A change that lapsed
    /// makes way for the next one.
    pub fn propose(&mut self, change: Change) -> Pending {
        self.only_admin();
        require!(self.pending.as_ref().is_none_or(|p| self.lapsed(p)), "a change is already pending: cancel it first");
        match &change {
            Change::Code { sha256 } | Change::MaskCode { sha256 } => {
                require!(hex64_ok(sha256), "code: the wasm's sha256 in hex")
            }
            Change::StrategyKey { key } => require!(strategy_key_ok(key), "strategy key: x25519:<64 hex>"),
            Change::Teams { accounts } => require!(
                teams_ok(accounts, &self.arena),
                "teams: 1 to 8 accounts, none twice, none the arena, the factory or a mask"
            ),
            Change::Admin { .. } | Change::Keeper { .. } | Change::Treasury { .. } | Change::Arena { .. } => {}
        }
        let now = env::block_timestamp();
        let p = Pending {
            change,
            proposed_ns: U64(now),
            notice_ns: U64(now + CHANGE_NOTICE_HOURS * NS_PER_HOUR),
            ready_ns: U64(now + CHANGE_DELAY_HOURS * NS_PER_HOUR),
        };
        event("propose", &p);
        self.pending = Some(p.clone());
        p
    }

    /// The admin withdraws the pending change.
    pub fn cancel(&mut self) -> Option<Pending> {
        self.only_admin();
        let p = self.pending.take();
        event("cancel", &p);
        p
    }

    /// Applies the pending change once its wait is over. Anyone may call it. New code comes with `upgrade`.
    pub fn apply(&mut self) -> Config {
        let p = self.ready_change();
        match p.change.clone() {
            Change::Code { .. } => env::panic_str("new code comes with upgrade, which takes the wasm"),
            Change::MaskCode { sha256 } => self.mask_code = MaskCode { sha256, published: false },
            Change::Admin { account } => self.admin = account,
            Change::Keeper { account } => self.keeper = account,
            Change::Treasury { account } => self.treasury = account,
            Change::Arena { account } => self.arena = account,
            Change::StrategyKey { key } => self.strategy_key = Some(key),
            Change::Teams { accounts } => self.teams = accounts,
        }
        event("apply", &p.change);
        self.pending = None;
        self.config()
    }

    /// Deploys the pending factory code once its wait is over: the input is the wasm itself, not JSON, and its sha256
    /// must be the proposed one. `migrate` runs in the same batch and keeps every mask. Anyone may call it.
    pub fn upgrade(&mut self) -> Promise {
        let p = self.ready_change();
        let Change::Code { sha256 } = &p.change else {
            env::panic_str("the pending change is not new code: use apply");
        };
        let code = env::input().unwrap_or_default();
        require!(&sha256_hex(&code) == sha256, "this wasm is not the proposed code");
        event("upgrade", &Code { sha256 });
        self.pending = None;
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            vec![],
            NearToken::from_yoctonear(0),
            MIGRATE_GAS,
        )
    }

    /// Reads the state the code finds and keeps every mask: the current layout as it is, the first one (`FactoryV1`)
    /// with nothing published in flight, no race armed yet in the hour's count and its admin as its one team.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no factory here"));
        if let Ok(now) = near_sdk::borsh::from_slice::<Self>(&raw) {
            return now;
        }
        let v1 = near_sdk::borsh::from_slice::<FactoryV1>(&raw)
            .unwrap_or_else(|_| env::panic_str("unknown state: nothing migrated"));
        event("migrate", &Migrated { from: "v1" });
        v1.into()
    }

    /// Publishes the mask code as a global contract, by its hash: the input is the wasm itself, and its sha256 must
    /// be the factory's mask code. NEAR burns 0.0001 NEAR a byte for it (about 5 NEAR), once. Anyone may call it until
    /// it is published, one at a time, and only while the factory's own NEAR covers the price: the masks' tanks and
    /// holds never pay for it.
    pub fn publish_mask_code(&mut self) -> Promise {
        require!(!self.mask_code.published, "the mask code is already published");
        require!(!self.publishing, "the mask code is already on its way");
        let code = env::input().unwrap_or_default();
        require!(sha256_hex(&code) == self.mask_code.sha256, "this wasm is not the factory's mask code");
        let price = GLOBAL_CODE_BYTE_COST * code.len() as u128;
        require!(self.own_near() >= price, "the factory's own NEAR does not cover publishing: top it up first");
        self.publishing = true;
        Promise::new(env::current_account_id()).deploy_global_contract(code).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_published(self.mask_code.sha256.clone()),
        )
    }

    #[private]
    pub fn on_published(&mut self, sha256: String, #[callback_result] done: Result<(), PromiseError>) -> bool {
        self.publishing = false;
        if done.is_err() || self.mask_code.sha256 != sha256 {
            env::log_str("the mask code was not published");
            return false;
        }
        self.mask_code.published = true;
        event("publish", &Code { sha256: &sha256 });
        true
    }

    /// The admin sets what new masks may be forged with. Masks already forged keep theirs.
    pub fn set_catalog(&mut self, catalog: Catalog) -> Catalog {
        self.only_admin();
        require!(catalog_ok(&catalog), "catalog: 1 to 16 ids in each list, each a model or a slug");
        event("catalog", &catalog);
        self.catalog = catalog.clone();
        catalog
    }

    /// The change waiting to apply, if any.
    pub fn pending(&self) -> Option<Pending> {
        self.pending.clone()
    }
}

impl Factory {
    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "only the admin proposes changes");
    }

    /// When the change may apply: after the notice while no mask exists, after the full wait once one does.
    fn ready_at(&self, p: &Pending) -> u64 {
        if self.names.is_empty() {
            p.notice_ns.0
        } else {
            p.ready_ns.0
        }
    }

    pub(crate) fn lapsed(&self, p: &Pending) -> bool {
        env::block_timestamp() >= self.ready_at(p) + CHANGE_LAPSE_HOURS * NS_PER_HOUR
    }

    fn ready_change(&self) -> Pending {
        let p = self.pending.clone().unwrap_or_else(|| env::panic_str("no change is pending"));
        require!(env::block_timestamp() >= self.ready_at(&p), "the change is still waiting");
        require!(!self.lapsed(&p), "the change lapsed: the admin proposes it again");
        p
    }

    /// The factory's own NEAR: its balance less its storage and less everything it holds for the masks. Each mask
    /// prepaid `RACE_BYTES` for its race record when it was forged; that NEAR is the masks' even while the record is
    /// not written yet, so it is never the factory's own (an armed mask's record counts twice: never too much).
    pub(crate) fn own_near(&self) -> u128 {
        let reserved = u128::from(self.names.len()) * u128::from(crate::RACE_BYTES);
        let storage = env::storage_byte_cost().as_yoctonear() * (u128::from(env::storage_usage()) + reserved);
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage)
            .saturating_sub(self.total_brain)
            .saturating_sub(self.total_held)
    }
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Migrated<'a> {
    from: &'a str,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
