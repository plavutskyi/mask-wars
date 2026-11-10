//! Who can change the factory, and how slowly. The factory's account holds no key: nobody can deploy code to it or
//! move its NEAR by hand. Its admin proposes one change at a time, the change waits in the open (`pending`), and then
//! anyone applies it:
//!
//! - while any mask has NEAR in its tank or held by a race, every change waits `CHANGE_DELAY_HOURS`: an owner who
//!   does not like it has three days to take their NEAR back (`unfuel`) and their winnings out of the mask;
//! - with no NEAR of any mask here, the notice is `CHANGE_NOTICE_HOURS`.
//!
//! The catalog (models, looks, styles) changes at once: it only decides what new masks may be forged with.

use crate::{
    catalog_ok, event, hex64_ok, strategy_key_ok, Catalog, Code, Config, Factory, FactoryExt, MaskCode, CALLBACK_GAS,
};
use near_sdk::json_types::U64;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

/// Long enough for every owner to take their NEAR out first.
pub const CHANGE_DELAY_HOURS: u64 = 72;
/// The least any change waits in the open.
pub const CHANGE_NOTICE_HOURS: u64 = 1;
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
}

/// A proposed change and when it may apply.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub change: Change,
    pub proposed_ns: U64,
    /// From then on it applies if no mask has NEAR here.
    pub notice_ns: U64,
    /// From then on it applies in any case.
    pub ready_ns: U64,
}

#[near]
impl Factory {
    /// The admin proposes one change. It shows in `pending` at once and applies after the wait.
    pub fn propose(&mut self, change: Change) -> Pending {
        self.only_admin();
        require!(self.pending.is_none(), "a change is already pending: cancel it first");
        match &change {
            Change::Code { sha256 } | Change::MaskCode { sha256 } => {
                require!(hex64_ok(sha256), "code: the wasm's sha256 in hex")
            }
            Change::StrategyKey { key } => require!(strategy_key_ok(key), "strategy key: x25519:<64 hex>"),
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

    /// Keeps the state as it is. A later code reads this layout and adds what it needs.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("no factory here"))
    }

    /// Publishes the mask code as a global contract, by its hash: the input is the wasm itself, and its sha256 must
    /// be the factory's mask code. The factory pays NEAR's price for it, 0.0001 NEAR a byte, once. Anyone may call
    /// it, until it is published.
    pub fn publish_mask_code(&mut self) -> Promise {
        require!(!self.mask_code.published, "the mask code is already published");
        let code = env::input().unwrap_or_default();
        require!(sha256_hex(&code) == self.mask_code.sha256, "this wasm is not the factory's mask code");
        Promise::new(env::current_account_id()).deploy_global_contract(code).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_published(self.mask_code.sha256.clone()),
        )
    }

    #[private]
    pub fn on_published(&mut self, sha256: String, #[callback_result] done: Result<(), PromiseError>) -> bool {
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

    fn ready_change(&self) -> Pending {
        let p = self.pending.clone().unwrap_or_else(|| env::panic_str("no change is pending"));
        let quiet = self.total_brain == 0 && self.total_held == 0;
        let ready = if quiet { p.notice_ns.0 } else { p.ready_ns.0 };
        require!(env::block_timestamp() >= ready, "the change is still waiting");
        p
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
