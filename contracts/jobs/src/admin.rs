//! Who can change the jobs contract, and how slowly. Its account holds no key: nobody can deploy code to it or move its
//! NEAR by hand. Its admin proposes one change at a time, the change waits in the open (`pending`), and then anyone
//! applies it.
//!
//! - **New code** waits `CHANGE_DELAY_HOURS` while any job is live: the longest job from its opening to the end of its
//!   appeal window, and a day to settle it. No job opens while new code waits, so every client and every mask sees
//!   the code before it can touch their NEAR. With no job live it waits `CHANGE_NOTICE_HOURS`.
//! - **Everything else** (admin, meter, treasury, OutLayer, crews contract, a judge, bounty contracts, factories, the
//!   fee) waits `CHANGE_NOTICE_HOURS` and applies to jobs opened after it: a job keeps what it opened with.
//! - A change nobody applies lapses `CHANGE_LAPSE_HOURS` after it is ready.

use crate::{
    event, hex64_ok, judges_ok, list_ok, sha256_hex, Config, Jobs, JobsExt, Judge, Kind, MAX_FEE_BPS, MAX_JOB_HOURS,
    NS_PER_HOUR,
};
use near_sdk::json_types::U64;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

/// The longest job and a day to settle it.
pub const CHANGE_DELAY_HOURS: u64 = MAX_JOB_HOURS + 24;
/// The least any change waits in the open.
pub const CHANGE_NOTICE_HOURS: u64 = 1;
/// How long a ready change may still be applied.
pub const CHANGE_LAPSE_HOURS: u64 = 24;
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
    Admin {
        account: AccountId,
    },
    Meter {
        account: AccountId,
    },
    Treasury {
        account: AccountId,
    },
    Outlayer {
        account: AccountId,
    },
    Crews {
        account: AccountId,
    },
    /// The judge for new jobs of its kind: its OutLayer project and wasm.
    Judge {
        judge: Judge,
    },
    /// No judge for new jobs of this kind: they cannot open until a new one is set.
    DropJudge {
        of: Kind,
    },
    Bounties {
        accounts: Vec<AccountId>,
    },
    Factories {
        accounts: Vec<AccountId>,
    },
    Fee {
        bps: u16,
        to: AccountId,
    },
}

/// A proposed change and when it may apply.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Pending {
    pub change: Change,
    pub proposed_ns: U64,
    pub ready_ns: U64,
}

#[near]
impl Jobs {
    /// The admin proposes one change. It shows in `pending` at once and applies after its wait. A change that lapsed
    /// makes way for the next one.
    pub fn propose(&mut self, change: Change) -> Pending {
        self.only_admin();
        require!(self.pending.as_ref().is_none_or(lapsed), "a change is already pending: cancel it first");
        let mut hours = CHANGE_NOTICE_HOURS;
        match &change {
            Change::Code { sha256 } => {
                require!(hex64_ok(sha256), "code: the wasm's sha256 in hex");
                if self.live > 0 {
                    hours = CHANGE_DELAY_HOURS;
                }
            }
            Change::Judge { judge } => {
                require!(judges_ok(std::slice::from_ref(judge)), "judge: a project and a sha256")
            }
            Change::DropJudge { of } => {
                require!(self.judges.iter().any(|j| j.kind == *of), "no judge serves this kind")
            }
            Change::Bounties { accounts } | Change::Factories { accounts } => {
                require!(list_ok(accounts), "at most 8 accounts, no repeats")
            }
            Change::Fee { bps, .. } => require!(*bps <= MAX_FEE_BPS, "fee: at most 10%"),
            Change::Admin { .. }
            | Change::Meter { .. }
            | Change::Treasury { .. }
            | Change::Outlayer { .. }
            | Change::Crews { .. } => {}
        }
        let now = env::block_timestamp();
        let p = Pending { change, proposed_ns: U64(now), ready_ns: U64(now + hours * NS_PER_HOUR) };
        event("propose", &p);
        self.pending = Some(p.clone());
        p
    }

    /// The admin withdraws the pending change.
    pub fn cancel_change(&mut self) -> Option<Pending> {
        self.only_admin();
        let p = self.pending.take();
        event("cancel_change", &p);
        p
    }

    /// Applies the pending change once its wait is over. Anyone may call it. New code comes with `upgrade`.
    pub fn apply(&mut self) -> Config {
        let p = self.ready_change();
        match p.change.clone() {
            Change::Code { .. } => env::panic_str("new code comes with upgrade, which takes the wasm"),
            Change::Admin { account } => self.admin = account,
            Change::Meter { account } => self.meter = account,
            Change::Treasury { account } => self.treasury = account,
            Change::Outlayer { account } => self.outlayer = account,
            Change::Crews { account } => self.crews = account,
            Change::Judge { judge } => {
                self.judges.retain(|j| j.kind != judge.kind);
                self.judges.push(judge);
            }
            Change::DropJudge { of } => self.judges.retain(|j| j.kind != of),
            Change::Bounties { accounts } => self.bounties = accounts,
            Change::Factories { accounts } => self.factories = accounts,
            Change::Fee { bps, to } => {
                self.fee_bps = bps;
                self.fee_to = to;
            }
        }
        event("apply", &p.change);
        self.pending = None;
        self.config()
    }

    /// Deploys the pending code once its wait is over: the input is the wasm itself, not JSON, and its sha256 must be
    /// the proposed one. `migrate` runs in the same batch and keeps every job. Anyone may call it.
    pub fn upgrade(&mut self) -> Promise {
        let p = self.ready_change();
        let Change::Code { sha256 } = &p.change else {
            env::panic_str("the pending change is not new code: use apply");
        };
        let code = env::input().unwrap_or_default();
        require!(&sha256_hex(&code) == sha256, "this wasm is not the proposed code");
        event("upgrade", &p.change);
        self.pending = None;
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            vec![],
            NearToken::from_yoctonear(0),
            MIGRATE_GAS,
        )
    }

    /// Reads the state the code finds and keeps every job. New fields and variants go last: the state is Borsh.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let raw = env::storage_read(b"STATE").unwrap_or_else(|| env::panic_str("no jobs contract here"));
        near_sdk::borsh::from_slice::<Self>(&raw).unwrap_or_else(|_| env::panic_str("unknown state: nothing migrated"))
    }

    /// The change waiting to apply, if any.
    pub fn pending(&self) -> Option<Pending> {
        self.pending.clone()
    }
}

impl Jobs {
    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "only the admin proposes changes");
    }

    fn ready_change(&self) -> Pending {
        let p = self.pending.clone().unwrap_or_else(|| env::panic_str("no change is pending"));
        require!(env::block_timestamp() >= p.ready_ns.0, "the change is still waiting");
        require!(!lapsed(&p), "the change lapsed: the admin proposes it again");
        p
    }

    /// New code that is waiting and has not lapsed: no job opens meanwhile.
    pub(crate) fn pending_code(&self) -> Option<&Pending> {
        self.pending.as_ref().filter(|p| matches!(p.change, Change::Code { .. }) && !lapsed(p))
    }
}

fn lapsed(p: &Pending) -> bool {
    env::block_timestamp() >= p.ready_ns.0 + CHANGE_LAPSE_HOURS * NS_PER_HOUR
}
