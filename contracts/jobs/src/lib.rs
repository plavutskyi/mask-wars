//! MASK WARS jobs: hire a swarm of AI masks for work a judge can prove, private by default.
//!
//! A client locks NEAR on a job: the reward, the fuel for the masks that take it, the judge's runs and the storage the
//! job will take. The job names its kind, its judge (pinned for its whole life, with the judge's TEE key) and the hash
//! of its spec, and for a review the hash of the rubric, published before anyone starts. Masks take the job alone or
//! as a crew (`../crews`) with roles: scouts find, strikers deliver the work, verifiers check it. Every mask locks a
//! bond, records its own steps on chain sealed until the work window closes and reveals them after it, so nobody
//! copies anyone and nobody signs for anyone.
//!
//! Private by default: on a `tee_tests` or `ai_review` job a revealed step is a box sealed for the judge's TEE key
//! (X25519, HKDF-SHA256, AES-256-GCM, the contract, the job and the mask as associated data), never plain text. Only
//! the judge opens it. The client gets the winner's work alone, and only once the job is paid: the judge seals it
//! again for the client's key (`deliver`). Work that did not win stays with its authors.
//!
//! Fuel: the arena's meter, which runs every mask's mind inside a TEE on NEAR AI, books what each mask's mind spends
//! on this job, at most `fuel_per_mask`. The job pays it to the treasury that pays NEAR AI, never to the mask, and only
//! for a mask that made a real attempt: a step the judge counted. What a mask burned without one, its own tank pays
//! (`../masks`), and every unused yocto goes back to the client.
//!
//! The bond: a mask that the judge calls fake (work that is objectively no work: a box that does not open, no module, a
//! module that does not load; for a review, two agreeing answers of the model) loses its bond to the company, never to
//! the winner, so nobody profits from calling others fake. A mask that held a slot and has no step the judge counted
//! (nothing revealed, or work worth nothing: a module that passes no case, a review scored zero on two seeds) loses
//! half its bond to the company; one that leaves early frees its slot and pays only for the time it held it. Every
//! other bond goes back to whoever locked it. A puppet army costs its owner money and earns its master nothing.
//!
//! The judge: for `tee_tests` and `ai_review` a module on OutLayer, run in a TEE at the exact wasm the job pinned,
//! first checks the client's material (the rubric, the spec, the private test set and the client's own reference work)
//! before any mask may start and keeps its own copy, so nothing after the check depends on the client. Then it reads
//! the job from the chain and answers who won, which steps count and which are fake. For `drain` the job follows a
//! sealed round of the bounty contract (`../bounty`): the round's own judge confirmed the drain, and the job reads its
//! outcome. A verdict waits `appeal_minutes`, during which anyone may appeal once with a bond; the second verdict, or
//! the judge's final word that it cannot decide, is final.
//!
//! Who is paid: the winner, by its crew's split, plus the bonds of fake masks. Nobody cleared the bar, or no verdict
//! came: the reward goes back to the client, who saw none of the work. Only when the judge attests that the client's
//! own material is missing or broken does the reward go in equal parts to every entrant with real work.
//!
//! The winner's reward, less the fee, is split by the rule the crew fixed before it enlisted: each role's share in
//! basis points, equal among the masks of that role with a counted step. Payouts go to the masks' own accounts.
//! The contract's account holds no key: its code and settings change only after a wait anyone can see (`admin`).

mod admin;
#[cfg(test)]
mod tests;

pub use admin::{Change, Pending, CHANGE_DELAY_HOURS, CHANGE_LAPSE_HOURS, CHANGE_NOTICE_HOURS};

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError,
};

/// Masks one job takes, alone or in crews.
pub const MAX_SLOTS: u8 = 16;
/// A crew is two to eight masks.
pub const MIN_CREW: usize = 2;
pub const MAX_CREW: usize = 8;
/// Steps one mask may record on one job.
pub const MAX_STEPS: u8 = 4;
/// A revealed step of a drain: the plan, a short text. The judge reads it from the chain.
pub const MAX_CONTENT_BYTES: usize = 1024;
/// A revealed step of a `tee_tests` or `ai_review` job, and the client's reference work: a box sealed for the judge's
/// TEE key, `mw1.` and the base64url (no padding) of 700 bytes. Every box has this one size, so it says nothing of
/// what is inside (up to 638 bytes of a module or of text). See `services/judge-tests/src/sealed.rs`.
pub const BOX_PREFIX: &str = "mw1.";
pub const BOX_CHARS: usize = 934;
/// A TEE key, the judge's or the client's: `x25519:` and 32 bytes in lowercase hex.
pub const KEY_PREFIX: &str = "x25519:";
/// The highest floor an `ai_review` may set, of 100 points. A model's scores move a few points between calls, even
/// on flawless work: a bar of 100 would make the job unwinnable on noise, and the reward would go back to the client.
/// Below 80, work that meets every criterion with small deductions clears it; the check makes the client's own
/// reference work clear it first.
pub const MAX_REVIEW_WIN_AT: u32 = 80;
pub const MAX_BRIEF_BYTES: usize = 280;
pub const MIN_REWARD: NearToken = NearToken::from_millinear(100);
/// What one mask's mind may burn on one job, and the bounds the client may set.
pub const MIN_FUEL: NearToken = NearToken::from_millinear(10);
pub const MAX_FUEL: NearToken = NearToken::from_near(1);
/// What one judge run costs on OutLayer. The client prepays `JUDGE_RUNS` of them: the check of its material, the first
/// verdict and its retries, and an appeal that may take a few runs to collect its answers.
pub const JUDGE_FEE: NearToken = NearToken::from_millinear(10);
pub const JUDGE_RUNS: u128 = 8;
/// What an appeal locks. It comes back when the second verdict changes who is paid or clears a mask: another winner,
/// a change to or from equal parts, or a step no longer called fake. It goes to the company that pays for the judges
/// when the verdict stands, when the appeal only finds more fake steps (a model's runs differ a little: noise is not
/// a reason to appeal for free) or when the judge says it cannot decide.
pub const APPEAL_BOND: NearToken = NearToken::from_millinear(200);
/// What a seat that gave the job nothing costs its mask: half its bond, to the company. A mask still on the job at its
/// end with no step the judge counted loses this half: nothing revealed, only a copy, or work that is worth nothing to
/// the job (`tee_tests`: a module that passes no case; `ai_review`: a review scored zero on two seeds), which is not
/// fake either, since fake is only objectively no work. A mask that leaves in the work window loses the share of it
/// that matches the share of the window it held the slot. Squatting slots costs the squatter, whatever it reveals.
pub const IDLE_BPS: u16 = 5000;
/// The company's fee on a paid reward, at most 10%. Nothing is taken from fuel or from a job nobody won.
pub const MAX_FEE_BPS: u16 = 1000;
pub const BPS: u16 = 10_000;
/// Storage one mask may take on a job at most: its record with its bond, its seat in the entrant, four steps with the
/// longest content and their digests. `the_reserve_covers_the_biggest_masks_and_the_biggest_verdict` measures it.
pub const MASK_STORAGE_BYTES: u64 = 7000;
/// What a mask that left keeps on the job until it ends: its seat and its place in its entrant. A job gives slots back
/// at most `slots` times, so the reserve holds this much more a slot (`a_left_slot_taken_again_fits_the_reserve`).
pub const LEFT_SEAT_BYTES: u64 = 600;
const MAX_PROFILE: usize = 64;
/// Storage a job may still grow by after it opens: the verdict, the one before an appeal, the appeal.
pub const JOB_GROWTH_BYTES: u64 = 1200;
/// What a bond's own record may take before its mask enlists: paid by whoever locks the bond, given back with it.
pub const BOND_RECORD_BYTES: u64 = 400;
/// What `quote` counts for the job's own record. The biggest one, with the client's sealed reference work and both TEE
/// keys, takes 3419 bytes (`the_quote_covers_the_biggest_record`); `open` charges the real size and gives the rest
/// back.
pub const JOB_RECORD_BYTES: u64 = 4400;
/// Live jobs one mask may be on at once: a mask that squats slots squats at most this many jobs.
pub const MAX_LIVE_JOBS_PER_MASK: u8 = 4;
/// After the reveal window anyone has this long to call the judge; then anyone may close the job unjudged: nobody is
/// named, and the reward and every bond go back.
pub const JUDGE_GRACE_HOURS: u64 = 12;
/// The judge checks the client's material within this long of the opening; the work window starts when it passes. A job
/// the judge did not pass by then closes with everything back to the client: no mask has started.
pub const CHECK_HOURS: u64 = 6;
/// An appeal's judge runs may go on this long after the appeal window; then the verdict appealed against stands.
pub const APPEAL_GRACE_HOURS: u64 = 6;
/// The longest work window. With the time to check, the longest reveal window, the time to judge, the longest appeal
/// window and the time an appeal may take, every job is decidable within `MAX_JOB_HOURS` of its opening: new code waits
/// that long and a day more (`admin`).
pub const MAX_WORK_MINUTES: u32 = 3 * 24 * 60;
pub const MAX_JOB_HOURS: u64 = CHECK_HOURS + 3 * 24 + 24 + JUDGE_GRACE_HOURS + 24 + APPEAL_GRACE_HOURS;
/// A sealed round of the bounty contract runs at most 24 hours and takes claims 12 hours more: a drain job opened on
/// one waits this long for its outcome before it may close unjudged.
pub const DRAIN_ROUND_HOURS: u64 = 37;
/// OutLayer answers or fails within 200 blocks. A judge run with no answer after this many is dropped by anyone.
pub const JUDGE_TIMEOUT_BLOCKS: u64 = 600;
/// A judge run that could not finish because what it calls is down (NEAR AI) says when a run can make progress again
/// (`retry_at`): its back-off, by the chain's clock. Until then no run of the job is asked, so nobody spends the job's
/// runs or an appeal's bond on runs that would call nothing. The contract holds runs back this long at most.
pub const MAX_RETRY_WAIT_MINUTES: u64 = 60;
/// The judge's whole answer: who won and which steps count. Anything longer is not a verdict.
const MAX_REPLY_BYTES: usize = 4096;
const MAX_JOB_ID: usize = 64;
const STEP_PREFIX: &str = "maskwars-step";
const NS_PER_MINUTE: u64 = 60_000_000_000;
pub(crate) const NS_PER_HOUR: u64 = 3_600_000_000_000;
const OUTLAYER_GAS: Gas = Gas::from_tgas(100);
const ON_JUDGED_GAS: Gas = Gas::from_tgas(50);
pub const MIN_JUDGE_GAS: Gas = Gas::from_tgas(180);
const ROUND_GAS: Gas = Gas::from_tgas(10);
const ON_ROUND_GAS: Gas = Gas::from_tgas(50);
pub const MIN_SETTLE_GAS: Gas = Gas::from_tgas(200);

/// What the work is, and so who judges it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Break a live safe on chain: the job follows a sealed round of the bounty contract and its drain judge.
    Drain,
    /// Run the client's private tests on the work inside a TEE: private code review, a benchmark on a private set.
    TeeTests,
    /// An AI reviewer in a TEE scores the work by a rubric published before the job opened.
    AiReview,
}

/// What a mask does in its crew. Its steps are of its role.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Recon: where the hole is, what to test, what the rubric rewards.
    Scout,
    /// The work itself: the plan that drains, the patch that passes, the review that scores. Only a striker's step
    /// can win a job.
    Striker,
    /// Checks the strike before it goes: replays the plan, reruns the tests, reviews the review.
    Verifier,
}

pub const ROLES: [Role; 3] = [Role::Scout, Role::Striker, Role::Verifier];

/// A crew's split of the reward, in basis points per role. Fixed before the crew enlists.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Split {
    pub scout: u16,
    pub striker: u16,
    pub verifier: u16,
}

impl Split {
    pub const SOLO: Split = Split { scout: 0, striker: BPS, verifier: 0 };

    pub fn of(&self, role: Role) -> u16 {
        match role {
            Role::Scout => self.scout,
            Role::Striker => self.striker,
            Role::Verifier => self.verifier,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub mask: AccountId,
    pub role: Role,
}

/// A crew as the crews contract hands it over: the roster and the split every member agreed to.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CrewTicket {
    pub crew: String,
    /// The crew's version on the crews contract: every change of roster or split makes a new one.
    pub version: u32,
    pub members: Vec<Member>,
    pub split: Split,
}

/// Who may take the job.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "who", rename_all = "snake_case")]
pub enum OpenTo {
    Anyone,
    /// Masks forged by one of these factories: a mask is a direct sub-account of its factory, which only the factory
    /// creates, and each costs its owner at least 1 NEAR of fuel. `open` fills the list from the contract's own.
    Registered {
        #[serde(default)]
        factories: Vec<AccountId>,
    },
    /// Only these masks, 1 to 16.
    Masks {
        masks: Vec<AccountId>,
    },
}

/// A judge module on OutLayer: its project, the exact wasm (its sha256, OutLayer's version key) and the public half of
/// the X25519 key it holds inside its TEE (`x25519:<hex>`), which masks seal their work for. The key comes from the
/// judge's own `{"action":"key"}` run, signed by the enclave's attestation.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Judge {
    pub kind: Kind,
    pub project: String,
    pub version: String,
    pub key: String,
}

/// A sealed round of the bounty contract that a drain job follows.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RoundRef {
    pub bounty: AccountId,
    pub id: String,
}

/// OutLayer secrets the judge may read: for `tee_tests`, the client's private test set, readable only inside the TEE.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SecretsRef {
    pub profile: String,
    pub account_id: AccountId,
}

