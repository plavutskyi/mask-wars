//! Who can change the season, and how slowly. The treasury's account holds no key: nobody can deploy code to it or move
//! its NEAR by hand. Its admin proposes one change at a time, the change waits in the open (`pending`), and then
//! anyone applies it:
//!
//! - what decides where the treasury's NEAR goes waits `CHANGE_DELAY_HOURS`: new code, a new admin, a new bounty
//!   contract, higher limits, a safe code a round may be made from, and a program with other masks, targets (their
//!   code, `init`, NEAR and loot), prize or judge;
//! - what only moves rounds in time waits `CHANGE_NOTICE_HOURS`: a program that differs only in its schedule and its
//!   windows, the scheduler, and lower limits.
//!
//! While a change that waits long is pending, every sponsor may take its share of the treasury back (`exit`): nobody's
//! NEAR goes to rounds the sponsor did not agree to. A change not applied within `CHANGE_EXPIRY_HOURS` of being ready
//! lapses. Taking a safe code off the list (`drop_safe_code`) needs no wait: it only stops new rounds on it.

use crate::{b58_32_ok, event, hex64_ok, Limits, Program, Season, SeasonExt, NS_PER_HOUR};
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

/// Long enough for everyone to see a change to where the treasury goes or how much of it a day may take, and for a
/// sponsor who does not want it to leave.
pub const CHANGE_DELAY_HOURS: u64 = 72;
/// The least any change waits in the open.
pub const CHANGE_NOTICE_HOURS: u64 = 1;
/// A ready change that nobody applied within this long lapses.
pub const CHANGE_EXPIRY_HOURS: u64 = 24;
const MIGRATE_GAS: Gas = Gas::from_tgas(50);
const ON_PUBLISHED_GAS: Gas = Gas::from_tgas(15);
/// What NEAR burns to publish a global contract, per byte of its code.
pub const GLOBAL_BYTE_COST: NearToken = NearToken::from_yoctonear(100_000_000_000_000_000_000);

/// A change the admin may propose.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    /// New code: the sha256 of the wasm, lowercase hex. `upgrade` takes the wasm itself.
    Code {
        sha256: String,
    },
    Admin {
        account: AccountId,
    },
    /// The bounty contract rounds open on: the bounty NEAR goes there.
    Bounty {
        account: AccountId,
    },
    /// Raising any limit waits long; only lowering is quick.
    Limits {
        limits: Limits,
    },
    Program {
        program: Program,
    },
    Scheduler {
        account: AccountId,
    },
    /// A safe code rounds may be made from: the code hash as NEAR shows it, base58. Waits long: the code decides who
    /// can take the NEAR a safe holds.
    AllowSafe {
        code_hash: String,
    },
}

/// A proposed change and when it may apply.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub change: Change,
    pub proposed_ns: U64,
    /// From then on anyone may apply it.
    pub ready_ns: U64,
    /// From then on it no longer applies: propose it again.
    pub expires_ns: U64,
    /// It waits `CHANGE_DELAY_HOURS`: until it is ready, sponsors may `exit`.
    pub long: bool,
}

/// Whether moving from program `a` to `b` changes only when rounds run: the schedule and the windows.
fn only_time(a: &Program, b: &Program) -> bool {
    a.masks == b.masks && a.targets == b.targets && a.prize == b.prize && a.judge_version == b.judge_version
}

#[near]
impl Season {
    /// The admin proposes one change. It shows in `pending` at once and can apply after the wait.
    pub fn propose(&mut self, change: Change) -> Pending {
        self.only_admin();
        require!(self.pending_change().is_none(), "a change is already pending: cancel it first");
        let long = match &change {
            Change::Code { sha256 } => {
                require!(hex64_ok(sha256), "code: the wasm's sha256 in hex");
                true
            }
            Change::Admin { .. } | Change::Bounty { .. } => true,
            Change::Limits { limits } => {
                self.check_limits(limits);
                limits.max_prize.0 > self.limits.max_prize.0
                    || limits.max_safe_fund.0 > self.limits.max_safe_fund.0
                    || limits.max_per_day > self.limits.max_per_day
            }
            Change::Program { program } => {
                self.check_program(program).unwrap_or_else(|e| env::panic_str(&e));
                !only_time(&self.program, program)
            }
            Change::Scheduler { .. } => false,
            Change::AllowSafe { code_hash } => {
                require!(b58_32_ok(code_hash), "safe code: a code hash in base58");
                require!(!self.safe_codes.contains(code_hash), "this safe code is already allowed");
                true
            }
        };
        let now = env::block_timestamp();
        let wait = if long { CHANGE_DELAY_HOURS } else { CHANGE_NOTICE_HOURS };
        let ready = now + wait * NS_PER_HOUR;
        let p = Pending {
            change,
            proposed_ns: U64(now),
            ready_ns: U64(ready),
            expires_ns: U64(ready + CHANGE_EXPIRY_HOURS * NS_PER_HOUR),
            long,
        };
        event("propose", &p);
        self.pending = Some(p.clone());
        p
    }

    /// The admin withdraws the pending change.
    pub fn cancel(&mut self) -> Option<Pending> {
        self.only_admin();
        let p = self.pending.take();
        log!("change cancelled: {:?}", p.as_ref().map(|p| &p.change));
        p
    }

