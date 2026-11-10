//! Who can change the rules, and how slowly. The contract's account holds no key: nobody can deploy code to it or
//! move its NEAR by hand. Its admin may only propose one change at a time, and the change waits in the open
//! (`pending`) before anyone can apply it:
//!
//! - new code (`upgrade`) or a new admin: `CHANGE_DELAY_HOURS`, longer than any bounty lives plus a day to refund,
//!   so every team that locked NEAR under the old rules is paid or refunded under them. While such a change is pending
//!   no new bounty opens. With no bounty live, the short notice is enough;
//! - a new judge or a new safe code: `CHANGE_NOTICE_HOURS`. Each bounty keeps the judge it opened with, and the team
//!   names that judge when it opens; a safe code only lets new rounds run on that safe, so neither touches a bounty
//!   already open.
//!
//! A change not applied within `CHANGE_EXPIRY_HOURS` of being ready lapses: nothing proposed long ago can land on a
//! bounty opened later.
//!
//! Taking a safe code off the list (`drop_safe_code`) needs no wait: it only stops new rounds on it.

use crate::{b58_32_ok, version_ok, Bounties, BountiesExt, CLAIM_GRACE_HOURS, MAX_HOURS, NS_PER_HOUR};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, Promise};

/// Longer than any bounty lives: the longest race, its claim grace, and a day for the team to refund.
pub const CHANGE_DELAY_HOURS: u64 = MAX_HOURS + CLAIM_GRACE_HOURS + 24;
/// The least any change waits in the open.
pub const CHANGE_NOTICE_HOURS: u64 = 1;
/// A ready change that nobody applied within this long lapses.
pub const CHANGE_EXPIRY_HOURS: u64 = 24;
const MIGRATE_GAS: Gas = Gas::from_tgas(50);

/// A change the admin may propose.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    /// New code: the sha256 of the wasm, lowercase hex. `upgrade` takes the wasm itself.
    Code {
        sha256: String,
    },
    /// The judge for bounties opened from now on: the wasm's sha256, OutLayer's version key.
    Judge {
        version: String,
    },
    /// A safe code a sealed round may run on: the code hash as NEAR shows it, base58.
    AllowSafe {
        code_hash: String,
    },
    Admin {
        account: AccountId,
    },
}

/// A proposed change and when it may apply.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub change: Change,
    pub proposed_ns: U64,
    /// From then on it applies if no bounty is live.
    pub notice_ns: U64,
    /// From then on it applies in any case.
    pub ready_ns: U64,
    /// From then on it no longer applies: propose it again.
    pub expires_ns: U64,
}

impl Change {
    /// Code and the admin wait out every live bounty; a judge or a safe only the notice.
    fn waits_for_bounties(&self) -> bool {
        matches!(self, Change::Code { .. } | Change::Admin { .. })
    }
}