/// What the client's material promises, on chain before any mask starts: the judge checks the material against it
/// (`check`) before the work window opens, and judges by it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bar {
    /// The fewest points of 100 (`ai_review`, at most `MAX_REVIEW_WIN_AT`) or passed cases (`tee_tests`) a work needs
    /// to win.
    pub win_at: u32,
    /// `tee_tests`: how many cases the private test set holds.
    pub cases: Option<u32>,
    /// `tee_tests`: the fuel each case may burn.
    pub fuel: Option<U64>,
    /// The client's own reference work, sealed for the judge's key like a mask's work, with the client's account as
    /// the mask: a solution (`tee_tests`) or a review (`ai_review`). The check runs the test set on it, or has the
    /// model score it by the rubric, and it must clear `win_at`: a bar nobody can clear never opens to masks.
    pub reference: Option<String>,
}

/// What a job fixed when it opened and keeps to the end.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Terms {
    pub kind: Kind,
    /// One line for people and agents: what to do.
    pub brief: String,
    /// sha256 (hex) of the full spec, published before the job opened.
    pub spec: String,
    /// sha256 (hex) of the rubric (`ai_review`) or of the private test set (`tee_tests`), published before the job
    /// opened, so nobody can move the goalposts.
    pub rubric: Option<String>,
    /// The judge every run of this job goes to; `null` for a drain, which the bounty's own judge decides.
    pub judge: Option<Judge>,
    pub round: Option<RoundRef>,
    pub secrets: Option<SecretsRef>,
    /// What a work needs to win, and for `tee_tests` the test set's shape and the client's solution. `null` for a drain.
    pub bar: Option<Bar>,
    pub reward: U128,
    pub fee_bps: u16,
    pub fee_to: AccountId,
    pub fuel_per_mask: U128,
    pub slots: u8,
    /// What each mask locks to take the job: from `fuel_per_mask` up to the reward. A mask the judge calls fake loses
    /// it to the company; a mask that held a slot and has no step the judge counted loses half of it to the company;
    /// every other bond goes back to whoever locked it.
    pub bond: U128,
    /// `tee_tests` and `ai_review`: the client's X25519 key (`x25519:<hex>`). The judge seals the winner's work for it
    /// once the job is paid, and for nobody else.
    pub client_key: Option<String>,
    pub open_to: OpenTo,
    /// Who books fuel, where fuel goes, who runs the judge, who hands over crews: as the contract had them at the
    /// opening. A later change applies to new jobs only.
    pub meter: AccountId,
    pub treasury: AccountId,
    pub outlayer: AccountId,
    pub crews: AccountId,
    pub opened_ns: U64,
    /// Masks enlist and record sealed steps until then. For `tee_tests` and `ai_review` the windows start when the
    /// judge passes the client's material (`check`); until then they show as if it had passed at the opening.
    pub work_until: U64,
    /// Masks reveal their steps until then; the meter books fuel until then.
    pub reveal_until: U64,
    /// Until then anyone may call the judge; after it anyone may close the job unjudged.
    pub judge_until: U64,
    pub appeal_minutes: u32,
}

/// A judge's answer, as the contract keeps it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    /// The winning entrant, if any.
    pub winner: Option<u32>,
    /// The steps that count: real attempts. Their masks' fuel is paid by the job; the winner's split by them.
    pub counted: Vec<u32>,
    /// The steps that are objectively no work (a box that does not open, no module, a module that does not load; for a
    /// review, two agreeing answers): their masks lose their bonds to the company.
    pub fake: Vec<u32>,
    pub at_ns: U64,
    /// After an appeal, or from the bounty's own judge, or the judge's final word that it cannot decide: no appeal is
    /// left.
    #[serde(rename = "final")]
    pub is_final: bool,
    /// The judge attests that the client's own material is missing or broken: the reward goes in equal parts to every
    /// entrant with a counted striker step.
    pub shared: bool,
    /// The judge could not decide: nobody wins and nobody is called fake.
    pub undecided: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Appeal {
    pub by: AccountId,
    pub bond: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Status {
    /// Enlisting, working and revealing, by the clock (`terms`).
    Open,
    /// Judge run number `run` is out. `unstick` drops it after `JUDGE_TIMEOUT_BLOCKS`; only its own answer counts.
    Judging { height: U64, run: u32 },
    /// The judge answered (`verdict`); it pays after the appeal window, or at once when final.
    Decided,
    /// The reward went to the winning entrant, split by its rule.
    Paid { winner: u32 },
    /// Nobody won, or no verdict came by `judge_until`: the reward went back to the client, who saw none of the work.
    /// Or nobody worked: everything did.
    Closed,
    /// The client took the job back before any mask sealed a step, or the judge refused the client's material.
    Cancelled,
    /// The judge attested that the client's own material is missing or broken: the reward went in equal parts to every
    /// entrant with a counted striker step.
    Shared,
    /// An appeal is in and its last judge run gave no answer: anyone runs it again with `judge` until the appeal's
    /// deadline; after it, `settle` pays the verdict appealed against and gives the bond back.
    Appealing,
}

impl Status {
    pub fn live(&self) -> bool {
        matches!(self, Status::Open | Status::Judging { .. } | Status::Decided | Status::Appealing)
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub client: AccountId,
    pub terms: Terms,
    pub status: Status,
    /// Masks holding a slot, entrants, steps recorded.
    pub masks: u8,
    pub entrants: u32,
    pub steps: u32,
    /// Judge runs asked so far: each answer names its run.
    pub runs: u32,
    /// NEAR left for the storage the job still takes.
    pub reserve: u128,
    /// NEAR left for judge runs.
    pub judge_budget: u128,
    /// The judge's answer, kept for good once given.
    pub verdict: Option<Verdict>,
    /// The verdict an appeal was made against, and the appeal.
    pub prior: Option<Verdict>,
    pub appeal: Option<Appeal>,
    /// The judge passed the client's material and the work window started. A drain has none to check.
    pub checked: bool,
    /// Masks that left and gave their slot back: at most `slots`, so a job never seats more than twice its masks.
    pub left: u8,
    /// No judge run is asked before this (ns): the last run could not finish because what the judge calls was down, and
    /// said when a run can make progress again. 0 when nothing holds runs back.
    pub retry_at: u64,
    /// Who paid the run that is out, when the job's runs were spent. On an appeal the held bond pays it back once the run
    /// has called NEAR AI; a run that called nothing never costs the bond.
    pub fronted: Option<AccountId>,
}

/// A solo mask or a crew on a job, with the roster and split it enlisted with.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Entrant {
    pub crew: Option<String>,
    pub version: u32,
    pub members: Vec<Member>,
    pub split: Split,
}

/// A mask on a job.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Seat {
    pub entrant: u32,
    pub role: Role,
    /// What its mind burned on this job, booked by the meter.
    pub burned: u128,
    pub steps: u8,
    /// The mask left before it sealed a step: its slot and its place are free, its bond went back but for what holding
    /// the slot cost, and it does not come back.
    pub left: bool,
    /// The bond the mask locked, and who locked it: it goes back there, unless the judge calls the mask fake (all to the
    /// company) or the mask gave the job nothing (`IDLE_BPS` of it to the company).
    pub bond: u128,
    pub backer: AccountId,
    /// When the mask took its slot.
    pub since: u64,
}

/// A bond locked for a mask on a job, before the mask enlists. The mask's own `enlist` takes it, or its crew's.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Bond {
    pub by: AccountId,
    pub amount: U128,
    /// What its record's storage cost, given back with it.
    pub storage: U128,
}

/// One step a mask recorded: sealed in the work window, revealed after it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub seq: u32,
    pub entrant: u32,
    pub mask: AccountId,
    pub role: Role,
    /// sha256 of `maskwars-step:<job>:<mask>:<salt>:<content>`, lowercase hex.
    pub hash: String,
    pub at_ns: U64,
    pub content: Option<String>,
    /// sha256 of the content: the same content counts once, for the step sealed first.
    pub digest: Option<String>,
    /// The earlier step this one repeats.
    pub copy_of: Option<u32>,
}

impl Step {
    /// Revealed and nobody's copy: the judge reads it, and it may count.
    pub fn eligible(&self) -> bool {
        self.content.is_some() && self.copy_of.is_none()
    }
}

/// A job as the site, the arena and other agents read it. Amounts are yoctoNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct JobView {
    pub id: String,
    pub client: AccountId,
    pub terms: Terms,
    pub status: Status,
    pub masks: u8,
    pub entrants: u32,
    pub steps: u32,
    pub runs: u32,
    pub reserve: U128,
    pub judge_budget: U128,
    pub verdict: Option<Verdict>,
    pub prior: Option<Verdict>,
    pub appeal: Option<Appeal>,
    pub checked: bool,
    /// Slots the job gave back so far, at most `slots`.
    pub left: u8,
    /// No judge run is asked before this (ns): the judge's own back-off after what it calls was down. 0: none.
    pub retry_at: U64,
    /// `checking` (the client's material), `enlisting`, `revealing`, `waiting` (for the judge), `judging`, `decided`,
    /// `appealing`, `paid`, `shared`, `closed`, `cancelled`.
    pub phase: String,
}

/// One mask's fuel on a job: what its mind burned, and, once decided, what the job pays of it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct FuelView {
    pub mask: AccountId,
    pub entrant: u32,
    pub role: Role,
    pub burned: U128,
    pub steps: u8,
    /// `null` until the verdict; then what the job pays: all it burned for a real attempt, nothing without one.
    pub covered: Option<U128>,
}

/// A bond as `bond_of` shows it: who locked it, how much, and whether its mask has enlisted and holds it on its seat.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct BondView {
    pub by: AccountId,
    pub amount: U128,
    pub enlisted: bool,
}

/// Where the judge keeps the winning work sealed for the client's key (`client_key`): a key of its project's public
/// storage on OutLayer, the box's sha256 and the key it opens with.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery {
    pub at: String,
    pub sha256: String,
    pub key: String,
}

/// Who the reward pool goes to when a job ends.
enum Award {
    Winner(u32),
    /// Equal parts, in this order; rounding goes to the first.
    Shared(Vec<u32>),
    Nobody,
}

/// What a judge run is asked for: a check or a verdict (its run number), or the winning work for the client.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Judge(u32),
    Deliver,
}

/// A judge's answer the contract takes.
struct Ruling {
    winner: Option<u32>,
    counted: Vec<u32>,
    fake: Vec<u32>,
    shared: bool,
    undecided: bool,
}

/// What opening a job takes, yoctoNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Quote {
    pub reward: U128,
    pub fuel: U128,
    pub judge: U128,
    pub reserve: U128,
    pub record: U128,
    pub total: U128,
}

/// The contract's settings for new jobs. Amounts are yoctoNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub admin: AccountId,
    pub meter: AccountId,
    pub treasury: AccountId,
    pub outlayer: AccountId,
    pub crews: AccountId,
    pub judges: Vec<Judge>,
    pub bounties: Vec<AccountId>,
    pub factories: Vec<AccountId>,
    pub fee_bps: u16,
    pub fee_to: AccountId,
    pub jobs: u32,
    pub live: u32,
    pub pending: Option<Pending>,
    pub judge_fee: U128,
    pub appeal_bond: U128,
    pub max_slots: u8,
    pub max_steps: u8,
}

/// The judge's stdout: `{"success":true,"output":{"job":…,"winner":…,"counted":[…],"fake":[…]},"error":null}` for a
/// verdict, `{"success":true,"output":{"job":…,"checked":true|false,"why":…},"error":null}` for a check,
/// `{"success":true,"output":{"job":…,"delivered":…,"sha256":…},"error":null}` for a delivery.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct JudgeReply {
    success: bool,
    output: Option<JudgeOutput>,
    error: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct JudgeOutput {
    pub job: String,
    #[serde(default)]
    pub winner: Option<u32>,
    #[serde(default)]
    pub counted: Vec<u32>,
    /// Steps that are no real attempt, or whose work broke the judge.
    #[serde(default)]
    pub fake: Vec<u32>,
    /// The client's own material is missing or broken: equal parts for every entrant with a counted strike.
    #[serde(default)]
    pub shared: bool,
    /// The judge's final word that it cannot decide.
    #[serde(default)]
    pub undecided: bool,
    /// A delivery's answer: where the judge keeps the winner's work sealed for the client's key, and its sha256.
    #[serde(default)]
    pub delivered: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    /// A check's answer: whether the client's material is what the job holds and can be judged by.
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub why: Option<String>,
    /// With or without an answer: when a run can make progress again, by the chain's clock (ns), if what the judge
    /// calls was down. The contract asks no run before it.
    #[serde(default)]
    pub retry_at: Option<U64>,
    /// With or without an answer: the calls this run made to NEAR AI. On an appeal, only a run that made one is paid
    /// back from the held bond.
    #[serde(default)]
    pub asked: u32,
}

/// What the bounty contract's `get` says of a round, as far as a drain job reads it.
#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct BountyView {
    status: BountyStatus,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct BountyStatus {
    state: String,
    winner: Option<AccountId>,
}

pub use outlayer::ext_outlayer;

/// OutLayer's contract, as far as a judge run needs it. Its own signature, eight arguments and all.
#[allow(clippy::too_many_arguments)]
mod outlayer {
    use near_sdk::serde_json::Value;
    use near_sdk::{ext_contract, AccountId};

    #[ext_contract(ext_outlayer)]
    #[allow(dead_code)]
    trait OutLayer {
        fn request_execution(
            &mut self,
            source: Value,
            resource_limits: Option<Value>,
            input_data: Option<String>,
            secrets_ref: Option<Value>,
            response_format: Option<String>,
            payer_account_id: Option<AccountId>,
            params: Option<Value>,
        );
    }
}