    /// Applies the pending change once its wait is over. Anyone may call it. A program is checked again against the
    /// limits and safe codes as they are now.
    pub fn apply(&mut self) -> crate::SeasonView {
        let p = self.ready_change();
        match p.change.clone() {
            Change::Code { .. } => env::panic_str("new code comes with upgrade, which takes the wasm"),
            Change::Admin { account } => self.admin = account,
            Change::Bounty { account } => self.bounty = account,
            Change::Limits { limits } => {
                self.check_limits(&limits);
                self.limits = limits;
            }
            Change::Program { program } => {
                self.check_program(&program).unwrap_or_else(|e| env::panic_str(&e));
                self.turn = 0;
                self.program = program;
            }
            Change::Scheduler { account } => self.scheduler = account,
            Change::AllowSafe { code_hash } => self.safe_codes.push(code_hash),
        }
        self.pending = None;
        event("apply", &p.change);
        self.season()
    }

    /// Deploys the pending code once its wait is over: the input is the wasm itself, and its sha256 must be the
    /// proposed one. `migrate` runs right after it in the same batch. Anyone may call it.
    pub fn upgrade(&mut self) -> Promise {
        let p = self.ready_change();
        let crate::Change::Code { sha256 } = &p.change else {
            env::panic_str("the pending change is not new code: use apply");
        };
        let code = env::input().unwrap_or_default();
        let got: String = env::sha256(&code).iter().map(|b| format!("{b:02x}")).collect();
        require!(&got == sha256, "this wasm is not the proposed code");
        self.pending = None;
        event("upgrade", json!({ "sha256": got }));
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            b"{}".to_vec(),
            NearToken::from_yoctonear(0),
            MIGRATE_GAS,
        )
    }

    /// Takes a safe code off the list at once: no new round is made from it. Rounds already open keep going.
    pub fn drop_safe_code(&mut self, code_hash: String) -> crate::SeasonView {
        self.only_admin();
        let before = self.safe_codes.len();
        self.safe_codes.retain(|c| *c != code_hash);
        require!(self.safe_codes.len() < before, "no such safe code");
        event("drop_safe_code", json!({ "code_hash": code_hash }));
        self.season()
    }

    /// Publishes a safe's code on NEAR as a global contract, by its hash, so every safe made from it only points at
    /// it. The input is the wasm itself; its code hash must be one the season allows. Anyone may call it and pays
    /// NEAR's price (`GLOBAL_BYTE_COST` a byte) with the attached NEAR: what is left goes back, all of it if the
    /// publishing fails. The treasury pays nothing, and the deposit is never the treasury's: until `on_published`
    /// sends the change back it does not count in what the treasury can spend, and sponsors neither fund nor exit.
    #[payable]
    pub fn publish_code(&mut self) -> Promise {
        let code = env::input().unwrap_or_default();
        require!(!code.is_empty(), "the input is the safe's wasm");
        let hash = env::sha256_array(&code);
        let code_hash = crate::b58(&hash);
        require!(self.safe_codes.contains(&code_hash), "this code is not a safe code the season allows");
        let cost = GLOBAL_BYTE_COST.as_yoctonear() * code.len() as u128;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= cost, &format!("attach {cost} yoctoNEAR: NEAR's price for publishing this code"));
        let by = env::predecessor_account_id();
        self.publishing += attached;
        self.publishing_height = env::block_height();
        log!("publishing {} ({} bytes) as a global contract", code_hash, code.len());
        Promise::new(env::current_account_id()).deploy_global_contract(code).then(
            Self::ext(env::current_account_id()).with_static_gas(ON_PUBLISHED_GAS).on_published(
                code_hash,
                by,
                near_sdk::json_types::U128(attached),
                near_sdk::json_types::U128(cost),
            ),
        )
    }

    /// The code is published (or not): the payer gets back what NEAR did not take, and the deposit is no longer on its
    /// way.
    #[private]
    pub fn on_published(
        &mut self,
        code_hash: String,
        by: AccountId,
        attached: near_sdk::json_types::U128,
        cost: near_sdk::json_types::U128,
        #[callback_result] done: Result<(), PromiseError>,
    ) -> bool {
        self.publishing = self.publishing.saturating_sub(attached.0);
        let back = if done.is_ok() { attached.0 - cost.0 } else { attached.0 };
        if back > 0 {
            let _ = Promise::new(by).transfer(NearToken::from_yoctonear(back));
        }
        if done.is_err() {
            log!("{} was not published: the NEAR went back", code_hash);
            return false;
        }
        event("publish", json!({ "code_hash": code_hash }));
        true
    }

    /// The change waiting to apply, if any and not lapsed.
    pub fn pending(&self) -> Option<Pending> {
        self.pending_change().cloned()
    }
}

impl Season {
    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "only the admin proposes changes");
    }

    pub(crate) fn pending_change(&self) -> Option<&Pending> {
        self.pending.as_ref().filter(|p| env::block_timestamp() < p.expires_ns.0)
    }

    fn ready_change(&self) -> Pending {
        let p = self.pending.clone().unwrap_or_else(|| env::panic_str("no change is pending"));
        let now = env::block_timestamp();
        require!(now < p.expires_ns.0, "the change lapsed: propose it again");
        require!(now >= p.ready_ns.0, "the change is still waiting");
        p
    }
}