#[near]
impl Bounties {
    /// The admin proposes one change. It shows in `pending` at once and can apply after the wait.
    pub fn propose(&mut self, change: Change) -> Pending {
        self.only_admin();
        require!(self.pending_change().is_none(), "a change is already pending: cancel it first");
        match &change {
            Change::Code { sha256 } => require!(version_ok(sha256), "code: the wasm's sha256 in hex"),
            Change::Judge { version } => require!(version_ok(version), "judge version: the wasm's sha256 in hex"),
            Change::AllowSafe { code_hash } => {
                require!(b58_32_ok(code_hash), "safe code: a code hash in base58");
                require!(!self.safe_codes.contains(code_hash), "this safe code is already known");
            }
            Change::Admin { .. } => {}
        }
        let now = env::block_timestamp();
        let notice = now + CHANGE_NOTICE_HOURS * NS_PER_HOUR;
        let ready = if change.waits_for_bounties() { now + CHANGE_DELAY_HOURS * NS_PER_HOUR } else { notice };
        let expires = ready + CHANGE_EXPIRY_HOURS * NS_PER_HOUR;
        let p = Pending {
            change,
            proposed_ns: U64(now),
            notice_ns: U64(notice),
            ready_ns: U64(ready),
            expires_ns: U64(expires),
        };
        log!(
            "change proposed: {:?}, applies from {} ({} with no bounty live) until {}",
            p.change,
            ready,
            notice,
            expires
        );
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

    /// Applies the pending judge, safe code or admin once its wait is over. Anyone may call it.
    pub fn apply(&mut self) -> Value {
        let p = self.ready_change();
        match p.change {
            Change::Code { .. } => env::panic_str("new code comes with upgrade, which takes the wasm"),
            Change::Judge { version } => {
                log!("judge for new bounties {} -> {}", self.judge_version, version);
                self.judge_version = version;
            }
            Change::AllowSafe { code_hash } => {
                log!("safe code {} allowed", code_hash);
                self.safe_codes.push(code_hash);
            }
            Change::Admin { account } => {
                log!("admin {} -> {}", self.admin, account);
                self.admin = account;
            }
        }
        self.pending = None;
        self.governance()
    }

    /// Deploys the pending code once its wait is over: the input is the wasm itself, not JSON, and its sha256 must be
    /// the proposed one. `migrate` runs right after it in the same batch and keeps every bounty. Anyone may call it.
    pub fn upgrade(&mut self) -> Promise {
        let p = self.ready_change();
        let Change::Code { sha256 } = &p.change else {
            env::panic_str("the pending change is not new code: use apply");
        };
        let code = env::input().unwrap_or_default();
        let got: String = env::sha256(&code).iter().map(|b| format!("{b:02x}")).collect();
        require!(&got == sha256, "this wasm is not the proposed code");
        self.pending = None;
        log!("upgrading to code {}", got);
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            json!({}).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            MIGRATE_GAS,
        )
    }

    /// Takes a safe code off the list at once: new rounds can no longer run on it. Rounds already open keep going.
    pub fn drop_safe_code(&mut self, code_hash: String) -> Value {
        self.only_admin();
        let before = self.safe_codes.len();
        self.safe_codes.retain(|c| *c != code_hash);
        require!(self.safe_codes.len() < before, "no such safe code");
        log!("safe code {} dropped", code_hash);
        self.governance()
    }

    /// The change waiting to apply, if any and not lapsed.
    pub fn pending(&self) -> Option<Pending> {
        self.pending_change().cloned()
    }

    /// Who may propose, what is pending, the judge for new bounties, the safe codes and how many bounties are live.
    pub fn governance(&self) -> Value {
        json!({
            "admin": self.admin,
            "pending": self.pending_change(),
            "judge": self.judge(),
            "safe_codes": self.safe_codes,
            "live": self.live,
            "delay_hours": CHANGE_DELAY_HOURS,
            "notice_hours": CHANGE_NOTICE_HOURS,
            "expiry_hours": CHANGE_EXPIRY_HOURS,
        })
    }
}

impl Bounties {
    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "only the admin proposes changes");
    }

    /// The pending change, unless it lapsed.
    pub(crate) fn pending_change(&self) -> Option<&Pending> {
        self.pending.as_ref().filter(|p| env::block_timestamp() < p.expires_ns.0)
    }

    /// No bounty opens while new code or a new admin is pending: a team never locks NEAR under rules that change
    /// before it can leave.
    pub(crate) fn no_change_pending_for_bounties(&self) {
        if let Some(p) = self.pending_change() {
            require!(
                !p.change.waits_for_bounties(),
                "new code or a new admin is pending: no new bounty until it applies, lapses or is cancelled"
            );
        }
    }

    fn ready_change(&self) -> Pending {
        let p = self.pending.clone().unwrap_or_else(|| env::panic_str("no change is pending"));
        let now = env::block_timestamp();
        require!(now < p.expires_ns.0, "the change lapsed: propose it again");
        let quiet = !p.change.waits_for_bounties() || self.live == 0;
        let ready = if quiet { p.notice_ns.0 } else { p.ready_ns.0 };
        require!(now >= ready, "the change is still waiting");
        p
    }
}