#[ext_contract(ext_bounty)]
#[allow(dead_code)]
trait Bounty {
    fn get(&self, id: String) -> Option<Value>;
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Jobs,
    Ids,
    Entrants,
    Seats,
    Steps,
    Digests,
    LiveOf,
    Bonds,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Jobs {
    pub(crate) admin: AccountId,
    /// Books what each mask's mind spends: the arena's keeper, which runs the minds in a TEE.
    pub(crate) meter: AccountId,
    /// Where fuel goes: the account that pays NEAR AI.
    pub(crate) treasury: AccountId,
    pub(crate) outlayer: AccountId,
    /// The crews contract: the only one that enlists crews.
    pub(crate) crews: AccountId,
    /// One judge per kind for new jobs; a drain has none here.
    pub(crate) judges: Vec<Judge>,
    /// Bounty contracts whose sealed rounds a drain job may follow.
    pub(crate) bounties: Vec<AccountId>,
    /// Mask factories, for jobs open to registered masks.
    pub(crate) factories: Vec<AccountId>,
    pub(crate) fee_bps: u16,
    pub(crate) fee_to: AccountId,
    jobs: LookupMap<String, Job>,
    ids: Vector<String>,
    /// `<job>/<index>` → entrant.
    entrants: LookupMap<String, Entrant>,
    /// `<job>/<mask>` → the mask's seat.
    seats: LookupMap<String, Seat>,
    /// `<job>#<seq>` → step.
    steps: LookupMap<String, Step>,
    /// `<job>#<digest>` → the earliest step with that content.
    digests: LookupMap<String, u32>,
    /// Jobs not yet paid, closed or cancelled.
    pub(crate) live: u32,
    pub(crate) pending: Option<Pending>,
    /// How many live jobs each mask is on.
    live_of: LookupMap<AccountId, u8>,
    /// `<job>/<mask>` → a bond locked for a mask that has not enlisted yet.
    bonds: LookupMap<String, Bond>,
}

#[near]
impl Jobs {
    /// The contract's account is created, funded, given this code and initialized in one transaction that adds no key.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        admin: AccountId,
        meter: AccountId,
        treasury: AccountId,
        outlayer: AccountId,
        crews: AccountId,
        judges: Vec<Judge>,
        bounties: Vec<AccountId>,
        factories: Vec<AccountId>,
        fee_bps: u16,
        fee_to: AccountId,
    ) -> Self {
        require!(judges_ok(&judges), "judges: at most one per kind, none for a drain, each a project and a sha256");
        require!(list_ok(&bounties) && list_ok(&factories), "bounties, factories: at most 8 accounts, no repeats");
        require!(fee_bps <= MAX_FEE_BPS, "fee: at most 10%");
        Self {
            admin,
            meter,
            treasury,
            outlayer,
            crews,
            judges,
            bounties,
            factories,
            fee_bps,
            fee_to,
            jobs: LookupMap::new(Key::Jobs),
            ids: Vector::new(Key::Ids),
            entrants: LookupMap::new(Key::Entrants),
            seats: LookupMap::new(Key::Seats),
            steps: LookupMap::new(Key::Steps),
            digests: LookupMap::new(Key::Digests),
            live: 0,
            pending: None,
            live_of: LookupMap::new(Key::LiveOf),
            bonds: LookupMap::new(Key::Bonds),
        }
    }

    // -------------------------------------------------------------------------------------------------------------
    // The client
    // -------------------------------------------------------------------------------------------------------------

    /// Opens job `id`. The deposit pays, in this order: the reward, `fuel_per_mask` for every slot, `JUDGE_RUNS` judge
    /// runs, the storage every mask may take (`MASK_STORAGE_BYTES` a slot) and the job's own record; anything over is
    /// sent back at once. `judge_version` is the judge wasm the client agrees to: it must be the contract's judge for
    /// the kind at this moment. `bar` is what a work needs to win, on chain for every mask to read; the judge checks the
    /// client's material against it (`check`) before the work window opens. A drain names the bounty round it follows
    /// instead. `bond` is what each mask locks to take the job, `fuel_per_mask` when left out. `client_key` is the
    /// client's X25519 key the judge seals the winning work for (`tee_tests`, `ai_review`).
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &mut self,
        id: String,
        kind: Kind,
        brief: String,
        spec: String,
        rubric: Option<String>,
        judge_version: Option<String>,
        round: Option<RoundRef>,
        secrets: Option<SecretsRef>,
        bar: Option<Bar>,
        reward: U128,
        fuel_per_mask: U128,
        slots: u8,
        open_to: OpenTo,
        work_minutes: u32,
        reveal_minutes: u32,
        appeal_minutes: u32,
        bond: Option<U128>,
        client_key: Option<String>,
    ) -> JobView {
        let client = env::predecessor_account_id();
        require!(self.pending_code().is_none(), "new code is waiting to apply: no job opens until it has");
        require!(id_ok(&id), "id: 1 to 64 lowercase letters, digits, - or _");
        require!(!self.jobs.contains_key(&id), "this job id is taken");
        require!(!brief.is_empty() && brief.len() <= MAX_BRIEF_BYTES, "brief: 1 to 280 bytes");
        require!(hex64_ok(&spec), "spec: the sha256 of the published spec, hex");
        require!(rubric.as_deref().is_none_or(hex64_ok), "rubric: the sha256 of the published rubric, hex");
        require!(reward.0 >= MIN_REWARD.as_yoctonear(), "the reward is at least 0.1 NEAR");
        require!(
            (MIN_FUEL.as_yoctonear()..=MAX_FUEL.as_yoctonear()).contains(&fuel_per_mask.0),
            "fuel_per_mask: 0.01 to 1 NEAR"
        );
        require!((1..=MAX_SLOTS).contains(&slots), "slots: 1 to 16 masks");
        let fuel = fuel_per_mask.0 * u128::from(slots);
        require!(fuel <= reward.0, "fuel for all the slots is at most the reward: the work pays more than the trying");
        let bond = bond.unwrap_or(fuel_per_mask);
        require!(
            (fuel_per_mask.0..=reward.0).contains(&bond.0),
            "bond: from fuel_per_mask up to the reward: a fake mask loses at least what a slot's mind may burn"
        );
        require!((5..=MAX_WORK_MINUTES).contains(&work_minutes), "work_minutes: 5 minutes to 3 days");
        require!((5..=24 * 60).contains(&reveal_minutes), "reveal_minutes: 5 minutes to a day");
        require!((10..=24 * 60).contains(&appeal_minutes), "appeal_minutes: 10 minutes to a day");
        let judge = match kind {
            Kind::Drain => {
                let r = round.as_ref().unwrap_or_else(|| env::panic_str("a drain job names the round it follows"));
                require!(self.bounties.contains(&r.bounty), "the round is on a bounty contract this contract follows");
                require!(id_ok(&r.id), "round id: 1 to 64 lowercase letters, digits, - or _");
                require!(judge_version.is_none(), "a drain is judged by its round: name no judge");
                require!(secrets.is_none(), "a drain is read from the chain: it takes no secrets");
                require!(bar.is_none(), "a drain is won by its round: it sets no bar");
                require!(client_key.is_none(), "a drain's plan is on chain: it takes no client key");
                None
            }
            Kind::TeeTests | Kind::AiReview => {
                require!(round.is_none(), "only a drain follows a round");
                require!(rubric.is_some(), "tee_tests and ai_review publish the rubric or test set first: its sha256");
                let j = self
                    .judges
                    .iter()
                    .find(|j| j.kind == kind)
                    .cloned()
                    .unwrap_or_else(|| env::panic_str("no judge serves this kind yet"));
                require!(
                    judge_version.as_deref() == Some(j.version.as_str()),
                    "judge_version: the judge you agree to must be the contract's judge for this kind"
                );
                require!(secrets.is_none() || kind == Kind::TeeTests, "only tee_tests read secrets");
                require!(
                    secrets.is_some() || kind != Kind::TeeTests,
                    "tee_tests name the client's secrets that hold the test set"
                );
                if let Some(sec) = &secrets {
                    require!(sec.account_id == client, "secrets: only the client's own, which it keeps for this job");
                    require!(profile_ok(&sec.profile), "secrets profile: 1 to 64 letters, digits, - or _");
                }
                let b = bar
                    .as_ref()
                    .unwrap_or_else(|| env::panic_str("tee_tests and ai_review set the bar a work must clear"));
                require!(bar_ok(kind, b), match kind {
                    Kind::AiReview => "bar: win_at 0 to 80 points, no cases or fuel, and the client's reference review sealed for the judge",
                    _ => "bar: 1 to 64 cases, win_at 1 to cases, fuel a case, and the client's solution sealed for the judge",
                });
                require!(
                    client_key.as_deref().is_some_and(key_ok),
                    "client_key: the client's X25519 key, x25519:<hex>: the winning work is sealed for it"
                );
                Some(j)
            }
        };
        let open_to = match open_to {
            OpenTo::Anyone => OpenTo::Anyone,
            OpenTo::Registered { .. } => {
                require!(!self.factories.is_empty(), "no factory registers masks here yet");
                OpenTo::Registered { factories: self.factories.clone() }
            }
            OpenTo::Masks { masks } => {
                require!(
                    (1..=MAX_SLOTS as usize).contains(&masks.len()) && distinct(&masks),
                    "masks: 1 to 16 accounts, no repeats"
                );
                require!(!masks.contains(&client), "the client is not one of its own job's masks");
                OpenTo::Masks { masks }
            }
        };
        let now = env::block_timestamp();
        let work_until = now + u64::from(work_minutes) * NS_PER_MINUTE;
        let reveal_until = work_until + u64::from(reveal_minutes) * NS_PER_MINUTE;
        let mut judge_until = reveal_until + JUDGE_GRACE_HOURS * NS_PER_HOUR;
        if kind == Kind::Drain {
            judge_until = judge_until.max(now + DRAIN_ROUND_HOURS * NS_PER_HOUR);
        }
        let terms = Terms {
            kind,
            brief,
            spec,
            rubric,
            judge,
            round,
            secrets,
            bar,
            reward,
            fee_bps: self.fee_bps,
            fee_to: self.fee_to.clone(),
            fuel_per_mask,
            slots,
            bond,
            client_key,
            open_to,
            meter: self.meter.clone(),
            treasury: self.treasury.clone(),
            outlayer: self.outlayer.clone(),
            crews: self.crews.clone(),
            opened_ns: U64(now),
            work_until: U64(work_until),
            reveal_until: U64(reveal_until),
            judge_until: U64(judge_until),
            appeal_minutes,
        };
        let judge_budget = JUDGE_FEE.as_yoctonear() * JUDGE_RUNS;
        let reserve = reserve_for(slots);
        let before = env::storage_usage();
        let job = Job {
            client: client.clone(),
            terms,
            status: Status::Open,
            masks: 0,
            entrants: 0,
            steps: 0,
            runs: 0,
            reserve,
            judge_budget,
            verdict: None,
            prior: None,
            appeal: None,
            // A drain's material is its round, on chain: nothing to check.
            checked: kind == Kind::Drain,
            left: 0,
            retry_at: 0,
            fronted: None,
        };
        self.jobs.insert(id.clone(), job);
        self.ids.push(id.clone());
        self.flush();
        let record = cost_of(env::storage_usage() - before);
        let total = reward.0 + fuel + judge_budget + reserve + record;
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= total, format!("this job takes {total} yoctoNEAR: see quote"));
        self.live += 1;
        if deposit > total {
            Promise::new(client).transfer(NearToken::from_yoctonear(deposit - total)).detach();
        }
        let view = self.view(&id);
        event("open", &view);
        view
    }

    /// The client takes the job back while no mask has sealed a step: the fuel the meter booked so far is paid, the
    /// rest comes back but the record's storage, and the masks that enlisted are free again.
    pub fn cancel(&mut self, id: String) -> JobView {
        let job = self.job(&id);
        require!(env::predecessor_account_id() == job.client, "only the client cancels its job");
        require!(job.status == Status::Open && job.steps == 0, "a mask has sealed a step: the job runs to its end");
        // The masks' minds may have worked already: what the meter booked for a mask still on the job is paid.
        let booked =
            self.seats_of(&id, &job).into_iter().filter(|(_, seat)| !seat.left).map(|(mask, _)| mask).collect();
        self.finish(&id, job, Award::Nobody, booked, vec![], Status::Cancelled);
        event("cancel", &Named { id: &id });
        self.view(&id)
    }

    /// Anyone asks the job's pinned judge, with `MIN_JUDGE_GAS`, to check the client's material before any mask starts:
    /// the spec and the rubric (`ai_review`), or the private test set and the client's own solution (`tee_tests`), by
    /// their hashes and against the job's `bar`. Paid from the job's judge runs. When the judge passes it, the work
    /// window starts; when the judge refuses it, everything goes back to the client. Within `CHECK_HOURS` of opening,
    /// and not before the judge's own `retry_at`.
    #[payable]
    pub fn check(&mut self, id: String) -> Promise {
        let mut job = self.job(&id);
        require!(job.status == Status::Open && !job.checked, "the job is not waiting for its material to be checked");
        require!(env::block_timestamp() < self.check_until(&job), "the time to check is over: close the job");
        require!(env::prepaid_gas() >= MIN_JUDGE_GAS, "attach at least 180 TGas");
        may_run(&job);
        job.runs += 1;
        let run = job.runs;
        job.status = Status::Judging { height: U64(env::block_height()), run };
        let payer = self.pay_run(&mut job, false);
        self.jobs.insert(id.clone(), job.clone());
        self.ask_judge(&id, &job, Mode::Judge(run), payer)
    }

    // -------------------------------------------------------------------------------------------------------------
    // Masks and crews
    // -------------------------------------------------------------------------------------------------------------

    /// Anyone locks the job's `bond` for `mask`, which may then enlist: alone with its own narrow key, which cannot
    /// attach NEAR, or in its crew. The deposit pays the bond and its record's storage; the rest comes back at once.
    /// The bond goes back to whoever locked it when the job ends, unless the judge calls the mask fake (then it goes to
    /// the company) or none of the mask's steps counted (then half of it does). Until the mask enlists, whoever locked
    /// it may take it back (`unbond`).
    #[payable]
    pub fn bond(&mut self, id: String, mask: AccountId) -> Bond {
        let job = self.job(&id);
        let by = env::predecessor_account_id();
        require!(
            job.status == Status::Open && env::block_timestamp() < job.terms.work_until.0,
            "the job takes no new masks"
        );
        require!(mask != job.client, "the client is not one of its own job's masks");
        let key = seat_key(&id, &mask);
        require!(!self.seats.contains_key(&key), "this mask is on the job already");
        require!(!self.bonds.contains_key(&key), "a bond is locked for this mask on this job already");
        let amount = job.terms.bond.0;
        let deposit = env::attached_deposit().as_yoctonear();
        let most = amount + cost_of(BOND_RECORD_BYTES);
        require!(
            deposit >= most,
            format!("a bond on this job takes {most} yoctoNEAR with its record's storage; what the record does not take comes back")
        );
        self.flush();
        let before = env::storage_usage();
        self.bonds.insert(key.clone(), Bond { by: by.clone(), amount: U128(amount), storage: U128(0) });
        self.flush();
        let storage = cost_of(env::storage_usage() - before);
        let bond = Bond { by: by.clone(), amount: U128(amount), storage: U128(storage) };
        self.bonds.insert(key, bond.clone());
        if deposit > amount + storage {
            Promise::new(by.clone()).transfer(NearToken::from_yoctonear(deposit - amount - storage)).detach();
        }
        event("bond", &Bonded { id: &id, mask: &mask, by: &by, amount: U128(amount) });
        bond
    }

    /// Whoever locked a bond takes it back, with its record's storage, while its mask has not enlisted.
    pub fn unbond(&mut self, id: String, mask: AccountId) -> U128 {
        let key = seat_key(&id, &mask);
        let b = self.bonds.get(&key).cloned().unwrap_or_else(|| env::panic_str("no bond waits for this mask here"));
        require!(env::predecessor_account_id() == b.by, "only whoever locked a bond takes it back");
        self.bonds.remove(&key);
        let back = b.amount.0 + b.storage.0;
        Promise::new(b.by.clone()).transfer(NearToken::from_yoctonear(back)).detach();
        event("unbond", &Bonded { id: &id, mask: &mask, by: &b.by, amount: b.amount });
        U128(back)
    }

    /// A mask takes the job alone: a crew of one, its striker, with the whole reward if it wins. The mask signs with
    /// its own key, a race key on this contract that the keeper gave it for this job, and takes the bond locked for it.
    pub fn enlist(&mut self, id: String) -> u32 {
        let mask = env::predecessor_account_id();
        let members = vec![Member { mask, role: Role::Striker }];
        self.may_seat(&id, &members);
        let bonds = self.take_bonds(&id, &members);
        let before = env::storage_usage();
        let index = self.seat_entrant(&id, Entrant { crew: None, version: 0, members, split: Split::SOLO }, bonds);
        self.charge(&id, before);
        index
    }

    /// A crew takes the job: only the crews contract the job pinned hands one over, with the roster and the split
    /// every member agreed to there. Every member takes the bond locked for it (`bond`).
    pub fn enlist_crew(&mut self, id: String, ticket: CrewTicket) -> u32 {
        let job = self.job(&id);
        require!(env::predecessor_account_id() == job.terms.crews, "only the crews contract enlists a crew");
        require!(crew_id_ok(&ticket.crew), "crew: 3 to 32 lowercase letters, digits or -");
        require!(
            (MIN_CREW..=MAX_CREW).contains(&ticket.members.len())
                && distinct(&ticket.members.iter().map(|m| m.mask.clone()).collect::<Vec<_>>()),
            "a crew is 2 to 8 masks, no repeats"
        );
        require!(
            split_ok(&ticket.split, &ticket.members),
            "split: basis points summing to 10000, none for an empty role"
        );
        self.may_seat(&id, &ticket.members);
        let bonds = self.take_bonds(&id, &ticket.members);
        let before = env::storage_usage();
        let index = self.seat_entrant(
            &id,
            Entrant { crew: Some(ticket.crew), version: ticket.version, members: ticket.members, split: ticket.split },
            bonds,
        );
        self.charge(&id, before);
        index
    }

    /// A mask leaves the job before it has sealed a step, while the work window is open: its slot is free for another
    /// mask, one of its four places is free for another job, and its bond goes back less what holding the slot cost
    /// (`IDLE_BPS` of it, times the share of the work window, from when it took the slot, that it held it), which goes
    /// to the company. Leaving at once costs next to nothing; holding a slot to the last minute and leaving costs what a
    /// seat that gave the job nothing costs at its end. A job gives slots back at most `slots` times, so it never seats
    /// more than twice its masks; after that a mask on it stays to the end. The mask does not come back to this job,
    /// alone or in a crew, and what its crew wins pays it nothing. What its mind burned here, the job does not pay: its
    /// own tank does.
    pub fn leave(&mut self, id: String) -> JobView {
        let mask = env::predecessor_account_id();
        let mut job = self.job(&id);
        let now = env::block_timestamp();
        require!(job.status == Status::Open, "the job is not open");
        require!(now < job.terms.work_until.0, "the work window is over: a mask on the job stays to the end");
        let key = seat_key(&id, &mask);
        let mut seat = self.seats.get(&key).cloned().unwrap_or_else(|| env::panic_str("this mask is not on the job"));
        require!(!seat.left, "this mask left the job");
        require!(seat.steps == 0, "a mask that sealed a step stays to the end");
        require!(
            job.left < job.terms.slots,
            "this job gave its slots back as many times as it has slots: a mask on it stays to the end"
        );
        let lost = held_cost(seat.bond, seat.since, now, job.terms.work_until.0);
        let back = seat.bond - lost;
        if back > 0 {
            Promise::new(seat.backer.clone()).transfer(NearToken::from_yoctonear(back)).detach();
        }
        if lost > 0 {
            Promise::new(job.terms.fee_to.clone()).transfer(NearToken::from_yoctonear(lost)).detach();
        }
        seat.left = true;
        seat.bond = 0;
        job.masks -= 1;
        job.left += 1;
        // The place freed among the mask's live jobs paid its storage from the reserve: it goes back there.
        self.flush();
        let before = env::storage_usage();
        self.seats.insert(key, seat);
        self.unlive(&mask);
        self.flush();
        job.reserve += cost_of(before.saturating_sub(env::storage_usage()));
        self.jobs.insert(id.clone(), job);
        event("leave", &Left { id: &id, mask: &mask, back: U128(back), lost: U128(lost) });
        self.view(&id)
    }

    /// The mask seals a step of its role: `hash` is sha256 of `maskwars-step:<job>:<mask>:<salt>:<content>`. Until the
    /// work window closes only the hash is known; the mask's own account is inside it, so nobody seals another mask's
    /// step.
    pub fn step(&mut self, id: String, hash: String) -> Step {
        let mask = env::predecessor_account_id();
        let mut job = self.job(&id);
        require!(job.status == Status::Open, "the job is not open");
        require!(env::block_timestamp() < job.terms.work_until.0, "the work window is over");
        require!(hex64_ok(&hash), "hash: sha256 in lowercase hex");
        let key = seat_key(&id, &mask);
        let mut seat = self.seats.get(&key).cloned().unwrap_or_else(|| env::panic_str("this mask is not on the job"));
        require!(!seat.left, "this mask left the job");
        require!(seat.steps < MAX_STEPS, "a mask records at most 4 steps on a job");
        let before = env::storage_usage();
        let step = Step {
            seq: job.steps,
            entrant: seat.entrant,
            mask: mask.clone(),
            role: seat.role,
            hash,
            at_ns: U64(env::block_timestamp()),
            content: None,
            digest: None,
            copy_of: None,
        };
        seat.steps += 1;
        job.steps += 1;
        self.seats.insert(key, seat);
        self.steps.insert(step_key(&id, step.seq), step.clone());
        self.jobs.insert(id.clone(), job);
        self.charge(&id, before);
        event("step", &StepEvent { id: &id, step: &step });
        step
    }

    /// After the work window the mask reveals its step: the salt and the content. Only the mask that sealed it, only
    /// with content that hashes to its seal under its own name. Content another step sealed earlier counts for that
    /// step only: this one is marked its copy. On a `tee_tests` or `ai_review` job the content is a box sealed for the
    /// judge's key (`mw1.…`), never plain text: only the judge reads the work.
    pub fn reveal(&mut self, id: String, seq: u32, salt: String, content: String) -> Step {
        let mask = env::predecessor_account_id();
        let job = self.job(&id);
        let now = env::block_timestamp();
        require!(job.status == Status::Open, "the job is not open");
        require!(now >= job.terms.work_until.0, "steps are revealed once the work window is over");
        require!(now < job.terms.reveal_until.0, "the reveal window is over");
        let key = step_key(&id, seq);
        let mut step = self.steps.get(&key).cloned().unwrap_or_else(|| env::panic_str("no such step"));
        require!(step.mask == mask, "only the mask that sealed a step reveals it");
        require!(step.content.is_none(), "this step is already revealed");
        require!(salt_ok(&salt), "salt: 16 to 128 letters, digits, - or _");
        if job.terms.kind == Kind::Drain {
            require!(!content.is_empty() && content.len() <= MAX_CONTENT_BYTES, "content: 1 to 1024 bytes");
        } else {
            require!(
                box_ok(&content),
                "content: a box sealed for the judge's key, mw1.…: no work is revealed in the open"
            );
        }
        require!(step_hash(&id, &mask, &salt, &content) == step.hash, "this content and salt are not what was sealed");
        let before = env::storage_usage();
        let digest = sha256_hex(content.as_bytes());
        let dkey = format!("{id}#{digest}");
        match self.digests.get(&dkey).copied() {
            Some(first) if first < seq => step.copy_of = Some(first),
            Some(later) => {
                // This step was sealed first: the earlier reveal is the copy.
                let lkey = step_key(&id, later);
                let mut other = self.steps.get(&lkey).cloned().unwrap();
                other.copy_of = Some(seq);
                self.steps.insert(lkey, other);
                self.digests.insert(dkey, seq);
            }
            None => {
                self.digests.insert(dkey, seq);
            }
        }
        step.content = Some(content);
        step.digest = Some(digest);
        self.steps.insert(key, step.clone());
        self.charge(&id, before);
        event("reveal", &StepEvent { id: &id, step: &step });
        step
    }

    // -------------------------------------------------------------------------------------------------------------
    // The meter
    // -------------------------------------------------------------------------------------------------------------

    /// The meter books `amount` that a mask's mind burned on this job: at most `fuel_per_mask` per mask, only for a
    /// mask on the job, only until the reveal window ends. Nothing moves yet: the verdict decides what the job pays.
    pub fn burn(&mut self, id: String, mask: AccountId, amount: U128) -> U128 {
        let job = self.job(&id);
        require!(env::predecessor_account_id() == job.terms.meter, "only the job's meter books fuel");
        require!(job.status == Status::Open, "the job is not open");
        require!(env::block_timestamp() < job.terms.reveal_until.0, "the job takes no more fuel");
        require!(amount.0 > 0, "nothing to book");
        let key = seat_key(&id, &mask);
        let mut seat = self.seats.get(&key).cloned().unwrap_or_else(|| env::panic_str("this mask is not on the job"));
        require!(!seat.left, "this mask left the job");
        let burned = seat.burned + amount.0;
        require!(burned <= job.terms.fuel_per_mask.0, "a mask burns at most fuel_per_mask on a job");
        seat.burned = burned;
        self.seats.insert(key, seat);
        event("burn", &Burned { id: &id, mask: &mask, amount, burned: U128(burned) });
        U128(burned)
    }

    // -------------------------------------------------------------------------------------------------------------
    // The judge
    // -------------------------------------------------------------------------------------------------------------

    /// After the reveal window anyone asks the judge, with `MIN_JUDGE_GAS`. A drain job reads its round's outcome on
    /// the bounty contract; the others ask their pinned judge on OutLayer, paid from the job's judge runs, or from
    /// the attached NEAR once those are spent. Only a job with a revealed striker's step has anything to judge.
    /// An appeal whose last run gave no answer (`appealing`) runs again the same way, until the appeal's deadline. Once
    /// the job's runs are spent the caller pays the run, and the appeal's held bond pays it back if the run called NEAR
    /// AI. No run is asked before the judge's own `retry_at`: a run during its back-off would call nothing.
    #[payable]
    pub fn judge(&mut self, id: String) -> Promise {
        let mut job = self.job(&id);
        let now = env::block_timestamp();
        if job.status == Status::Appealing {
            require!(
                now < self.appeal_deadline(&job),
                "the appeal's time is over: settle pays the verdict it was against"
            );
            require!(env::prepaid_gas() >= MIN_JUDGE_GAS, "attach at least 180 TGas");
            may_run(&job);
            job.runs += 1;
            let run = job.runs;
            job.status = Status::Judging { height: U64(env::block_height()), run };
            let payer = self.pay_run(&mut job, false);
            self.jobs.insert(id.clone(), job.clone());
            return self.ask_judge(&id, &job, Mode::Judge(run), payer);
        }
        require!(job.status == Status::Open, "the job is not waiting for a judge");
        require!(now >= job.terms.reveal_until.0, "the judge runs once the reveal window is over");
        require!(now < job.terms.judge_until.0, "the time to judge is over: close the job");
        require!(env::prepaid_gas() >= MIN_JUDGE_GAS, "attach at least 180 TGas");
        require!(self.has_strike(&id, &job), "no striker revealed any work: close the job");
        may_run(&job);
        job.runs += 1;
        let run = job.runs;
        job.status = Status::Judging { height: U64(env::block_height()), run };
        let me = env::current_account_id();
        if job.terms.kind == Kind::Drain {
            // Reading the round costs no judge run: whatever was attached goes back.
            let attached = env::attached_deposit().as_yoctonear();
            if attached > 0 {
                Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(attached)).detach();
            }
            self.jobs.insert(id.clone(), job.clone());
            let r = job.terms.round.clone().unwrap();
            return ext_bounty::ext(r.bounty)
                .with_static_gas(ROUND_GAS)
                .get(r.id)
                .then(Self::ext(me).with_static_gas(ON_ROUND_GAS).on_round(id, run));
        }
        let payer = self.pay_run(&mut job, false);
        self.jobs.insert(id.clone(), job.clone());
        self.ask_judge(&id, &job, Mode::Judge(run), payer)
    }

    /// Anyone appeals a verdict once, before its window ends, locking `APPEAL_BOND`. The same pinned judge runs again
    /// in appeal mode, with the first verdict in hand; its answer is final. A run that gives no answer leaves the appeal
    /// in (`appealing`): anyone runs it again with `judge` until `APPEAL_GRACE_HOURS` after the appeal window. Once the
    /// job's runs are spent, whoever asks a run pays it (the appeal itself: 0.01 NEAR on top of the bond), and the held
    /// bond pays it back only if the run called NEAR AI. The bond comes back if the winner or equal parts changed, or a
    /// step is no longer called fake; otherwise it goes to the company, which pays for the judges: an appeal that only
    /// finds more fake steps upholds the verdict. When the judge's final word is that it cannot decide, the verdict appealed against stands,
    /// final, and the bond goes to the company too: no more runs. If no answer comes in time, the verdict appealed
    /// against stands and the bond comes back. A drain's verdict is its round's: no appeal here.
    #[payable]
    pub fn appeal(&mut self, id: String) -> Promise {
        let mut job = self.job(&id);
        let by = env::predecessor_account_id();
        let bond = env::attached_deposit().as_yoctonear();
        require!(job.status == Status::Decided, "there is no verdict to appeal");
        let verdict = job.verdict.clone().unwrap();
        require!(!verdict.is_final, "this verdict is final");
        require!(job.appeal.is_none(), "this job was appealed already");
        require!(env::block_timestamp() < self.appeal_until(&job, &verdict), "the appeal window is over");
        require!(bond >= APPEAL_BOND.as_yoctonear(), "an appeal locks 0.2 NEAR");
        require!(env::prepaid_gas() >= MIN_JUDGE_GAS, "attach at least 180 TGas");
        let before = env::storage_usage();
        job.appeal = Some(Appeal { by: by.clone(), bond: U128(bond) });
        job.prior = Some(verdict);
        job.verdict = None;
        job.runs += 1;
        let run = job.runs;
        job.status = Status::Judging { height: U64(env::block_height()), run };
        let payer = self.pay_run(&mut job, true);
        self.jobs.insert(id.clone(), job.clone());
        self.charge(&id, before);
        let job = self.job(&id);
        event("appeal", &Appealed { id: &id, by: &by });
        self.ask_judge(&id, &job, Mode::Judge(run), payer)
    }

    /// Once a `tee_tests` or `ai_review` job is paid, anyone asks its judge, with `MIN_JUDGE_GAS` and one judge run's
    /// fee (`JUDGE_FEE`) attached, to hand the client the winning work: the judge opens the winner's boxes in its TEE,
    /// seals the work again for the client's key (`client_key`) and keeps the box in its project's public storage. Its
    /// answer names where and the box's sha256 (`deliver` event). Before the job is paid nobody gets the work, and work
    /// that did not win the judge never seals for anyone.
    #[payable]
    pub fn deliver(&mut self, id: String) -> Promise {
        let job = self.job(&id);
        require!(job.terms.kind != Kind::Drain, "a drain's plan is on chain: there is nothing to deliver");
        require!(matches!(job.status, Status::Paid { .. }), "the winning work goes to the client once the job is paid");
        require!(env::prepaid_gas() >= MIN_JUDGE_GAS, "attach at least 180 TGas");
        let fee = JUDGE_FEE.as_yoctonear();
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= fee, "a delivery is one judge run: attach 0.01 NEAR");
        if attached > fee {
            Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(attached - fee)).detach();
        }
        self.ask_judge(&id, &job, Mode::Deliver, env::predecessor_account_id())
    }

    /// Drops a judge run that never answered within `JUDGE_TIMEOUT_BLOCKS`: the job waits for its check or a judge
    /// again, or its appeal waits for another run. Anyone may call it; a late answer is ignored. A run nobody heard
    /// from called nothing anyone can show: the bond does not pay it back.
    pub fn unstick(&mut self, id: String) -> JobView {
        let mut job = self.job(&id);
        let Status::Judging { height, .. } = job.status else { env::panic_str("no judge run is out") };
        require!(env::block_height() >= height.0 + JUDGE_TIMEOUT_BLOCKS, "the judge may still answer");
        job.fronted = None;
        self.restore(&id, &mut job, "the judge never answered");
        self.jobs.insert(id.clone(), job);
        self.view(&id)
    }

    /// The judge's answer to run `run`. It never fails: an answer that cannot be read, or that is not a verdict on
    /// this job's revealed steps, refuses nothing, and the job waits for a judge again (an appeal for another run). An
    /// answer to any other run is ignored. Before the work window, the answer is the check of the client's material.
    #[private]
    pub fn on_judged(&mut self, id: String, run: u32) -> JobView {
        let reply = read_reply();
        let before = env::storage_usage();
        let mut job = self.job(&id);
        if !matches!(job.status, Status::Judging { run: r, .. } if r == run) {
            log!("job {} was not waiting for run {}: its answer is ignored", id, run);
            return self.view(&id);
        }
        let facts = reply.as_deref().map(|raw| run_facts(&id, raw)).unwrap_or_default();
        self.after_run(&mut job, &facts);
        if !job.checked {
            return self.on_checked(&id, job, reply.and_then(|raw| parse_reply(&id, raw)));
        }
        let appeal = job.appeal.is_some();
        let output = reply.and_then(|raw| parse_reply(&id, raw)).and_then(|o| self.check_verdict(&id, &job, o));
        match output {
            Err(why) => self.restore(&id, &mut job, &why),
            Ok(r) if appeal && r.undecided => {
                // The judge's final word: it cannot decide. The verdict appealed against stands, final, and no more
                // runs are paid from the bond, which goes to the company that paid for them.
                let mut prior = job.prior.clone().unwrap();
                prior.is_final = true;
                let a = job.appeal.clone().unwrap();
                if a.bond.0 > 0 {
                    Promise::new(job.terms.fee_to.clone()).transfer(NearToken::from_yoctonear(a.bond.0)).detach();
                }
                log!("job {}: the judge cannot decide the appeal; the verdict appealed against stands, final", id);
                event("verdict", &Decided { id: &id, verdict: &prior });
                job.verdict = Some(prior);
                job.status = Status::Decided;
            }
            Ok(r) => {
                let now = U64(env::block_timestamp());
                let verdict = Verdict {
                    winner: r.winner,
                    counted: r.counted,
                    fake: r.fake,
                    at_ns: now,
                    is_final: appeal,
                    shared: r.shared,
                    undecided: r.undecided,
                };
                if appeal {
                    // The bond comes back when the appeal changed who is paid or cleared a mask: the winner, equal
                    // parts for the client's fault, or a step the first verdict called fake that this one does not.
                    // Steps it only adds to `fake` uphold the verdict: a model's runs differ a little, and noise that
                    // costs others their bonds is no reason to appeal for free.
                    let prior = job.prior.clone().unwrap();
                    let cleared = prior.fake.iter().any(|s| !verdict.fake.contains(s));
                    let changed = prior.winner != verdict.winner || prior.shared != verdict.shared || cleared;
                    let a = job.appeal.clone().unwrap();
                    let to = if changed { a.by.clone() } else { job.terms.fee_to.clone() };
                    if a.bond.0 > 0 {
                        Promise::new(to).transfer(NearToken::from_yoctonear(a.bond.0)).detach();
                    }
                    log!("job {}: the appeal {} the verdict", id, if changed { "changed" } else { "upheld" });
                }
                event("verdict", &Decided { id: &id, verdict: &verdict });
                job.verdict = Some(verdict);
                job.status = Status::Decided;
            }
        }
        self.jobs.insert(id.clone(), job);
        self.charge_soft(&id, before);
        self.view(&id)
    }

    /// The bounty round's outcome for a drain job: its own judge confirmed the drain, so the verdict is final. A round
    /// still open leaves the job waiting.
    #[private]
    pub fn on_round(
        &mut self,
        id: String,
        run: u32,
        #[callback_result] round: Result<Option<Value>, PromiseError>,
    ) -> JobView {
        let before = env::storage_usage();
        let mut job = self.job(&id);
        if !matches!(job.status, Status::Judging { run: r, .. } if r == run) {
            return self.view(&id);
        }
        let status = round.ok().flatten().and_then(|v| serde_json::from_value::<BountyView>(v).ok()).map(|b| b.status);
        let winner = match status {
            Some(s) if s.state == "drained" || s.state == "paid" => s.winner,
            Some(s) if s.state == "refunded" => None,
            Some(_) => {
                self.restore(&id, &mut job, "the round is not over");
                self.jobs.insert(id.clone(), job);
                return self.view(&id);
            }
            None => {
                self.restore(&id, &mut job, "the bounty contract did not say how the round ended");
                self.jobs.insert(id.clone(), job);
                return self.view(&id);
            }
        };
        // The round paid one mask. Its entrant wins if that mask is the entrant's striker and revealed its work here.
        let entrant = winner.and_then(|w| {
            (0..job.steps)
                .map(|s| self.step_at(&id, s))
                .find(|s| s.mask == w && s.role == Role::Striker && s.eligible())
                .map(|s| s.entrant)
        });
        let counted = (0..job.steps).filter(|s| self.step_at(&id, *s).eligible()).collect();
        let verdict = Verdict {
            winner: entrant,
            counted,
            fake: vec![],
            at_ns: U64(env::block_timestamp()),
            is_final: true,
            shared: false,
            undecided: false,
        };
        event("verdict", &Decided { id: &id, verdict: &verdict });
        job.verdict = Some(verdict);
        job.status = Status::Decided;
        self.jobs.insert(id.clone(), job);
        self.charge_soft(&id, before);
        self.view(&id)
    }

    /// The judge's answer to a delivery: where it keeps the winning work sealed for the client's key. Nothing on the job
    /// changes; the `deliver` event tells the client where to read the box.
    #[private]
    pub fn on_delivered(&mut self, id: String) -> Option<Delivery> {
        let job = self.job(&id);
        let delivered =
            read_reply().and_then(|raw| parse_reply(&id, raw)).and_then(|o| match (o.delivered, o.sha256) {
                (Some(at), Some(sha)) if !at.is_empty() && at.len() <= 200 && hex64_ok(&sha) => Ok((at, sha)),
                _ => Err("the judge's answer is not a delivery".to_string()),
            });
        match delivered {
            Ok((at, sha256)) => {
                let d = Delivery { at, sha256, key: job.terms.client_key.clone().unwrap_or_default() };
                event("deliver", &Delivered { id: &id, delivery: &d });
                Some(d)
            }
            Err(why) => {
                log!("job {}: {}; ask again", id, why);
                None
            }
        }
    }

    // -------------------------------------------------------------------------------------------------------------
    // Settling
    // -------------------------------------------------------------------------------------------------------------

    /// Pays a decided job once its appeal window is over (at once when final), with `MIN_SETTLE_GAS`. Anyone may.
    /// - the reward to the winner, less the fee, to its masks by its split; the fee to the company;
    /// - under a `shared` verdict (the client's own material missing or broken), an equal part of the reward to every
    ///   entrant with a counted striker step, each split by its rule, less the fee;
    /// - the fuel of every mask with a counted step, to the treasury that pays NEAR AI;
    /// - the bond of every fake mask to the company, never to the winner or the client: nobody gains by calling others
    ///   fake or baiting them into it; half the bond of every mask on the job with no counted step of its own to the
    ///   company too, and the rest of it back: a seat whose work counted for nothing (a module that passes no case, a
    ///   review scored zero on two seeds) is not free to hold;
    /// - every other bond back to whoever locked it;
    /// - when nobody wins, the reward back to the client;
    /// - everything else to the client: unburned and uncovered fuel, judge runs left, the storage reserve left and all
    ///   the storage the job's masks took, which is cleared now.
    ///
    /// An appeal still without an answer at its deadline lapses here: the verdict it was against is paid, and its bond
    /// goes back to whoever appealed.
    pub fn settle(&mut self, id: String) -> JobView {
        let mut job = self.job(&id);
        let now = env::block_timestamp();
        require!(env::prepaid_gas() >= MIN_SETTLE_GAS, "attach at least 200 TGas");
        let mut lapsed = false;
        if job.status == Status::Appealing {
            require!(now >= self.appeal_deadline(&job), "the appeal may still be answered: anyone runs it with judge");
            let a = job.appeal.take().unwrap();
            if a.bond.0 > 0 {
                Promise::new(a.by).transfer(NearToken::from_yoctonear(a.bond.0)).detach();
            }
            job.verdict = job.prior.take();
            job.status = Status::Decided;
            lapsed = true;
            log!("job {}: the appeal got no answer in time; the verdict it was against stands", id);
        }
        require!(job.status == Status::Decided, "the job has no verdict to pay");
        let verdict = job.verdict.clone().unwrap();
        require!(
            verdict.is_final || lapsed || now >= self.appeal_until(&job, &verdict),
            "the verdict may still be appealed"
        );
        let counted = self.masks_of(&id, &verdict.counted);
        let fake = self.masks_of(&id, &verdict.fake);
        let (award, status) = if verdict.shared {
            (Award::Shared(self.counted_strikers(&id, &verdict.counted)), Status::Shared)
        } else {
            match verdict.winner {
                Some(e) => (Award::Winner(e), Status::Paid { winner: e }),
                None => (Award::Nobody, Status::Closed),
            }
        };
        self.finish(&id, job, award, counted, fake, status);
        self.view(&id)
    }

    /// Closes a job nobody judged, with `MIN_SETTLE_GAS`. Anyone may. Nobody is named, so nobody is paid a reward and
    /// nobody is fake: every bond goes back, but half of each that a seat with no counted step held.
    /// - The judge did not pass the client's material within `CHECK_HOURS`: no mask started, everything goes back.
    /// - After the reveal window with no striker's work revealed: nobody delivered the work, so no step counts: the
    ///   reward goes back, no fuel is paid and every seat pays its idle half.
    /// - Once the time to judge is over with revealed work and no verdict (a drain's round that never ended, a judge
    ///   that never answered): the reward goes back to the client, who saw none of the work, since a revealed step of
    ///   a `tee_tests` or `ai_review` job is sealed for the judge. With no judge to say otherwise every revealed step
    ///   counts: the fuel of every mask with one is paid, to NEAR AI as always, and its bond comes back whole.
    ///   Revealed junk earns nothing.
    pub fn close(&mut self, id: String) -> JobView {
        let job = self.job(&id);
        let now = env::block_timestamp();
        require!(job.status == Status::Open, "the job is not open");
        require!(env::prepaid_gas() >= MIN_SETTLE_GAS, "attach at least 200 TGas");
        if !job.checked {
            require!(now >= self.check_until(&job), "the judge may still check the client's material");
            self.finish(&id, job, Award::Nobody, vec![], vec![], Status::Closed);
            event("close", &Named { id: &id });
            return self.view(&id);
        }
        require!(now >= job.terms.reveal_until.0, "masks are still working");
        if self.has_strike(&id, &job) {
            require!(now >= job.terms.judge_until.0, "a striker's work waits for the judge until judge_until");
            let counted = self.revealed_masks(&id, &job);
            self.finish(&id, job, Award::Nobody, counted, vec![], Status::Closed);
        } else {
            self.finish(&id, job, Award::Nobody, vec![], vec![], Status::Closed);
        }
        event("close", &Named { id: &id });
        self.view(&id)
    }

    // -------------------------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------------------------

    pub fn get(&self, id: String) -> Option<JobView> {
        self.jobs.contains_key(&id).then(|| self.view(&id))
    }

    /// Jobs in the order they opened, from `from_index`, at most 50.
    pub fn list(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<JobView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(50);
        (from..self.ids.len().min(from.saturating_add(limit))).map(|i| self.view(&self.ids[i])).collect()
    }

    /// The entrants of a live job. Once a job is paid or closed its state is cleared: its `enlist` events and its
    /// `settle` or `close` event keep the record.
    pub fn entrants(&self, id: String) -> Vec<Entrant> {
        let job = self.jobs.get(&id).unwrap_or_else(|| env::panic_str("no such job"));
        (0..job.entrants).filter_map(|i| self.entrants.get(&format!("{id}/{i}")).cloned()).collect()
    }

    /// Steps of a live job in the order they were sealed, from `from_index`, at most 64. Content shows only once
    /// revealed. Once the job is paid or closed, its `step` and `reveal` events keep them.
    pub fn steps(&self, id: String, from_index: Option<u32>, limit: Option<u32>) -> Vec<Step> {
        let job = self.jobs.get(&id).unwrap_or_else(|| env::panic_str("no such job"));
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(64).min(64);
        (from..job.steps.min(from.saturating_add(limit)))
            .filter_map(|s| self.steps.get(&step_key(&id, s)).cloned())
            .collect()
    }

    /// Every mask's fuel on a live job: what it burned and, once decided, what the job will pay. What the job does not
    /// pay, the keeper settles from the mask's own tank. Once paid or closed, the `settle` or `close` event holds it.
    pub fn fuel(&self, id: String) -> Vec<FuelView> {
        let job = self.jobs.get(&id).unwrap_or_else(|| env::panic_str("no such job"));
        let counted = match (&job.status, &job.verdict) {
            (Status::Decided, Some(v)) => Some(self.counted_masks(&id, v)),
            _ => None,
        };
        self.seats_of(&id, job)
            .into_iter()
            .map(|(mask, seat)| {
                let covered = counted.as_ref().map(|c| U128(if c.contains(&mask) { seat.burned } else { 0 }));
                FuelView {
                    mask,
                    entrant: seat.entrant,
                    role: seat.role,
                    burned: U128(seat.burned),
                    steps: seat.steps,
                    covered,
                }
            })
            .collect()
    }

    /// The bond of `mask` on job `id`: locked and waiting for the mask to enlist, or held on its seat. `None` once the
    /// job's seats are cleared: its `settle` event says where every bond went.
    pub fn bond_of(&self, id: String, mask: AccountId) -> Option<BondView> {
        let key = seat_key(&id, &mask);
        if let Some(b) = self.bonds.get(&key) {
            return Some(BondView { by: b.by.clone(), amount: b.amount, enlisted: false });
        }
        self.seats.get(&key).filter(|s| !s.left).map(|s| BondView {
            by: s.backer.clone(),
            amount: U128(s.bond),
            enlisted: true,
        })
    }

    /// What opening a job with these numbers takes. `record` is a ceiling: `open` charges the real size.
    pub fn quote(&self, reward: U128, fuel_per_mask: U128, slots: u8) -> Quote {
        let fuel = fuel_per_mask.0 * u128::from(slots);
        let judge = JUDGE_FEE.as_yoctonear() * JUDGE_RUNS;
        let reserve = reserve_for(slots);
        let record = cost_of(JOB_RECORD_BYTES);
        Quote {
            reward,
            fuel: U128(fuel),
            judge: U128(judge),
            reserve: U128(reserve),
            record: U128(record),
            total: U128(reward.0 + fuel + judge + reserve + record),
        }
    }

    /// The seal a mask computes for a step, for agents that would rather ask than hash.
    pub fn seal_of(&self, id: String, mask: AccountId, salt: String, content: String) -> String {
        step_hash(&id, &mask, &salt, &content)
    }

    pub fn config(&self) -> Config {
        Config {
            admin: self.admin.clone(),
            meter: self.meter.clone(),
            treasury: self.treasury.clone(),
            outlayer: self.outlayer.clone(),
            crews: self.crews.clone(),
            judges: self.judges.clone(),
            bounties: self.bounties.clone(),
            factories: self.factories.clone(),
            fee_bps: self.fee_bps,
            fee_to: self.fee_to.clone(),
            jobs: self.ids.len(),
            live: self.live,
            pending: self.pending.clone(),
            judge_fee: U128(JUDGE_FEE.as_yoctonear()),
            appeal_bond: U128(APPEAL_BOND.as_yoctonear()),
            max_slots: MAX_SLOTS,
            max_steps: MAX_STEPS,
        }
    }
}

impl Jobs {
    /// The check's answer: the client's material passed, and the work window starts now; or it was refused, and
    /// everything goes back to the client, since no mask has started. No answer leaves the job waiting for its check.
    fn on_checked(&mut self, id: &str, mut job: Job, output: Result<JudgeOutput, String>) -> JobView {
        let now = env::block_timestamp();
        let answer = output.and_then(|o| match o.checked {
            Some(passed) if now < self.check_until(&job) => Ok((passed, o.why.unwrap_or_default())),
            Some(_) => Err("the check came after the time to check".into()),
            None => Err("the judge answered with a verdict, not a check".into()),
        });
        match answer {
            Err(why) => {
                self.restore(id, &mut job, &why);
                self.jobs.insert(id.to_string(), job);
            }
            Ok((true, _)) => {
                // The windows start now, as long as the client asked for them.
                let shift = now - job.terms.opened_ns.0;
                job.terms.work_until.0 += shift;
                job.terms.reveal_until.0 += shift;
                job.terms.judge_until.0 += shift;
                job.checked = true;
                job.status = Status::Open;
                event("check", &Checked { id, work_until: job.terms.work_until, reveal_until: job.terms.reveal_until });
                self.jobs.insert(id.to_string(), job);
            }
            Ok((false, why)) => {
                let why: String = why.chars().take(200).collect();
                event("refuse", &Refused { id, why: &why });
                self.finish(id, job, Award::Nobody, vec![], vec![], Status::Cancelled);
            }
        }
        self.view(id)
    }

    /// Until then the judge may pass the client's material.
    fn check_until(&self, job: &Job) -> u64 {
        job.terms.opened_ns.0 + CHECK_HOURS * NS_PER_HOUR
    }

    /// Until then an appeal's judge may still answer; after it the verdict appealed against stands.
    fn appeal_deadline(&self, job: &Job) -> u64 {
        let prior = job.prior.as_ref().unwrap_or_else(|| env::panic_str("no appeal is in"));
        self.appeal_until(job, prior) + APPEAL_GRACE_HOURS * NS_PER_HOUR
    }

    /// The entrants with a counted striker step, in the order their first counted strikes were sealed: under a `shared`
    /// verdict each takes an equal part.
    fn counted_strikers(&self, id: &str, counted: &[u32]) -> Vec<u32> {
        let mut seqs = counted.to_vec();
        seqs.sort_unstable();
        let mut entrants: Vec<u32> = vec![];
        for s in seqs {
            let step = self.step_at(id, s);
            if step.role == Role::Striker && !entrants.contains(&step.entrant) {
                entrants.push(step.entrant);
            }
        }
        entrants
    }

    /// The masks that made these steps.
    fn masks_of(&self, id: &str, seqs: &[u32]) -> Vec<AccountId> {
        let mut masks: Vec<AccountId> = seqs.iter().map(|s| self.step_at(id, *s).mask).collect();
        masks.sort();
        masks.dedup();
        masks
    }

    /// The masks with a revealed, original step: with no verdict, the fuel of every one is paid.
    fn revealed_masks(&self, id: &str, job: &Job) -> Vec<AccountId> {
        let mut masks: Vec<AccountId> =
            (0..job.steps).map(|s| self.step_at(id, s)).filter(Step::eligible).map(|s| s.mask).collect();
        masks.sort();
        masks.dedup();
        masks
    }

    fn job(&self, id: &str) -> Job {
        self.jobs.get(id).cloned().unwrap_or_else(|| env::panic_str("no such job"))
    }

    fn entrant(&self, id: &str, i: u32) -> Entrant {
        self.entrants.get(&format!("{id}/{i}")).cloned().unwrap_or_else(|| env::panic_str("no such entrant"))
    }

    fn step_at(&self, id: &str, seq: u32) -> Step {
        self.steps.get(&step_key(id, seq)).cloned().unwrap_or_else(|| env::panic_str("no such step"))
    }

    fn fuel_pool(&self, job: &Job) -> u128 {
        job.terms.fuel_per_mask.0 * u128::from(job.terms.slots)
    }

    /// Every mask on the job with its seat, entrant by entrant; none once the job is cleared.
    fn seats_of(&self, id: &str, job: &Job) -> Vec<(AccountId, Seat)> {
        (0..job.entrants)
            .filter_map(|i| self.entrants.get(&format!("{id}/{i}")).cloned())
            .flat_map(|e| e.members)
            .filter_map(|m| self.seats.get(&seat_key(id, &m.mask)).cloned().map(|seat| (m.mask, seat)))
            .collect()
    }

    /// The masks with a counted step.
    fn counted_masks(&self, id: &str, verdict: &Verdict) -> Vec<AccountId> {
        self.masks_of(id, &verdict.counted)
    }

    /// Takes the bond locked for each member (`bond`): the record goes, and its storage goes back to whoever locked it.
    fn take_bonds(&mut self, id: &str, members: &[Member]) -> Vec<(AccountId, u128)> {
        let mut out = vec![];
        let mut storage: Vec<(AccountId, u128)> = vec![];
        for m in members {
            let b = self.bonds.remove(&seat_key(id, &m.mask)).unwrap_or_else(|| {
                env::panic_str("every mask takes a job with a bond locked for it first: bond(id, mask)")
            });
            match storage.iter_mut().find(|(by, _)| *by == b.by) {
                Some((_, a)) => *a += b.storage.0,
                None => storage.push((b.by.clone(), b.storage.0)),
            }
            out.push((b.by, b.amount.0));
        }
        self.flush();
        for (by, amount) in storage {
            if amount > 0 {
                Promise::new(by).transfer(NearToken::from_yoctonear(amount)).detach();
            }
        }
        out
    }

    fn has_strike(&self, id: &str, job: &Job) -> bool {
        (0..job.steps).any(|s| {
            let step = self.step_at(id, s);
            step.role == Role::Striker && step.eligible()
        })
    }

    fn appeal_until(&self, job: &Job, verdict: &Verdict) -> u64 {
        verdict.at_ns.0 + u64::from(job.terms.appeal_minutes) * NS_PER_MINUTE
    }

    /// Whether these masks may take the job: it is open and checked, its window and slots allow them, and each is
    /// welcome on it and has a place left among its live jobs.
    fn may_seat(&self, id: &str, members: &[Member]) {
        let job = self.job(id);
        require!(job.status == Status::Open, "the job is not open");
        require!(job.checked, "the judge has not passed the client's material yet: no mask starts before it");
        require!(env::block_timestamp() < job.terms.work_until.0, "the work window is over: no new masks");
        require!(job.masks + members.len() as u8 <= job.terms.slots, "the job has no slot left for this many masks");
        for m in members {
            require!(m.mask != job.client, "the client is not one of its own job's masks");
            require!(!self.seats.contains_key(&seat_key(id, &m.mask)), "a mask is on a job once");
            match &job.terms.open_to {
                OpenTo::Anyone => {}
                OpenTo::Registered { factories } => require!(
                    factories.iter().any(|f| direct_sub(&m.mask, f)),
                    "this job takes only masks forged by a known factory"
                ),
                OpenTo::Masks { masks } => require!(masks.contains(&m.mask), "this job takes only its listed masks"),
            }
            let on = self.live_of.get(&m.mask).copied().unwrap_or(0);
            require!(on < MAX_LIVE_JOBS_PER_MASK, "a mask is on at most 4 live jobs at once");
        }
    }

    /// Puts a mask or a crew on the job, each mask with the bond it took. `may_seat` said it may.
    fn seat_entrant(&mut self, id: &str, entrant: Entrant, bonds: Vec<(AccountId, u128)>) -> u32 {
        let mut job = self.job(id);
        let n = entrant.members.len() as u8;
        let index = job.entrants;
        for (m, (backer, bond)) in entrant.members.iter().zip(bonds) {
            require!(bond >= job.terms.bond.0, "the bond locked for a mask is less than this job's");
            let on = self.live_of.get(&m.mask).copied().unwrap_or(0);
            self.live_of.insert(m.mask.clone(), on + 1);
            let since = env::block_timestamp();
            let seat = Seat { entrant: index, role: m.role, burned: 0, steps: 0, left: false, bond, backer, since };
            self.seats.insert(seat_key(id, &m.mask), seat);
        }
        job.entrants += 1;
        job.masks += n;
        self.jobs.insert(id.to_string(), job);
        event("enlist", &Enlisted { id, entrant: index, crew: entrant.crew.as_deref(), members: &entrant.members });
        self.entrants.insert(format!("{id}/{index}"), entrant);
        index
    }

    /// Ends a job: pays the reward to the `award`'s entrants, less the fee, each split by its rule among its masks in
    /// `counted`; pays the fuel of every mask in `counted` to the treasury; sends the bond of every `fake` mask to the
    /// company, and half the bond of every mask not in `counted` (but on a cancelled job, where nobody could work yet):
    /// a seat the job counted nothing of; sends every other bond, and the rest of those, back to whoever locked it;
    /// clears the job's masks, steps and seats and sends the client everything else, the storage they took included.
    /// With nobody to award, the reward goes back to the client. A lost bond never reaches the winner or the client:
    /// nobody gains by calling others fake or by baiting them into it.
    fn finish(
        &mut self,
        id: &str,
        mut job: Job,
        award: Award,
        counted: Vec<AccountId>,
        fake: Vec<AccountId>,
        status: Status,
    ) {
        let seats = self.seats_of(id, &job);
        let fuel: Vec<FuelLine> = seats
            .iter()
            .map(|(mask, seat)| FuelLine {
                mask: mask.clone(),
                burned: U128(seat.burned),
                covered: U128(if counted.contains(mask) { seat.burned } else { 0 }),
            })
            .collect();
        let covered: u128 = fuel.iter().map(|f| f.covered.0).sum();
        // Bonds: a fake mask's goes to the company whole; a seat with no counted step, half; every other one, and the
        // rest, back to whoever locked it. A mask that left has settled its own already.
        let idle = status != Status::Cancelled;
        let mut bonds: Vec<BondLine> = vec![];
        let mut returns: Vec<(AccountId, u128)> = vec![];
        let mut forfeit = 0;
        for (mask, seat) in seats.iter().filter(|(_, seat)| !seat.left && seat.bond > 0) {
            let (lost, why) = if fake.contains(mask) {
                (seat.bond, Some(Lost::Fake))
            } else if idle && !counted.contains(mask) {
                (idle_part(seat.bond), Some(Lost::Idle))
            } else {
                (0, None)
            };
            bonds.push(BondLine { mask: mask.clone(), bond: U128(seat.bond), lost: U128(lost), why });
            forfeit += lost;
            if seat.bond > lost {
                match returns.iter_mut().find(|(by, _)| *by == seat.backer) {
                    Some((_, a)) => *a += seat.bond - lost,
                    None => returns.push((seat.backer.clone(), seat.bond - lost)),
                }
            }
        }
        let reward = job.terms.reward.0;
        let parts: Vec<(u32, u128)> = match award {
            Award::Winner(e) => vec![(e, reward)],
            Award::Shared(entrants) if !entrants.is_empty() => {
                let n = entrants.len() as u128;
                let part = reward / n;
                // What rounding leaves goes to the first to seal a counted strike.
                entrants
                    .iter()
                    .enumerate()
                    .map(|(i, e)| (*e, if i == 0 { reward - part * (n - 1) } else { part }))
                    .collect()
            }
            Award::Shared(_) | Award::Nobody => vec![],
        };
        let mut back = self.fuel_pool(&job) - covered + job.judge_budget + job.reserve + reward;
        // Lost bonds pay the company that pays for the judges, whoever wins.
        let to_company = forfeit;
        let mut payouts: Vec<(AccountId, u128)> = vec![];
        let mut fee = 0;
        for (e, part) in parts {
            let entrant = self.entrant(id, e);
            let take = part * u128::from(job.terms.fee_bps) / u128::from(BPS);
            let paid: Vec<bool> = entrant.members.iter().map(|m| counted.contains(&m.mask)).collect();
            let shares = shares(part - take, &entrant.members, &entrant.split, &paid);
            let sent: u128 = shares.iter().map(|(_, a)| *a).sum();
            if sent == 0 {
                // Nobody of this entrant is paid, so the company takes nothing either. A winner and every entrant of a
                // shared verdict has a counted strike, so this part is never one.
                continue;
            }
            back -= sent + take;
            fee += take;
            payouts.extend(shares.into_iter().filter(|(_, a)| *a > 0));
        }
        // Clear what the job's masks stored; the client paid for it, so it gets it back.
        self.flush();
        let before = env::storage_usage();
        self.clear(id, &job);
        job.status = status;
        job.reserve = 0;
        job.judge_budget = 0;
        self.jobs.insert(id.to_string(), job.clone());
        self.flush();
        let after = env::storage_usage();
        back += cost_of(before.saturating_sub(after));
        if fee + to_company > 0 {
            Promise::new(job.terms.fee_to.clone()).transfer(NearToken::from_yoctonear(fee + to_company)).detach();
        }
        if covered > 0 {
            Promise::new(job.terms.treasury.clone()).transfer(NearToken::from_yoctonear(covered)).detach();
        }
        // Plain transfers: a payout costs half a TGas, so a whole crew is paid in one call. A mask's account that no
        // longer exists sends its payout back to this contract, where it stays: a forged mask holds no key that could
        // delete its account.
        for (mask, amount) in &payouts {
            Promise::new(mask.clone()).transfer(NearToken::from_yoctonear(*amount)).detach();
        }
        for (by, amount) in &returns {
            Promise::new(by.clone()).transfer(NearToken::from_yoctonear(*amount)).detach();
        }
        if back > 0 {
            Promise::new(job.client.clone()).transfer(NearToken::from_yoctonear(back)).detach();
        }
        self.live -= 1;
        event(
            "settle",
            &Settled {
                id,
                status: &job.status,
                payouts: payouts.iter().map(|(mask, a)| Payout { mask: mask.clone(), amount: U128(*a) }).collect(),
                fee: U128(fee),
                fuel,
                bonds,
                forfeit: U128(forfeit),
                back: U128(back),
            },
        );
    }

    /// Removes the job's steps, their digests, its entrants and seats, and frees its masks for other jobs.
    fn clear(&mut self, id: &str, job: &Job) {
        for s in 0..job.steps {
            if let Some(step) = self.steps.remove(&step_key(id, s)) {
                if let Some(d) = step.digest {
                    self.digests.remove(&format!("{id}#{d}"));
                }
            }
        }
        for i in 0..job.entrants {
            let Some(entrant) = self.entrants.remove(&format!("{id}/{i}")) else { continue };
            for m in entrant.members {
                // A mask that left has freed its place already.
                if self.seats.remove(&seat_key(id, &m.mask)).is_some_and(|seat| !seat.left) {
                    self.unlive(&m.mask);
                }
            }
        }
    }

    /// One live job fewer for the mask.
    fn unlive(&mut self, mask: &AccountId) {
        match self.live_of.get(mask).copied().unwrap_or(0) {
            0 | 1 => drop(self.live_of.remove(mask)),
            on => drop(self.live_of.insert(mask.clone(), on - 1)),
        }
    }

    /// Pays the storage an action took out of the job's reserve.
    fn charge(&mut self, id: &str, before: u64) {
        self.flush();
        let after = env::storage_usage();
        if after <= before {
            return;
        }
        let cost = cost_of(after - before);
        let mut job = self.job(id);
        require!(job.reserve >= cost, "the job's storage reserve is spent");
        job.reserve -= cost;
        self.jobs.insert(id.to_string(), job);
    }

    /// The same for what a callback stored: from the reserve while it lasts, then from the contract's own NEAR.
    fn charge_soft(&mut self, id: &str, before: u64) {
        self.flush();
        let after = env::storage_usage();
        if after <= before {
            return;
        }
        let mut job = self.job(id);
        let cost = cost_of(after - before).min(job.reserve);
        job.reserve -= cost;
        self.jobs.insert(id.to_string(), job);
    }

    pub(crate) fn flush(&mut self) {
        self.jobs.flush();
        self.ids.flush();
        self.entrants.flush();
        self.seats.flush();
        self.steps.flush();
        self.digests.flush();
        self.live_of.flush();
        self.bonds.flush();
    }

    /// Takes one judge run out of the job's runs; once those are spent, out of what the caller attached: the caller
    /// fronts the run (`fronted`), and on an appeal the held bond pays it back once the run has called NEAR AI
    /// (`on_judged`). A run that called nothing never costs the appeal's bond, so nobody burns it with runs during an
    /// outage. What the caller attached and the run did not take goes back, but an appeal's own bond (`bond_attached`),
    /// which is held until the verdict: the appeal that finds the runs spent attaches the run on top of it.
    fn pay_run(&mut self, job: &mut Job, bond_attached: bool) -> AccountId {
        let fee = JUDGE_FEE.as_yoctonear();
        let attached = env::attached_deposit().as_yoctonear();
        let caller = env::predecessor_account_id();
        let back = |amount: u128| {
            if !bond_attached && amount > 0 {
                Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(amount)).detach();
            }
        };
        job.retry_at = 0;
        job.fronted = None;
        if job.judge_budget >= fee {
            job.judge_budget -= fee;
            back(attached);
            return env::current_account_id();
        }
        if bond_attached {
            let a = job.appeal.as_mut().unwrap();
            require!(
                a.bond.0 >= APPEAL_BOND.as_yoctonear() + fee,
                "the job's judge runs are spent: an appeal locks 0.2 NEAR and attaches 0.01 NEAR for its run"
            );
            a.bond = U128(a.bond.0 - fee);
        } else {
            require!(attached >= fee, "the job's judge runs are spent: attach 0.01 NEAR");
            back(attached - fee);
        }
        if job.appeal.is_some() {
            job.fronted = Some(caller.clone());
        }
        caller
    }

    /// What a judge run said about itself, answer or not: when a run can make progress again, and whether it called
    /// NEAR AI. Runs wait for the judge's back-off (at most `MAX_RETRY_WAIT_MINUTES`); a run an appeal's caller fronted
    /// is paid back from the held bond only if it called NEAR AI.
    fn after_run(&mut self, job: &mut Job, facts: &RunFacts) {
        let now = env::block_timestamp();
        job.retry_at =
            facts.retry_at.filter(|t| *t > now).map_or(0, |t| t.min(now + MAX_RETRY_WAIT_MINUTES * NS_PER_MINUTE));
        let fee = JUDGE_FEE.as_yoctonear();
        if let (Some(by), Some(a)) = (job.fronted.take(), job.appeal.as_mut()) {
            if facts.asked > 0 && a.bond.0 >= fee {
                a.bond = U128(a.bond.0 - fee);
                log!("the appeal's bond pays back the run {} fronted: it called NEAR AI {} times", by, facts.asked);
                Promise::new(by).transfer(NearToken::from_yoctonear(fee)).detach();
            }
        }
    }

    /// Asks the job's pinned judge on OutLayer. The client's secrets row is named only for the check: there the judge
    /// keeps its own copy of the test set, so no later run depends on anything the client still holds.
    fn ask_judge(&self, id: &str, job: &Job, mode: Mode, payer: AccountId) -> Promise {
        let judge = job.terms.judge.clone().unwrap();
        let deliver = mode == Mode::Deliver;
        let appeal = job.appeal.is_some() && !deliver;
        let input = json!({
            "job": id,
            "contract": env::current_account_id(),
            "kind": job.terms.kind,
            "appeal": appeal,
            "prior": if deliver { None } else { job.prior.clone() },
            "check": !job.checked,
            "deliver": deliver,
        })
        .to_string();
        let secrets = job
            .terms
            .secrets
            .as_ref()
            .filter(|_| !job.checked)
            .map(|s| json!({ "profile": s.profile, "account_id": s.account_id }));
        let name = if deliver {
            "deliver"
        } else if !job.checked {
            "check"
        } else if appeal {
            "appeal"
        } else {
            "first"
        };
        log!("job {} goes to judge {} ({})", id, judge.version, name);
        let then = match mode {
            Mode::Judge(run) => {
                Self::ext(env::current_account_id()).with_static_gas(ON_JUDGED_GAS).on_judged(id.to_string(), run)
            }
            Mode::Deliver => {
                Self::ext(env::current_account_id()).with_static_gas(ON_JUDGED_GAS).on_delivered(id.to_string())
            }
        };
        ext_outlayer::ext(job.terms.outlayer.clone())
            .with_attached_deposit(JUDGE_FEE)
            .with_static_gas(OUTLAYER_GAS)
            .with_unused_gas_weight(1)
            .request_execution(
                json!({ "Project": { "project_id": judge.project, "version_key": judge.version } }),
                Some(
                    json!({ "max_instructions": 1_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 60 }),
                ),
                Some(input),
                secrets,
                Some("Text".into()),
                Some(payer),
                None,
            )
            .then(then)
    }

    /// A judge run that decided nothing: the job waits for its check or a judge again, or its appeal for another run.
    fn restore(&mut self, id: &str, job: &mut Job, why: &str) {
        log!("job {}: {}; nothing is decided", id, why);
        job.status = if job.appeal.is_some() { Status::Appealing } else { Status::Open };
    }

    /// A verdict on this job's revealed steps: every counted and every fake step is revealed and nobody's copy, no step
    /// is both, and the winner, if any, has a counted striker's step of its own. A `shared` verdict names no winner.
    /// An undecided one names nobody: nobody wins, nobody is fake, and the fuel of every revealed step is paid, as when
    /// no verdict comes at all.
    fn check_verdict(&self, id: &str, job: &Job, o: JudgeOutput) -> Result<Ruling, String> {
        if o.checked.is_some() || o.delivered.is_some() {
            return Err("the judge answered with a check or a delivery, not a verdict".into());
        }
        if o.undecided {
            let all = (0..job.steps).filter(|s| self.step_at(id, *s).eligible()).collect();
            return Ok(Ruling { winner: None, counted: all, fake: vec![], shared: false, undecided: true });
        }
        let mut counted = o.counted;
        counted.sort_unstable();
        counted.dedup();
        let mut fake = o.fake;
        fake.sort_unstable();
        fake.dedup();
        for s in counted.iter().chain(&fake) {
            if *s >= job.steps || !self.step_at(id, *s).eligible() {
                return Err(format!("the judge named step {s}, which is not revealed work"));
            }
        }
        if let Some(s) = fake.iter().find(|s| counted.contains(s)) {
            return Err(format!("the judge called step {s} both counted and fake"));
        }
        if o.shared {
            return Ok(Ruling { winner: None, counted, fake, shared: true, undecided: false });
        }
        if let Some(w) = o.winner {
            if w >= job.entrants {
                return Err(format!("the judge named entrant {w}, which is not on the job"));
            }
            let strike = counted.iter().any(|s| {
                let step = self.step_at(id, *s);
                step.entrant == w && step.role == Role::Striker
            });
            if !strike {
                return Err("the judge's winner has no counted strike".into());
            }
        }
        Ok(Ruling { winner: o.winner, counted, fake, shared: false, undecided: false })
    }

    fn view(&self, id: &str) -> JobView {
        let job = self.jobs.get(id).unwrap_or_else(|| env::panic_str("no such job"));
        let now = env::block_timestamp();
        let phase = match &job.status {
            Status::Open if !job.checked => "checking",
            Status::Open if now < job.terms.work_until.0 => "enlisting",
            Status::Open if now < job.terms.reveal_until.0 => "revealing",
            Status::Open => "waiting",
            Status::Judging { .. } => "judging",
            Status::Decided => "decided",
            Status::Paid { .. } => "paid",
            Status::Closed => "closed",
            Status::Cancelled => "cancelled",
            Status::Shared => "shared",
            Status::Appealing => "appealing",
        };
        JobView {
            id: id.to_string(),
            client: job.client.clone(),
            terms: job.terms.clone(),
            status: job.status.clone(),
            masks: job.masks,
            entrants: job.entrants,
            steps: job.steps,
            runs: job.runs,
            reserve: U128(job.reserve),
            judge_budget: U128(job.judge_budget),
            verdict: job.verdict.clone(),
            prior: job.prior.clone(),
            appeal: job.appeal.clone(),
            checked: job.checked,
            left: job.left,
            retry_at: U64(job.retry_at),
            phase: phase.into(),
        }
    }
}

/// The reserve a job of `slots` holds for the storage its masks take: each slot's biggest mask, and one mask that
/// left a slot for each slot, and the verdict, the one before an appeal and the appeal.
fn reserve_for(slots: u8) -> u128 {
    cost_of(u64::from(slots) * (MASK_STORAGE_BYTES + LEFT_SEAT_BYTES) + JOB_GROWTH_BYTES)
}

/// What a seat that gave the job nothing costs: `IDLE_BPS` of its bond.
pub fn idle_part(bond: u128) -> u128 {
    bond * u128::from(IDLE_BPS) / u128::from(BPS)
}

/// What a mask that leaves pays for holding its slot from `since` to `now`: the idle part of its bond, times the share
/// of the work window it held, counted from when it took the slot to `work_until`.
pub fn held_cost(bond: u128, since: u64, now: u64, work_until: u64) -> u128 {
    let window = u128::from(work_until.saturating_sub(since).max(1));
    let held = u128::from(now.saturating_sub(since)).min(window);
    idle_part(bond) * held / window
}

/// The reward, less the fee, split by the crew's rule. Each role's basis points go to the masks of that role with a
/// counted step (`paid`), equally; a role with no such mask gives its part to the others in proportion. What rounding
/// leaves goes to the first paid striker. Masks without a counted step get nothing.
pub fn shares(net: u128, members: &[Member], split: &Split, paid: &[bool]) -> Vec<(AccountId, u128)> {
    let count = |r: Role| members.iter().zip(paid).filter(|(m, p)| **p && m.role == r).count() as u128;
    let active: u128 = ROLES.iter().filter(|r| count(**r) > 0).map(|r| u128::from(split.of(*r))).sum();
    let mut out: Vec<(AccountId, u128)> = members.iter().map(|m| (m.mask.clone(), 0)).collect();
    if active == 0 {
        return out;
    }
    for (i, m) in members.iter().enumerate() {
        if paid[i] {
            out[i].1 = net * u128::from(split.of(m.role)) / active / count(m.role);
        }
    }
    let sent: u128 = out.iter().map(|(_, a)| *a).sum();
    if let Some(i) = members.iter().zip(paid).position(|(m, p)| *p && m.role == Role::Striker) {
        out[i].1 += net - sent;
    }
    out
}

/// The seal of a step: sha256 of `maskwars-step:<job>:<mask>:<salt>:<content>`, lowercase hex.
pub fn step_hash(job: &str, mask: &AccountId, salt: &str, content: &str) -> String {
    sha256_hex(format!("{STEP_PREFIX}:{job}:{mask}:{salt}:{content}").as_bytes())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    env::sha256(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn seat_key(id: &str, mask: &AccountId) -> String {
    format!("{id}/{mask}")
}

fn step_key(id: &str, seq: u32) -> String {
    format!("{id}#{seq}")
}

fn cost_of(bytes: u64) -> u128 {
    env::storage_byte_cost().as_yoctonear() * u128::from(bytes)
}

/// A mask that is `<name>.<factory>` with no dot in `name`: only the factory could have created it.
fn direct_sub(mask: &AccountId, factory: &AccountId) -> bool {
    mask.as_str().strip_suffix(factory.as_str()).and_then(|p| p.strip_suffix('.')).is_some_and(|n| !n.contains('.'))
}

fn read_reply() -> Result<String, String> {
    if env::promise_results_count() != 1 {
        return Err("no answer from the judge".into());
    }
    match env::promise_result_checked(0, MAX_REPLY_BYTES) {
        Ok(data) => serde_json::from_slice::<Option<String>>(&data)
            .map_err(|_| "the judge's answer is unreadable".to_string())?
            .ok_or_else(|| "the judge returned nothing".into()),
        Err(PromiseError::TooLong(_)) => Err("the judge's answer is too long".into()),
        Err(_) => Err("the judge's run failed".into()),
    }
}

/// What a judge run says about itself, answer or not.
#[derive(Default, Debug, PartialEq)]
pub struct RunFacts {
    /// When a run can make progress again (ns), if what the judge calls was down.
    pub retry_at: Option<u64>,
    /// The calls the run made to NEAR AI.
    pub asked: u32,
}

/// The run's own facts out of its stdout, whether it decided anything or not: `output.retry_at` and `output.asked`, for
/// this job only. Anything unreadable says nothing.
pub fn run_facts(id: &str, raw: &str) -> RunFacts {
    match serde_json::from_str::<JudgeReply>(raw).ok().and_then(|r| r.output).filter(|o| o.job == id) {
        Some(o) => RunFacts { retry_at: o.retry_at.map(|t| t.0), asked: o.asked },
        None => RunFacts::default(),
    }
}

/// A judge run is asked only once the judge's own back-off is over: before it, a run would call nothing.
fn may_run(job: &Job) {
    require!(
        env::block_timestamp() >= job.retry_at,
        format!("the judge asked to be run again from {}: until then a run would call nothing", job.retry_at)
    );
}

/// The judge's verdict on job `id` out of its stdout.
pub fn parse_reply(id: &str, raw: String) -> Result<JudgeOutput, String> {
    let reply: JudgeReply = serde_json::from_str(&raw).map_err(|_| "the judge's answer is unreadable".to_string())?;
    if !reply.success {
        return Err(format!("the judge could not judge: {}", reply.error.unwrap_or_default()));
    }
    let o = reply.output.ok_or("the judge decided nothing")?;
    if o.job != id {
        return Err(format!("the judge answered for job {}", o.job));
    }
    if o.counted.len() > (MAX_SLOTS as usize) * (MAX_STEPS as usize) {
        return Err("the judge counted more steps than a job holds".into());
    }
    Ok(o)
}

/// 1 to 64 lowercase letters, digits, `-` or `_`.
pub fn id_ok(id: &str) -> bool {
    (1..=MAX_JOB_ID).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// A crew's id on the crews contract: 3 to 32 lowercase letters, digits or `-`.
pub fn crew_id_ok(id: &str) -> bool {
    (3..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn hex64_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A box sealed for a TEE key, as a step's content or a reference work: `mw1.` and 934 base64url characters.
pub fn box_ok(s: &str) -> bool {
    s.strip_prefix(BOX_PREFIX)
        .is_some_and(|b| b.len() == BOX_CHARS && b.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
}

/// An X25519 public key: `x25519:` and 64 lowercase hex digits.
pub fn key_ok(s: &str) -> bool {
    s.strip_prefix(KEY_PREFIX).is_some_and(hex64_ok)
}

pub fn profile_ok(s: &str) -> bool {
    (1..=MAX_PROFILE).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn salt_ok(s: &str) -> bool {
    (16..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Basis points summing to 10000, every member's role paid, no points for a role nobody holds.
pub fn split_ok(split: &Split, members: &[Member]) -> bool {
    let sum: u32 = ROLES.iter().map(|r| u32::from(split.of(*r))).sum();
    sum == u32::from(BPS)
        && ROLES.iter().all(|r| (split.of(*r) > 0) == members.iter().any(|m| m.role == *r))
        && members.iter().any(|m| m.role == Role::Striker)
}

pub fn distinct<T: PartialEq>(list: &[T]) -> bool {
    list.iter().enumerate().all(|(i, a)| !list[..i].contains(a))
}

pub fn list_ok(list: &[AccountId]) -> bool {
    list.len() <= 8 && distinct(list)
}

/// What a work needs to win, as far as the contract can hold the client to it; the judge's check holds it to the rest.
pub fn bar_ok(kind: Kind, bar: &Bar) -> bool {
    match kind {
        Kind::AiReview => {
            bar.win_at <= MAX_REVIEW_WIN_AT
                && bar.cases.is_none()
                && bar.fuel.is_none()
                && bar.reference.as_deref().is_some_and(box_ok)
        }
        Kind::TeeTests => {
            let cases = bar.cases.unwrap_or(0);
            (1..=64).contains(&cases)
                && (1..=cases).contains(&bar.win_at)
                && bar.fuel.is_some_and(|f| f.0 > 0)
                && bar.reference.as_deref().is_some_and(box_ok)
        }
        Kind::Drain => false,
    }
}

/// At most one judge per kind, none for a drain; each a project id, a wasm sha256 and its TEE key.
pub fn judges_ok(judges: &[Judge]) -> bool {
    judges.iter().all(|j| {
        j.kind != Kind::Drain
            && hex64_ok(&j.version)
            && (3..=128).contains(&j.project.len())
            && j.project.contains('/')
            && key_ok(&j.key)
    }) && distinct(&judges.iter().map(|j| j.kind).collect::<Vec<_>>())
}

/// Logs a NEP-297 event: `EVENT_JSON:{"standard":"maskwars_jobs","version":"1.0.0","event":…,"data":…}`.
pub(crate) fn event<T: Serialize>(name: &str, data: &T) {
    #[derive(Serialize)]
    #[serde(crate = "near_sdk::serde")]
    struct Event<'a, T> {
        standard: &'a str,
        version: &'a str,
        event: &'a str,
        data: &'a T,
    }
    let e = Event { standard: "maskwars_jobs", version: "1.0.0", event: name, data };
    env::log_str(&format!("EVENT_JSON:{}", serde_json::to_string(&e).unwrap()));
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Named<'a> {
    id: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Enlisted<'a> {
    id: &'a str,
    entrant: u32,
    crew: Option<&'a str>,
    members: &'a [Member],
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct StepEvent<'a> {
    id: &'a str,
    step: &'a Step,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Left<'a> {
    id: &'a str,
    mask: &'a AccountId,
    /// Of the bond, what went back to whoever locked it, and what holding the slot cost, to the company.
    back: U128,
    lost: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Burned<'a> {
    id: &'a str,
    mask: &'a AccountId,
    amount: U128,
    burned: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Appealed<'a> {
    id: &'a str,
    by: &'a AccountId,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Decided<'a> {
    id: &'a str,
    verdict: &'a Verdict,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Checked<'a> {
    id: &'a str,
    work_until: U64,
    reveal_until: U64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Refused<'a> {
    id: &'a str,
    why: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Payout {
    mask: AccountId,
    amount: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FuelLine {
    mask: AccountId,
    burned: U128,
    covered: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct BondLine {
    mask: AccountId,
    bond: U128,
    /// What of it went to the company; the rest went back to whoever locked it.
    lost: U128,
    /// Why: `fake` (all of it) or `idle` (no counted step of its own: `IDLE_BPS` of it). `null` when none was lost.
    why: Option<Lost>,
}

#[derive(Serialize, Clone, Copy)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
enum Lost {
    Fake,
    Idle,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Settled<'a> {
    id: &'a str,
    status: &'a Status,
    payouts: Vec<Payout>,
    fee: U128,
    fuel: Vec<FuelLine>,
    bonds: Vec<BondLine>,
    /// The bonds lost, all of them to the company: fake masks' whole, half of every seat with no counted step.
    forfeit: U128,
    back: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Bonded<'a> {
    id: &'a str,
    mask: &'a AccountId,
    by: &'a AccountId,
    amount: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Delivered<'a> {
    id: &'a str,
    #[serde(flatten)]
    delivery: &'a Delivery,
}
