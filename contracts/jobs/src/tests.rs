use super::*;
use crate::admin::{Change, CHANGE_DELAY_HOURS, CHANGE_NOTICE_HOURS};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const CONTRACT: &str = "jobs.maskwars.testnet";
const ADMIN: &str = "maskwars.testnet";
const METER: &str = "keeper.maskwars.testnet";
const TREASURY: &str = "treasury.maskwars.testnet";
const OUTLAYER: &str = "outlayer.testnet";
const CREWS: &str = "crews.maskwars.testnet";
const BOUNTY: &str = "bounty.maskwars.testnet";
const FACTORY: &str = "masks.maskwars.testnet";
const COMPANY: &str = "company.maskwars.testnet";
const CLIENT: &str = "dao.testnet";
/// A crew of two: KIRA scouts (a person's mask, forged by the factory), NOVA strikes.
const KIRA: &str = "kira.masks.maskwars.testnet";
const NOVA: &str = "nova.maskwars.testnet";
/// A rival that takes the job alone.
const ONYX: &str = "onyx.maskwars.testnet";
const REVIEW_V: &str = "5048c29063c3c1f3b5ac86e66f8153eb0f28083b671fe33967a29e8512b808b0";
const TESTS_V: &str = "018b7143aa00000000000000000000000000000000000000000000000000c200";
const SPEC: &str = "1111111111111111111111111111111111111111111111111111111111111111";
/// The judges' TEE keys and the client's, as the contract holds them.
const REVIEW_KEY: &str = "x25519:3333333333333333333333333333333333333333333333333333333333333333";
const TESTS_KEY: &str = "x25519:4444444444444444444444444444444444444444444444444444444444444444";
const CLIENT_KEY: &str = "x25519:5555555555555555555555555555555555555555555555555555555555555555";
/// Whoever locks the masks' bonds in these tests: the masks' owner, or the keeper from their tanks.
const BACKER: &str = "owner.testnet";
const RUBRIC: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const ID: &str = "review-0001";
const MIN: u64 = 60_000_000_000;
const HOUR: u64 = NS_PER_HOUR;
const WORK: u32 = 30;
const REVEAL: u32 = 30;
const APPEAL: u32 = 60;
const REWARD: u128 = 3 * ONE;
const FUEL: u128 = 50 * MILLI;
const ONE: u128 = 10u128.pow(24);
const MILLI: u128 = ONE / 1000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// A block a second.
fn ctx(who: &str, deposit: u128, now: u64) -> VMContextBuilder {
    let mut c = VMContextBuilder::new();
    c.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .block_height(now / 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    c
}

fn as_(who: &str, deposit: u128, now: u64) {
    testing_env!(ctx(who, deposit, now).build());
}

/// The message a call panics with.
fn panics<R>(f: impl FnOnce() -> R) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).err().expect("it should have panicked");
    let msg =
        err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap();
    // `env::panic_str` in the mocked chain comes wrapped in the host error.
    match msg.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.rsplit_once("\" }").map_or(rest, |(m, _)| m).to_string(),
        None => msg,
    }
}

/// Every transfer the last call made: `(to, yocto)`.
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions.into_iter().map(move |a| (r.receiver_id.to_string(), a)))
        .filter_map(|(to, a)| match a {
            MockAction::Transfer { deposit, .. } => Some((to, deposit.as_yoctonear())),
            _ => None,
        })
        .collect()
}

/// The last `settle` event the contract logged.
fn settled() -> Value {
    get_logs()
        .iter()
        .rev()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .find(|e| e["event"] == "settle")
        .expect("a settle event")["data"]
        .clone()
}

/// The client got `base` and the storage the job's masks took back: everything the reserve paid for, but what the
/// job keeps for good (its verdict, at most `JOB_GROWTH_BYTES`).
fn client_got(base: u128, reserve_now: u128, slots: u8) {
    let got = paid_to(CLIENT);
    assert!(got >= base, "the client gets at least {base}, got {got}");
    let freed = got - base;
    let charged = reserve_for(slots) - reserve_now;
    assert!(freed > 0 && freed <= charged, "the storage the masks took comes back: freed {freed} of {charged}");
    assert!(charged - freed <= cost_of(JOB_GROWTH_BYTES), "only the verdict stays: {}", charged - freed);
    assert_eq!(yocto_of(&settled()["back"]), got);
}

fn yocto_of(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

fn paid_to(who: &str) -> u128 {
    transfers().iter().filter(|(to, _)| to == who).map(|(_, a)| a).sum()
}

fn arg<T: near_sdk::serde::de::DeserializeOwned>(args: &[Value], i: usize) -> T {
    serde_json::from_value(args[i].clone()).unwrap()
}

fn judges() -> Vec<Judge> {
    vec![
        Judge {
            kind: Kind::AiReview,
            project: "maskwars.testnet/review".into(),
            version: REVIEW_V.into(),
            key: REVIEW_KEY.into(),
        },
        Judge {
            kind: Kind::TeeTests,
            project: "maskwars.testnet/tests".into(),
            version: TESTS_V.into(),
            key: TESTS_KEY.into(),
        },
    ]
}

/// A fresh contract on fresh storage.
fn contract() -> Jobs {
    as_(ADMIN, 0, 0);
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    as_(ADMIN, 0, 0);
    Jobs::new(
        acc(ADMIN),
        acc(METER),
        acc(TREASURY),
        acc(OUTLAYER),
        acc(CREWS),
        judges(),
        vec![acc(BOUNTY)],
        vec![acc(FACTORY)],
        500,
        acc(COMPANY),
    )
}

/// What opening a job of `slots` takes, with room for the record.
fn price(c: &Jobs, slots: u8) -> u128 {
    c.quote(U128(REWARD), U128(FUEL), slots).total.0
}

/// Judge runs a job has left once the judge checked the client's material.
const RUNS_LEFT: u128 = JUDGE_RUNS - 1;

/// A client's own reference work sealed for the judge: what a bar carries.
fn reference() -> String {
    format!("mw1.{}", "A".repeat(934))
}

/// A box sealed for the judge, as a mask reveals it on a `tee_tests` or `ai_review` job: the contract sees only its
/// form. The same text makes the same box here, so a copy is still a copy.
fn boxed(text: &str) -> String {
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let seed = env::sha256(text.as_bytes());
    let body: String = (0..BOX_CHARS).map(|i| B64[(seed[i % 32] as usize + i) % 64] as char).collect();
    format!("{BOX_PREFIX}{body}")
}

/// What a mask reveals for `text` on job `id`: the text itself on a drain, its box on any other.
fn content_of(c: &Jobs, id: &str, text: &str) -> String {
    match c.get(id.into()).map(|v| v.terms.kind) {
        Some(Kind::Drain) | None => text.to_string(),
        Some(_) => boxed(text),
    }
}

/// Locks the job's bond for `mask` as BACKER, unless one waits for it already; the calling context stays as it was.
fn back(c: &mut Jobs, id: &str, mask: &str) {
    if c.bond_of(id.into(), acc(mask)).is_some() {
        return;
    }
    let (who, now) = (env::predecessor_account_id(), env::block_timestamp());
    let amount = c.get(id.into()).map_or(FUEL, |v| v.terms.bond.0);
    as_(BACKER, amount + cost_of(BOND_RECORD_BYTES), now);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.bond(id.into(), acc(mask))));
    as_(who.as_str(), 0, now);
}

/// The calling mask enlists alone, its bond locked for it first.
fn enlist_now(c: &mut Jobs, id: String) -> u32 {
    let mask = env::predecessor_account_id();
    back(c, &id, mask.as_str());
    c.enlist(id)
}

/// The crews contract enlists a crew, every member's bond locked first.
fn enlist_crew_now(c: &mut Jobs, id: String, ticket: CrewTicket) -> u32 {
    for m in &ticket.members {
        back(c, &id, m.mask.as_str());
    }
    c.enlist_crew(id, ticket)
}

fn key_of(kind: Kind) -> Option<String> {
    (kind != Kind::Drain).then(|| CLIENT_KEY.to_string())
}

fn bar_of(kind: Kind) -> Option<Bar> {
    match kind {
        Kind::AiReview => Some(Bar { win_at: 60, cases: None, fuel: None, reference: Some(reference()) }),
        Kind::TeeTests => {
            Some(Bar { win_at: 10, cases: Some(12), fuel: Some(U64(20_000)), reference: Some(reference()) })
        }
        Kind::Drain => None,
    }
}

fn check_reply(id: &str, passed: bool) -> String {
    let why = if passed { Value::Null } else { json!("the rubric is not maskwars-rubric/v1") };
    json!({ "success": true, "output": { "job": id, "checked": passed, "why": why }, "error": null }).to_string()
}

/// Anyone asks the judge to check the client's material, and the judge passes it at `at`.
fn pass_check(c: &mut Jobs, id: &str, at: u64) -> JobView {
    as_("anyone.testnet", 0, at);
    let _ = c.check(id.into());
    let v = answered(c, id, false, stdout(&check_reply(id, true)), at);
    assert!(v.checked && v.status == Status::Open, "{:?} {:?}", v.status, get_logs());
    v
}

/// Opens a job; a `tee_tests` or `ai_review` one has its material checked at once, so its windows start at `at`.
fn open_with(c: &mut Jobs, id: &str, kind: Kind, slots: u8, open_to: OpenTo, at: u64) -> JobView {
    let v = open_unchecked(c, id, kind, slots, open_to, at);
    if kind == Kind::Drain {
        return v;
    }
    pass_check(c, id, at)
}

fn open_unchecked(c: &mut Jobs, id: &str, kind: Kind, slots: u8, open_to: OpenTo, at: u64) -> JobView {
    as_(CLIENT, price(c, slots), at);
    let (version, rubric, round) = match kind {
        Kind::AiReview => (Some(REVIEW_V.to_string()), Some(RUBRIC.to_string()), None),
        Kind::TeeTests => (Some(TESTS_V.to_string()), Some(RUBRIC.to_string()), None),
        Kind::Drain => (None, None, Some(RoundRef { bounty: acc(BOUNTY), id: "live-0007".into() })),
    };
    let secrets = (kind == Kind::TeeTests).then(|| SecretsRef { profile: "bench".into(), account_id: acc(CLIENT) });
    c.open(
        id.into(),
        kind,
        "Review the treasury proposal against the rubric".into(),
        SPEC.into(),
        rubric,
        version,
        round,
        secrets,
        bar_of(kind),
        U128(REWARD),
        U128(FUEL),
        slots,
        open_to,
        WORK,
        REVEAL,
        APPEAL,
        None,
        key_of(kind),
    )
}

fn opened() -> Jobs {
    let mut c = contract();
    open_with(&mut c, ID, Kind::AiReview, 4, OpenTo::Anyone, 0);
    c
}

fn duo() -> CrewTicket {
    CrewTicket {
        crew: "duo".into(),
        version: 1,
        members: vec![Member { mask: acc(KIRA), role: Role::Scout }, Member { mask: acc(NOVA), role: Role::Striker }],
        split: Split { scout: 3000, striker: 7000, verifier: 0 },
    }
}

fn salt_of(mask: &str) -> String {
    format!("salt-{}", mask.replace('.', "-"))
}

/// The mask seals a step for `text`: its box on a `tee_tests` or `ai_review` job.
fn seal(c: &mut Jobs, id: &str, mask: &str, text: &str, at: u64) -> u32 {
    let content = content_of(c, id, text);
    as_(mask, 0, at);
    c.step(id.into(), step_hash(id, &acc(mask), &salt_of(mask), &content)).seq
}

fn open_up(c: &mut Jobs, id: &str, mask: &str, seq: u32, text: &str, at: u64) -> Step {
    let content = content_of(c, id, text);
    as_(mask, 0, at);
    c.reveal(id.into(), seq, salt_of(mask), content)
}

/// The crew and ONYX on the job, each with a step; the meter books their minds' fuel; every step revealed.
fn worked() -> Jobs {
    let mut c = opened();
    as_(CREWS, 0, MIN);
    assert_eq!(enlist_crew_now(&mut c, ID.into(), duo()), 0);
    as_(ONYX, 0, 2 * MIN);
    assert_eq!(enlist_now(&mut c, ID.into()), 1);
    assert_eq!(seal(&mut c, ID, KIRA, "finding: quorum math in section 4", 3 * MIN), 0);
    assert_eq!(seal(&mut c, ID, NOVA, "review: ipfs://bafy-nova sha256:aa", 4 * MIN), 1);
    assert_eq!(seal(&mut c, ID, ONYX, "review: ipfs://bafy-onyx sha256:bb", 5 * MIN), 2);
    as_(METER, 0, 6 * MIN);
    c.burn(ID.into(), acc(KIRA), U128(30 * MILLI));
    c.burn(ID.into(), acc(NOVA), U128(40 * MILLI));
    c.burn(ID.into(), acc(ONYX), U128(50 * MILLI));
    let after = u64::from(WORK) * MIN;
    open_up(&mut c, ID, KIRA, 0, "finding: quorum math in section 4", after);
    open_up(&mut c, ID, NOVA, 1, "review: ipfs://bafy-nova sha256:aa", after + MIN);
    open_up(&mut c, ID, ONYX, 2, "review: ipfs://bafy-onyx sha256:bb", after + 2 * MIN);
    c
}

fn judge_at() -> u64 {
    u64::from(WORK + REVEAL) * MIN
}

fn reply(winner: Option<u32>, counted: &[u32]) -> String {
    json!({ "success": true, "output": { "job": ID, "winner": winner, "counted": counted }, "error": null }).to_string()
}

/// The run the job waits for, or the last one asked.
fn run_of(c: &Jobs, id: &str) -> u32 {
    let v = c.get(id.into()).unwrap();
    match v.status {
        Status::Judging { run, .. } => run,
        _ => v.runs,
    }
}

/// OutLayer hands the callback of the run the job waits for the judge's stdout as a JSON string, or a failed promise.
/// `appeal` only says what the caller expects: the job knows whether its run is an appeal.
fn answered(c: &mut Jobs, id: &str, appeal: bool, result: PromiseResult, at: u64) -> JobView {
    let run = run_of(c, id);
    answered_run(c, id, appeal, run, result, at)
}

fn answered_run(c: &mut Jobs, id: &str, appeal: bool, run: u32, result: PromiseResult, at: u64) -> JobView {
    if let Some(Status::Judging { .. }) = c.get(id.into()).map(|v| v.status) {
        assert_eq!(
            c.get(id.into()).unwrap().appeal.is_some(),
            appeal,
            "the run is {}an appeal",
            if appeal { "not " } else { "" }
        );
    }
    testing_env!(
        ctx(CONTRACT, 0, at).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    c.on_judged(id.into(), run)
}

fn stdout(s: &str) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&Some(s.to_string())).unwrap())
}

fn judged(winner: Option<u32>, counted: &[u32]) -> Jobs {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let v = answered(&mut c, ID, false, stdout(&reply(winner, counted)), judge_at() + MIN);
    assert_eq!(v.status, Status::Decided, "{:?}", get_logs());
    c
}

fn settle_at() -> u64 {
    judge_at() + MIN + u64::from(APPEAL) * MIN
}

// ---------------------------------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_job_takes_the_reward_the_fuel_of_every_slot_the_judge_runs_and_its_storage() {
    let mut c = contract();
    let q = c.quote(U128(REWARD), U128(FUEL), 4);
    assert_eq!(q.fuel.0, 4 * FUEL);
    assert_eq!(q.judge.0, JUDGE_RUNS * JUDGE_FEE.as_yoctonear());
    assert_eq!(q.reserve.0, cost_of(4 * (MASK_STORAGE_BYTES + LEFT_SEAT_BYTES) + JOB_GROWTH_BYTES));
    let before = env::storage_usage();
    as_(CLIENT, q.total.0 + ONE, 0);
    let v = c.open(
        ID.into(),
        Kind::AiReview,
        "Review the proposal".into(),
        SPEC.into(),
        Some(RUBRIC.into()),
        Some(REVIEW_V.into()),
        None,
        None,
        bar_of(Kind::AiReview),
        U128(REWARD),
        U128(FUEL),
        4,
        OpenTo::Anyone,
        WORK,
        REVEAL,
        APPEAL,
        None,
        Some(CLIENT_KEY.into()),
    );
    let record = cost_of(env::storage_usage() - before);
    assert!(record <= q.record.0, "the quote covers the record: {record} > {}", q.record.0);
    // Everything over what the job takes comes back at once.
    let total = REWARD + 4 * FUEL + q.judge.0 + q.reserve.0 + record;
    assert_eq!(transfers(), vec![(CLIENT.to_string(), q.total.0 + ONE - total)]);
    assert_eq!(v.terms.judge.unwrap().version, REVIEW_V);
    assert_eq!(v.terms.fee_bps, 500);
    assert_eq!(v.terms.work_until.0, u64::from(WORK) * MIN);
    assert_eq!(v.terms.reveal_until.0, u64::from(WORK + REVEAL) * MIN);
    assert_eq!(v.terms.judge_until.0, u64::from(WORK + REVEAL) * MIN + JUDGE_GRACE_HOURS * HOUR);
    assert_eq!((v.phase.as_str(), v.checked, v.terms.bar.clone()), ("checking", false, bar_of(Kind::AiReview)));
    assert_eq!(c.config().live, 1);
}

#[test]
fn a_job_opens_only_on_terms_anyone_can_hold_it_to() {
    let mut c = contract();
    let q = price(&c, 4);
    let open = |c: &mut Jobs, f: &dyn Fn(&mut Vec<Value>)| {
        let mut args = vec![
            json!("job-x"),
            json!("ai_review"),
            json!("Review it"),
            json!(SPEC),
            json!(RUBRIC),
            json!(REVIEW_V),
            Value::Null,
            json!(REWARD.to_string()),
            json!(FUEL.to_string()),
            json!(4),
            json!({ "who": "anyone" }),
            json!({ "win_at": 60, "reference": reference() }),
            Value::Null,
            json!(CLIENT_KEY),
            Value::Null,
        ];
        f(&mut args);
        as_(CLIENT, q, 0);
        panics(|| {
            c.open(
                arg(&args, 0),
                arg(&args, 1),
                arg(&args, 2),
                arg(&args, 3),
                arg(&args, 4),
                arg(&args, 5),
                arg(&args, 6),
                arg(&args, 12),
                arg(&args, 11),
                arg(&args, 7),
                arg(&args, 8),
                arg(&args, 9),
                arg(&args, 10),
                WORK,
                REVEAL,
                APPEAL,
                arg(&args, 14),
                arg(&args, 13),
            )
        })
    };
    type Edit = Box<dyn Fn(&mut Vec<Value>)>;
    let cases: Vec<(&str, Edit)> = vec![
        ("judge_version: the judge you agree to", Box::new(|a| a[5] = json!(TESTS_V))),
        ("judge_version: the judge you agree to", Box::new(|a| a[5] = Value::Null)),
        ("publish the rubric or test set first", Box::new(|a| a[4] = Value::Null)),
        ("rubric: the sha256", Box::new(|a| a[4] = json!("not-a-hash"))),
        ("spec: the sha256", Box::new(|a| a[3] = json!("abc"))),
        ("fuel for all the slots is at most the reward", Box::new(|a| a[8] = json!((800 * MILLI).to_string()))),
        ("fuel_per_mask: 0.01 to 1 NEAR", Box::new(|a| a[8] = json!((5 * MILLI).to_string()))),
        ("the reward is at least 0.1 NEAR", Box::new(|a| a[7] = json!((50 * MILLI).to_string()))),
        ("slots: 1 to 16 masks", Box::new(|a| a[9] = json!(17))),
        ("slots: 1 to 16 masks", Box::new(|a| a[9] = json!(0))),
        ("id: 1 to 64", Box::new(|a| a[0] = json!("Job X"))),
        ("only a drain follows a round", Box::new(|a| a[6] = json!({ "bounty": BOUNTY, "id": "live-1" }))),
        ("a drain job names the round it follows", Box::new(|a| a[1] = json!("drain"))),
        (
            "the client is not one of its own job's masks",
            Box::new(|a| a[10] = json!({ "who": "masks", "masks": [CLIENT] })),
        ),
        // The bar is on chain before anyone starts: a review sets its floor, a test set its shape and a solution.
        ("set the bar a work must clear", Box::new(|a| a[11] = Value::Null)),
        ("bar: win_at 0 to 80 points", Box::new(|a| a[11] = json!({ "win_at": 81, "reference": reference() }))),
        (
            "bar: win_at 0 to 80 points",
            Box::new(|a| a[11] = json!({ "win_at": 60, "cases": 3, "reference": reference() })),
        ),
        // The client's own reference review is on chain, sealed for the judge: the check has the model score it.
        ("bar: win_at 0 to 80 points", Box::new(|a| a[11] = json!({ "win_at": 60 }))),
        (
            "bar: win_at 0 to 80 points",
            Box::new(|a| a[11] = json!({ "win_at": 60, "reference": "review: in the open" })),
        ),
        // The winning work is sealed for the client's own key, and nobody else's.
        ("client_key: the client's X25519 key", Box::new(|a| a[13] = Value::Null)),
        ("client_key: the client's X25519 key", Box::new(|a| a[13] = json!("x25519:abc"))),
        // A mask locks at least what a slot's mind may burn, and never more than the job pays.
        ("bond: from fuel_per_mask up to the reward", Box::new(|a| a[14] = json!((FUEL - 1).to_string()))),
        ("bond: from fuel_per_mask up to the reward", Box::new(|a| a[14] = json!((REWARD + 1).to_string()))),
        (
            "tee_tests name the client's secrets",
            Box::new(|a| {
                a[1] = json!("tee_tests");
                a[5] = json!(TESTS_V);
            }),
        ),
        (
            "bar: 1 to 64 cases, win_at 1 to cases",
            Box::new(|a| {
                a[1] = json!("tee_tests");
                a[5] = json!(TESTS_V);
                a[12] = json!({ "profile": "bench", "account_id": CLIENT });
                a[11] = json!({ "win_at": 13, "cases": 12, "fuel": "20000", "reference": reference() });
            }),
        ),
        (
            "bar: 1 to 64 cases, win_at 1 to cases",
            Box::new(|a| {
                a[1] = json!("tee_tests");
                a[5] = json!(TESTS_V);
                a[12] = json!({ "profile": "bench", "account_id": CLIENT });
                a[11] = json!({ "win_at": 10, "cases": 12, "fuel": "20000" });
            }),
        ),
    ];
    for (want, f) in cases {
        let got = open(&mut c, &*f);
        assert!(got.contains(want), "want {want:?}, got {got:?}");
    }
    // A drain follows a round of a bounty contract this contract knows, and names no judge.
    as_(CLIENT, q, 0);
    let unknown = RoundRef { bounty: acc("fake-bounty.testnet"), id: "live-1".into() };
    let got = panics(|| {
        c.open(
            "job-d".into(),
            Kind::Drain,
            "Drain it".into(),
            SPEC.into(),
            None,
            None,
            Some(unknown),
            None,
            None,
            U128(REWARD),
            U128(FUEL),
            4,
            OpenTo::Anyone,
            WORK,
            REVEAL,
            APPEAL,
            None,
            None,
        )
    });
    assert!(got.contains("a bounty contract this contract follows"), "{got}");
    // Too little NEAR.
    as_(CLIENT, q / 2, 0);
    let got = panics(|| {
        c.open(
            "job-y".into(),
            Kind::AiReview,
            "Review it".into(),
            SPEC.into(),
            Some(RUBRIC.into()),
            Some(REVIEW_V.into()),
            None,
            None,
            bar_of(Kind::AiReview),
            U128(REWARD),
            U128(FUEL),
            4,
            OpenTo::Anyone,
            WORK,
            REVEAL,
            APPEAL,
            None,
            Some(CLIENT_KEY.into()),
        )
    });
    assert!(got.contains("see quote"), "{got}");
}

/// The client's material is checked before any mask starts: until the judge passes the rubric and the spec (or the
/// test set and the client's own solution), no mask enlists, and the work window starts only when it passes.
#[test]
fn the_judge_checks_the_client_s_material_before_any_mask_starts() {
    let mut c = contract();
    let v = open_unchecked(&mut c, ID, Kind::AiReview, 4, OpenTo::Anyone, 0);
    assert_eq!((v.phase.as_str(), v.checked), ("checking", false));
    as_(ONYX, 0, MIN);
    assert_eq!(
        panics(|| enlist_now(&mut c, ID.into())),
        "the judge has not passed the client's material yet: no mask starts before it"
    );
    // The judge is asked in check mode, with the job's pinned version, paid from the job's runs.
    as_("anyone.testnet", 0, 10 * MIN);
    let _ = c.check(ID.into());
    let args = get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { args, .. } => serde_json::from_slice::<Value>(&args).ok(),
            _ => None,
        })
        .unwrap();
    let input: Value = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input["check"], true);
    assert_eq!(args["source"]["Project"]["version_key"], REVIEW_V);
    assert_eq!(c.get(ID.into()).unwrap().judge_budget.0, JUDGE_FEE.as_yoctonear() * RUNS_LEFT);
    assert_eq!(panics(|| c.check(ID.into())), "the job is not waiting for its material to be checked");
    // A verdict where a check is due is no check: the job still waits for one.
    let v = answered(&mut c, ID, false, stdout(&reply(None, &[])), 11 * MIN);
    assert_eq!((v.status, v.checked), (Status::Open, false));
    // The judge passes it at 12 minutes: the windows start then.
    as_("anyone.testnet", 0, 12 * MIN);
    let _ = c.check(ID.into());
    let v = answered(&mut c, ID, false, stdout(&check_reply(ID, true)), 12 * MIN);
    assert_eq!((v.phase.as_str(), v.checked), ("enlisting", true));
    assert_eq!(v.terms.work_until.0, 12 * MIN + u64::from(WORK) * MIN);
    assert_eq!(v.terms.reveal_until.0, 12 * MIN + u64::from(WORK + REVEAL) * MIN);
    assert_eq!(v.terms.judge_until.0, 12 * MIN + u64::from(WORK + REVEAL) * MIN + JUDGE_GRACE_HOURS * HOUR);
    as_(ONYX, 0, 13 * MIN);
    assert_eq!(enlist_now(&mut c, ID.into()), 0);
    as_("anyone.testnet", 0, 13 * MIN);
    assert_eq!(panics(|| c.check(ID.into())), "the job is not waiting for its material to be checked");
}

/// The client's material is not what the job holds, or cannot be judged by: the judge refuses it before anyone
/// starts, and everything goes back to the client.
#[test]
fn material_the_judge_refuses_sends_everything_back_before_anyone_starts() {
    let mut c = contract();
    open_unchecked(&mut c, ID, Kind::AiReview, 4, OpenTo::Anyone, 0);
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    as_("anyone.testnet", 0, MIN);
    let _ = c.check(ID.into());
    let v = answered(&mut c, ID, false, stdout(&check_reply(ID, false)), MIN);
    assert_eq!((v.status, v.phase.as_str()), (Status::Cancelled, "cancelled"));
    // Everything back, and the bytes the record shed with its judge run.
    let back = paid_to(CLIENT) - (REWARD + 4 * FUEL + JUDGE_FEE.as_yoctonear() * RUNS_LEFT + reserve);
    assert!(back <= cost_of(16), "{back}");
    assert!(
        get_logs().iter().any(|l| l.contains("\"refuse\"") && l.contains("maskwars-rubric/v1")),
        "{:?}",
        get_logs()
    );
    assert_eq!(c.config().live, 0);
}

/// A check that never passes: the judge may retry within `CHECK_HOURS` of the opening, a late pass is not taken, and
/// then anyone closes the job with everything back to the client.
#[test]
fn a_job_the_judge_never_passes_closes_with_everything_back() {
    let mut c = contract();
    open_unchecked(&mut c, ID, Kind::TeeTests, 2, OpenTo::Anyone, 0);
    as_("anyone.testnet", 0, MIN);
    let _ = c.check(ID.into());
    // The judge could not read the client's test set: nothing decided, the job waits for its check.
    let failed = json!({ "success": false, "error": "the RPC sources disagree" }).to_string();
    assert_eq!(answered(&mut c, ID, false, stdout(&failed), MIN).status, Status::Open);
    as_("anyone.testnet", 0, 2 * MIN);
    assert_eq!(panics(|| c.close(ID.into())), "the judge may still check the client's material");
    // A pass that arrives after the time to check is not taken.
    as_("anyone.testnet", 0, CHECK_HOURS * HOUR - 1);
    let _ = c.check(ID.into());
    let v = answered(&mut c, ID, false, stdout(&check_reply(ID, true)), CHECK_HOURS * HOUR);
    assert_eq!((v.status, v.checked), (Status::Open, false));
    as_("anyone.testnet", 0, CHECK_HOURS * HOUR);
    assert_eq!(panics(|| c.check(ID.into())), "the time to check is over: close the job");
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    assert_eq!(c.close(ID.into()).status, Status::Closed);
    assert_eq!(paid_to(CLIENT), REWARD + 2 * FUEL + JUDGE_FEE.as_yoctonear() * (JUDGE_RUNS - 2) + reserve);
}

#[test]
fn the_client_takes_a_job_back_only_while_no_mask_sealed_a_step() {
    let mut c = opened();
    as_(ONYX, 0, MIN);
    assert_eq!(panics(|| c.cancel(ID.into())), "only the client cancels its job");
    as_(CLIENT, 0, MIN);
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    let v = c.cancel(ID.into());
    assert_eq!(v.status, Status::Cancelled);
    assert_eq!(paid_to(CLIENT), REWARD + 4 * FUEL + JUDGE_FEE.as_yoctonear() * RUNS_LEFT + reserve);
    assert_eq!(c.config().live, 0);

    // A mask enlisted and its mind worked, but it sealed nothing: the client still takes the job back, pays the fuel
    // the meter booked, and the mask is free again.
    let mut c = opened();
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    as_(METER, 0, MIN);
    c.burn(ID.into(), acc(ONYX), U128(20 * MILLI));
    as_(CLIENT, 0, 2 * MIN);
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    assert_eq!(c.cancel(ID.into()).status, Status::Cancelled);
    assert_eq!(paid_to(TREASURY), 20 * MILLI);
    client_got(REWARD + 4 * FUEL - 20 * MILLI + JUDGE_FEE.as_yoctonear() * RUNS_LEFT + reserve, reserve, 4);
    assert!(c.entrants(ID.into()).is_empty() && !c.live_of.contains_key(&acc(ONYX)));

    // Once a mask has sealed a step, the job runs to its end.
    let mut c = opened();
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    seal(&mut c, ID, ONYX, "work", 2 * MIN);
    as_(CLIENT, 0, 3 * MIN);
    assert_eq!(panics(|| c.cancel(ID.into())), "a mask has sealed a step: the job runs to its end");
}

// ---------------------------------------------------------------------------------------------------------------
// Masks and crews
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn only_the_crews_contract_hands_over_a_crew_and_only_a_whole_one() {
    let mut c = opened();
    as_(NOVA, 0, MIN);
    assert_eq!(panics(|| enlist_crew_now(&mut c, ID.into(), duo())), "only the crews contract enlists a crew");
    as_(CREWS, 0, MIN);
    let mut lone = duo();
    lone.members.truncate(1);
    assert!(panics(|| enlist_crew_now(&mut c, ID.into(), lone)).contains("a crew is 2 to 8 masks"));
    let mut twice = duo();
    twice.members[0].mask = acc(NOVA);
    assert!(panics(|| enlist_crew_now(&mut c, ID.into(), twice)).contains("no repeats"));
    let mut greedy = duo();
    greedy.split = Split { scout: 3000, striker: 6000, verifier: 1000 };
    assert!(panics(|| enlist_crew_now(&mut c, ID.into(), greedy)).contains("none for an empty role"));
    let mut short = duo();
    short.split = Split { scout: 3000, striker: 6000, verifier: 0 };
    assert!(panics(|| enlist_crew_now(&mut c, ID.into(), short)).contains("summing to 10000"));
    assert_eq!(enlist_crew_now(&mut c, ID.into(), duo()), 0);
    let e = c.entrants(ID.into());
    assert_eq!(e[0].crew.as_deref(), Some("duo"));
    assert_eq!(e[0].split, duo().split);
}

#[test]
fn a_mask_is_on_a_job_once_and_the_slots_hold() {
    let mut c = contract();
    open_with(&mut c, ID, Kind::AiReview, 3, OpenTo::Anyone, 0);
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    as_(NOVA, 0, MIN);
    assert_eq!(panics(|| enlist_now(&mut c, ID.into())), "a mask is on a job once");
    as_(CLIENT, 0, MIN);
    assert_eq!(panics(|| enlist_now(&mut c, ID.into())), "the client is not one of its own job's masks");
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    as_("jinx.maskwars.testnet", 0, MIN);
    assert_eq!(panics(|| enlist_now(&mut c, ID.into())), "the job has no slot left for this many masks");
    as_("jinx.maskwars.testnet", 0, u64::from(WORK) * MIN);
    assert!(panics(|| enlist_now(&mut c, ID.into())).contains("the work window is over"));
}

#[test]
fn a_job_for_registered_masks_takes_only_what_a_factory_forged() {
    let mut c = contract();
    open_with(&mut c, ID, Kind::AiReview, 4, OpenTo::Registered { factories: vec![] }, 0);
    // `open` filled in the contract's factories.
    let OpenTo::Registered { factories } = c.get(ID.into()).unwrap().terms.open_to else { panic!() };
    assert_eq!(factories, vec![acc(FACTORY)]);
    for outsider in [NOVA, "kira.evil.masks.maskwars.testnet", "masks.maskwars.testnet", "xmasks.maskwars.testnet"] {
        as_(outsider, 0, MIN);
        assert_eq!(
            panics(|| enlist_now(&mut c, ID.into())),
            "this job takes only masks forged by a known factory",
            "{outsider}"
        );
    }
    as_(KIRA, 0, MIN);
    assert_eq!(enlist_now(&mut c, ID.into()), 0);

    let mut c = contract();
    open_with(&mut c, ID, Kind::AiReview, 4, OpenTo::Masks { masks: vec![acc(NOVA)] }, 0);
    as_(ONYX, 0, MIN);
    assert_eq!(panics(|| enlist_now(&mut c, ID.into())), "this job takes only its listed masks");
    as_(NOVA, 0, MIN);
    assert_eq!(enlist_now(&mut c, ID.into()), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Steps: nobody records, reveals or copies another mask's contribution
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn a_step_is_sealed_in_the_work_window_by_a_mask_on_the_job_four_at_most() {
    let mut c = opened();
    as_(ONYX, 0, MIN);
    let h = step_hash(ID, &acc(ONYX), &salt_of(ONYX), "x");
    assert_eq!(panics(|| c.step(ID.into(), h.clone())), "this mask is not on the job");
    enlist_now(&mut c, ID.into());
    assert_eq!(panics(|| c.step(ID.into(), "ab".into())), "hash: sha256 in lowercase hex");
    for i in 0..MAX_STEPS {
        seal(&mut c, ID, ONYX, &format!("step {i}"), MIN + u64::from(i));
    }
    as_(ONYX, 0, 2 * MIN);
    assert_eq!(panics(|| c.step(ID.into(), h.clone())), "a mask records at most 4 steps on a job");
    let s = c.steps(ID.into(), None, None);
    assert_eq!(s.len(), 4);
    assert!(s.iter().all(|s| s.content.is_none() && s.role == Role::Striker && s.mask == acc(ONYX)));

    let mut c = opened();
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    as_(ONYX, 0, u64::from(WORK) * MIN);
    assert_eq!(panics(|| c.step(ID.into(), h)), "the work window is over");
}

#[test]
fn a_step_takes_the_role_its_mask_holds_in_the_crew() {
    let mut c = opened();
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    seal(&mut c, ID, KIRA, "finding", 2 * MIN);
    seal(&mut c, ID, NOVA, "strike", 3 * MIN);
    let s = c.steps(ID.into(), None, None);
    assert_eq!((s[0].role, s[0].entrant), (Role::Scout, 0));
    assert_eq!((s[1].role, s[1].entrant), (Role::Striker, 0));
}

#[test]
fn a_mask_cannot_claim_another_mask_s_contribution() {
    let mut c = opened();
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    let kira_work = "finding: the quorum check divides before it multiplies";
    let k = seal(&mut c, ID, KIRA, kira_work, 2 * MIN);
    // ONYX copies KIRA's seal into its own step: the hash holds KIRA's name.
    as_(ONYX, 0, 3 * MIN);
    let copied = c.step(ID.into(), c.steps(ID.into(), None, None)[k as usize].hash.clone()).seq;
    let after = u64::from(WORK) * MIN;
    // Revealing before the work window ends shows nothing to anyone.
    as_(KIRA, 0, after - 1);
    assert_eq!(
        panics(|| c.reveal(ID.into(), k, salt_of(KIRA), boxed(kira_work))),
        "steps are revealed once the work window is over"
    );
    open_up(&mut c, ID, KIRA, k, kira_work, after);
    // ONYX saw KIRA's box: it still cannot reveal it as its own seal, under its name or KIRA's salt.
    as_(ONYX, 0, after + MIN);
    assert_eq!(
        panics(|| c.reveal(ID.into(), copied, salt_of(ONYX), boxed(kira_work))),
        "this content and salt are not what was sealed"
    );
    assert_eq!(
        panics(|| c.reveal(ID.into(), copied, salt_of(KIRA), boxed(kira_work))),
        "this content and salt are not what was sealed"
    );
    // Nor reveal KIRA's step itself.
    assert_eq!(
        panics(|| c.reveal(ID.into(), k, salt_of(KIRA), boxed(kira_work))),
        "only the mask that sealed a step reveals it"
    );
    // And it cannot seal anything new once it has seen it.
    assert_eq!(panics(|| c.step(ID.into(), "a".repeat(64))), "the work window is over");
}

#[test]
fn the_same_content_counts_once_for_the_step_sealed_first_whoever_reveals_first() {
    let mut c = opened();
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    let work = "review: ipfs://bafy-shared sha256:cc";
    // NOVA seals first; ONYX, who got the same text off chain, seals it later and reveals first.
    let first = seal(&mut c, ID, NOVA, work, 2 * MIN);
    let later = seal(&mut c, ID, ONYX, work, 3 * MIN);
    let after = u64::from(WORK) * MIN;
    let s = open_up(&mut c, ID, ONYX, later, work, after);
    assert_eq!(s.copy_of, None, "nobody else has shown it yet");
    let s = open_up(&mut c, ID, NOVA, first, work, after + MIN);
    assert_eq!(s.copy_of, None);
    let s = &c.steps(ID.into(), None, None)[later as usize];
    assert_eq!(s.copy_of, Some(first), "the later seal is the copy");
    assert!(!s.eligible());
    // A third mask revealing it after both is a copy of the first seal too.
    let mut c2 = opened();
    as_(ONYX, 0, MIN);
    enlist_now(&mut c2, ID.into());
    as_(NOVA, 0, MIN);
    enlist_now(&mut c2, ID.into());
    let a = seal(&mut c2, ID, ONYX, work, 2 * MIN);
    let b = seal(&mut c2, ID, NOVA, work, 3 * MIN);
    open_up(&mut c2, ID, ONYX, a, work, after);
    assert_eq!(open_up(&mut c2, ID, NOVA, b, work, after + MIN).copy_of, Some(a));
}

#[test]
fn reveals_end_with_the_reveal_window() {
    let mut c = opened();
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    let s = seal(&mut c, ID, ONYX, "work", 2 * MIN);
    as_(ONYX, 0, judge_at());
    assert_eq!(panics(|| c.reveal(ID.into(), s, salt_of(ONYX), boxed("work"))), "the reveal window is over");
    as_(ONYX, 0, judge_at() - 1);
    assert_eq!(
        panics(|| c.reveal(ID.into(), s, "short".into(), boxed("work"))),
        "salt: 16 to 128 letters, digits, - or _"
    );
    assert_eq!(
        panics(|| c.reveal(ID.into(), s, salt_of(ONYX), format!("{}A", boxed("work")))),
        "content: a box sealed for the judge's key, mw1.…: no work is revealed in the open"
    );
    open_up(&mut c, ID, ONYX, s, "work", judge_at() - 1);
    as_(ONYX, 0, judge_at() - 1);
    assert_eq!(panics(|| c.reveal(ID.into(), s, salt_of(ONYX), "work".into())), "this step is already revealed");
}

// ---------------------------------------------------------------------------------------------------------------
// Fuel
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn only_the_job_s_meter_books_fuel_within_each_mask_s_cap_and_the_window() {
    let mut c = opened();
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    // The mask itself books nothing for its own mind, nor anyone else.
    for who in [ONYX, CLIENT, ADMIN, TREASURY] {
        as_(who, 0, 2 * MIN);
        assert_eq!(panics(|| c.burn(ID.into(), acc(ONYX), U128(MILLI))), "only the job's meter books fuel", "{who}");
    }
    as_(METER, 0, 2 * MIN);
    assert_eq!(panics(|| c.burn(ID.into(), acc(NOVA), U128(MILLI))), "this mask is not on the job");
    assert_eq!(c.burn(ID.into(), acc(ONYX), U128(FUEL - 1)).0, FUEL - 1);
    assert_eq!(panics(|| c.burn(ID.into(), acc(ONYX), U128(2))), "a mask burns at most fuel_per_mask on a job");
    assert_eq!(c.burn(ID.into(), acc(ONYX), U128(1)).0, FUEL);
    as_(METER, 0, judge_at());
    assert_eq!(panics(|| c.burn(ID.into(), acc(ONYX), U128(1))), "the job takes no more fuel");
    // Nothing moved: the verdict decides what the job pays.
    assert!(transfers().is_empty());
    let f = c.fuel(ID.into());
    assert_eq!((f[0].burned.0, f[0].covered), (FUEL, None));
}

/// The attack: a mask takes a slot, its mind burns its whole cap, and it never shows any work. The job pays nothing
/// for it; the fuel goes back to the client, and the keeper charges the mask's own tank.
#[test]
fn fuel_burned_without_a_real_attempt_is_not_the_client_s_to_pay() {
    let mut c = worked();
    // A farmer: enlisted, burned everything, sealed nothing.
    let farmer = "farm.maskwars.testnet";
    as_(farmer, 0, 7 * MIN);
    enlist_now(&mut c, ID.into());
    as_(METER, 0, 7 * MIN);
    c.burn(ID.into(), acc(farmer), U128(FUEL));
    // The judge counts the crew's two steps; ONYX's review is junk to the rubric and does not count.
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    answered(&mut c, ID, false, stdout(&reply(Some(0), &[0, 1])), judge_at() + MIN);
    let f = c.fuel(ID.into());
    let of = |m: &str| f.iter().find(|x| x.mask == acc(m)).unwrap().covered.unwrap().0;
    assert_eq!((of(KIRA), of(NOVA), of(ONYX), of(farmer)), (30 * MILLI, 40 * MILLI, 0, 0));
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    as_("anyone.testnet", 0, settle_at());
    c.settle(ID.into());
    // The treasury gets only KIRA's and NOVA's fuel.
    assert_eq!(paid_to(TREASURY), 70 * MILLI);
    let fee = REWARD * 500 / 10_000;
    let budget = JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - 1);
    // The client gets the fuel of every uncovered burn (ONYX's 0.05 and the farmer's 0.05) and what was not burned.
    client_got(4 * FUEL - 70 * MILLI + budget + reserve, reserve, 4);
    // The farmer held a slot and revealed nothing, and ONYX's revealed review counted for nothing: each pays half its
    // bond to the company, the other half goes back.
    assert_eq!(paid_to(COMPANY), fee + 2 * idle_part(FUEL));
    assert_eq!(paid_to(BACKER), 2 * FUEL + 2 * (FUEL - idle_part(FUEL)));
    let farm = settled()["fuel"].as_array().unwrap().iter().find(|f| f["mask"] == farmer).cloned().unwrap();
    assert_eq!((yocto_of(&farm["burned"]), yocto_of(&farm["covered"])), (FUEL, 0));
    let bond = settled()["bonds"].as_array().unwrap().iter().find(|b| b["mask"] == farmer).cloned().unwrap();
    assert_eq!((bond["why"].as_str(), yocto_of(&bond["lost"])), (Some("idle"), idle_part(FUEL)));
}

// ---------------------------------------------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_judge_runs_after_the_reveal_window_at_the_pinned_version() {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at() - 1);
    assert_eq!(panics(|| c.judge(ID.into())), "the judge runs once the reveal window is over");
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let calls: Vec<(String, String, Value, u128)> = get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions.into_iter().map(move |a| (r.receiver_id.to_string(), a)))
        .filter_map(|(to, a)| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => Some((
                to,
                String::from_utf8(method_name).unwrap(),
                serde_json::from_slice(&args).unwrap_or(Value::Null),
                attached_deposit.as_yoctonear(),
            )),
            _ => None,
        })
        .collect();
    let (to, method, args, fee) = &calls[0];
    assert_eq!((to.as_str(), method.as_str(), *fee), (OUTLAYER, "request_execution", JUDGE_FEE.as_yoctonear()));
    assert_eq!(args["source"]["Project"]["version_key"], REVIEW_V);
    assert_eq!(args["payer_account_id"], CONTRACT);
    let input: Value = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        input,
        json!({ "job": ID, "contract": CONTRACT, "kind": "ai_review", "appeal": false, "prior": null, "check": false,
                "deliver": false })
    );
    let v = c.get(ID.into()).unwrap();
    assert!(matches!(v.status, Status::Judging { .. }));
    assert_eq!(v.judge_budget.0, JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - 1));
    assert_eq!(panics(|| c.judge(ID.into())), "the job is not waiting for a judge");
}

/// The attack: a judge that is not the job's. Its answer cannot reach the contract except as the reply to the job's
/// own run; a reply about another job, steps nobody revealed, or a winner without work decides nothing.
#[test]
fn a_judge_that_is_not_the_job_s_decides_nothing() {
    let mut c = worked();
    // Only the contract itself calls the callback (`#[private]`: the sandbox shows a stranger refused). An answer
    // counts only while the job's own run is out.
    let v = answered(&mut c, ID, false, stdout(&reply(Some(1), &[2])), judge_at());
    assert_eq!(v.status, Status::Open);
    let bad = [
        json!({ "success": true, "output": { "job": "other-job", "winner": 1, "counted": [2] }, "error": null })
            .to_string(),
        reply(Some(1), &[9]),
        reply(Some(1), &[0]),
        reply(Some(7), &[2]),
        json!({ "success": false, "output": null, "error": "rubric unreachable" }).to_string(),
        "not json".to_string(),
    ];
    for (i, b) in bad.iter().enumerate() {
        as_("anyone.testnet", 0, judge_at() + i as u64);
        let _ = c.judge(ID.into());
        let v = answered(&mut c, ID, false, stdout(b), judge_at() + i as u64);
        assert_eq!(v.status, Status::Open, "{b}");
        assert!(v.verdict.is_none());
        assert_eq!(v.judge_budget.0, JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - (i as u128 + 1)));
    }
    let logs = get_logs().join("\n");
    assert!(logs.contains("the judge could not judge") || logs.contains("unreadable"), "{logs}");
    // A check's answer is no verdict either.
    as_("anyone.testnet", 0, judge_at() + MIN);
    let _ = c.judge(ID.into());
    assert_eq!(answered(&mut c, ID, false, stdout(&check_reply(ID, true)), judge_at() + MIN).status, Status::Open);
    // A failed run decides nothing either. Once the job's runs are spent, the caller pays the next.
    while c.get(ID.into()).unwrap().judge_budget.0 > 0 {
        as_("anyone.testnet", 0, judge_at() + MIN);
        let _ = c.judge(ID.into());
        assert_eq!(answered(&mut c, ID, false, PromiseResult::Failed, judge_at() + MIN).status, Status::Open);
    }
    as_("anyone.testnet", 0, judge_at() + MIN);
    assert_eq!(panics(|| c.judge(ID.into())), "the job's judge runs are spent: attach 0.01 NEAR");
    as_("anyone.testnet", JUDGE_FEE.as_yoctonear(), judge_at() + MIN);
    let _ = c.judge(ID.into());
    assert_eq!(answered(&mut c, ID, false, PromiseResult::Failed, judge_at() + MIN).status, Status::Open);
}

#[test]
fn a_winner_needs_a_counted_strike_of_its_own() {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    // The crew with only KIRA's finding counted cannot win: a finding is not the work.
    let v = answered(&mut c, ID, false, stdout(&reply(Some(0), &[0])), judge_at());
    assert_eq!(v.status, Status::Open);
    assert!(get_logs().iter().any(|l| l.contains("has no counted strike")), "{:?}", get_logs());
}

#[test]
fn only_a_job_with_a_revealed_strike_goes_to_the_judge_and_the_rest_closes() {
    let mut c = opened();
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    let k = seal(&mut c, ID, KIRA, "finding", 2 * MIN);
    // NOVA sealed but never revealed.
    seal(&mut c, ID, NOVA, "strike", 3 * MIN);
    open_up(&mut c, ID, KIRA, k, "finding", u64::from(WORK) * MIN);
    as_(METER, 0, 4 * MIN);
    c.burn(ID.into(), acc(KIRA), U128(FUEL));
    as_("anyone.testnet", 0, judge_at());
    assert_eq!(panics(|| c.judge(ID.into())), "no striker revealed any work: close the job");
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    let v = c.close(ID.into());
    assert_eq!(v.status, Status::Closed);
    client_got(REWARD + 4 * FUEL + JUDGE_FEE.as_yoctonear() * RUNS_LEFT + reserve, reserve, 4);
    assert!(settled()["fuel"].as_array().unwrap().iter().all(|f| f["covered"] == "0"));
    assert_eq!(c.config().live, 0);
}

/// No verdict by `judge_until` (a judge that never decided, a model that never answered): nobody is named, so the reward
/// goes back to the client, who saw none of the work: every revealed step is a box for the judge. Nobody loses a bond,
/// and the fuel of every revealed attempt is paid to NEAR AI as always. Before the review, this shared the reward
/// among revealed strikes, and an injector could force it to take a part (second review, finding 2).
#[test]
fn no_verdict_by_judge_until_gives_the_reward_back_and_every_bond() {
    let mut c = worked();
    // The judge ran and failed: nothing decided.
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    answered(
        &mut c,
        ID,
        false,
        stdout(&json!({ "success": false, "error": "no valid answer" }).to_string()),
        judge_at(),
    );
    assert_eq!(panics(|| c.close(ID.into())), "a striker's work waits for the judge until judge_until");
    let until = c.get(ID.into()).unwrap().terms.judge_until.0;
    as_("anyone.testnet", 0, until);
    assert_eq!(panics(|| c.judge(ID.into())), "the time to judge is over: close the job");
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    let v = c.close(ID.into());
    assert_eq!((v.status, v.phase.as_str()), (Status::Closed, "closed"));
    assert_eq!((paid_to(KIRA), paid_to(NOVA), paid_to(ONYX), paid_to(COMPANY)), (0, 0, 0, 0), "nobody is named");
    assert_eq!(paid_to(BACKER), 3 * FUEL, "every bond goes back to whoever locked it");
    assert_eq!(paid_to(TREASURY), 120 * MILLI, "every revealed attempt's fuel is paid");
    client_got(REWARD + 4 * FUEL - 120 * MILLI + JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - 1) + reserve, reserve, 4);
    assert!(settled()["bonds"].as_array().unwrap().iter().all(|b| b["why"].is_null() && b["lost"] == "0"));
    assert_eq!(c.config().live, 0);
}

/// Equal parts only when the client is to blame: the judge attests that the client's own material is missing or
/// broken (`shared`). Even then only real work shares: the client's puppet ONYX sealed a guess first, the judge calls
/// it fake, and its bond goes to the company, not into anyone's part. Before the second review a puppet's guess took
/// an equal part; before the third its bond joined the pool.
#[test]
fn a_shared_verdict_pays_only_real_work_and_a_puppet_that_sealed_first_loses_its_bond() {
    let mut c = opened();
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    let o = seal(&mut c, ID, ONYX, "work: a guess, sealed early", 2 * MIN);
    let k = seal(&mut c, ID, KIRA, "finding: quorum math", 3 * MIN);
    let n = seal(&mut c, ID, NOVA, "review: the quorum bug and its fix", 4 * MIN);
    let after = u64::from(WORK) * MIN;
    open_up(&mut c, ID, ONYX, o, "work: a guess, sealed early", after);
    open_up(&mut c, ID, KIRA, k, "finding: quorum math", after);
    open_up(&mut c, ID, NOVA, n, "review: the quorum bug and its fix", after);
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let shared = json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [k, n], "fake": [o],
                         "shared": true, "rule": "shared" }, "error": null });
    let v = answered(&mut c, ID, false, stdout(&shared.to_string()), judge_at());
    let verdict = v.verdict.unwrap();
    assert_eq!(
        (verdict.winner, verdict.counted.clone(), verdict.fake.clone(), verdict.shared),
        (None, vec![k, n], vec![o], true)
    );
    as_("anyone.testnet", 0, settle_at());
    assert_eq!(c.settle(ID.into()).status, Status::Shared);
    let fee = REWARD * 500 / 10_000;
    let net = REWARD - fee;
    assert_eq!(paid_to(ONYX), 0, "the puppet's guess is no real work: no part");
    assert_eq!((paid_to(KIRA), paid_to(NOVA)), (net * 3 / 10, net - net * 3 / 10), "the duo takes the reward");
    assert_eq!(paid_to(BACKER), 2 * FUEL, "the duo's bonds go back; ONYX's is lost");
    assert_eq!(paid_to(COMPANY), fee + FUEL, "ONYX's bond goes to the company, not into the duo's part");
    assert_eq!(yocto_of(&settled()["forfeit"]), FUEL);
}

/// An odd pool splits with nothing lost: the first entrant to seal a counted strike takes what rounding leaves.
#[test]
fn a_shared_pool_loses_no_yocto_to_rounding() {
    let mut c = worked();
    let mut odd = c.job(ID);
    odd.terms.reward = U128(REWARD + 1);
    c.jobs.insert(ID.into(), odd);
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let shared =
        json!({ "success": true, "output": { "job": ID, "counted": [0, 1, 2], "shared": true }, "error": null });
    answered(&mut c, ID, false, stdout(&shared.to_string()), judge_at());
    as_("anyone.testnet", 0, settle_at());
    c.settle(ID.into());
    let paid = paid_to(KIRA) + paid_to(NOVA) + paid_to(ONYX) + paid_to(COMPANY);
    assert_eq!(paid, REWARD + 1, "every yocto of the pool is paid");
    let (half, onyx) = (REWARD / 2, paid_to(ONYX) + (REWARD / 2) * 500 / 10_000);
    assert_eq!(
        onyx, half,
        "ONYX's part is the even half; the duo, first to seal a counted strike, takes the odd yocto"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// The bond
// ---------------------------------------------------------------------------------------------------------------

/// A mask takes a job only with a bond locked for it: its narrow key cannot attach NEAR, so its owner (or the keeper,
/// from its tank) locks it first. The bond's record pays its own storage, comes back when the mask enlists, and the
/// bond itself is held on the mask's seat until the job ends.
#[test]
fn a_mask_takes_a_job_only_with_a_bond_locked_for_it() {
    let mut c = opened();
    as_(ONYX, 0, MIN);
    assert_eq!(
        panics(|| c.enlist(ID.into())),
        "every mask takes a job with a bond locked for it first: bond(id, mask)"
    );
    // Too little NEAR for the bond and its record.
    as_(BACKER, FUEL, MIN);
    assert!(panics(|| c.bond(ID.into(), acc(ONYX))).starts_with("a bond on this job takes"));
    as_(BACKER, FUEL + ONE, MIN);
    let b = c.bond(ID.into(), acc(ONYX));
    assert_eq!((b.by.as_str(), b.amount.0), (BACKER, FUEL));
    assert!(b.storage.0 > 0 && b.storage.0 <= cost_of(BOND_RECORD_BYTES), "{}", b.storage.0);
    assert_eq!(transfers(), vec![(BACKER.to_string(), ONE - b.storage.0)], "the rest comes back at once");
    as_(BACKER, FUEL + ONE, MIN);
    assert_eq!(panics(|| c.bond(ID.into(), acc(ONYX))), "a bond is locked for this mask on this job already");
    as_(CLIENT, FUEL + ONE, MIN);
    assert_eq!(panics(|| c.bond(ID.into(), acc(CLIENT))), "the client is not one of its own job's masks");
    // Only whoever locked it takes it back, while the mask has not enlisted.
    as_(ONYX, 0, MIN);
    assert_eq!(panics(|| c.unbond(ID.into(), acc(ONYX))), "only whoever locked a bond takes it back");
    as_(BACKER, 0, MIN);
    assert_eq!(c.unbond(ID.into(), acc(ONYX)).0, FUEL + b.storage.0);
    assert_eq!(transfers(), vec![(BACKER.to_string(), FUEL + b.storage.0)]);
    assert!(c.bond_of(ID.into(), acc(ONYX)).is_none());
    // Locked again, the mask takes it: the record's storage goes back, the bond sits on the seat.
    as_(BACKER, FUEL + ONE, MIN);
    c.bond(ID.into(), acc(ONYX));
    as_(ONYX, 0, 2 * MIN);
    assert_eq!(c.enlist(ID.into()), 0);
    assert_eq!(transfers(), vec![(BACKER.to_string(), b.storage.0)]);
    let held = c.bond_of(ID.into(), acc(ONYX)).unwrap();
    assert_eq!((held.by.as_str(), held.amount.0, held.enlisted), (BACKER, FUEL, true));
    as_(BACKER, 0, 2 * MIN);
    assert_eq!(panics(|| c.unbond(ID.into(), acc(ONYX))), "no bond waits for this mask here");
    as_(BACKER, FUEL + ONE, 2 * MIN);
    assert_eq!(panics(|| c.bond(ID.into(), acc(ONYX))), "this mask is on the job already");
    // A mask that leaves before its first step gets its bond back at once, less what holding the slot cost: the idle
    // half of its bond times the share of the window it held, here one minute of the 28 left when it enlisted.
    as_(ONYX, 0, 3 * MIN);
    c.leave(ID.into());
    let lost = held_cost(FUEL, 2 * MIN, 3 * MIN, u64::from(WORK) * MIN);
    assert_eq!(lost, idle_part(FUEL) / 28);
    assert_eq!(transfers(), vec![(BACKER.to_string(), FUEL - lost), (COMPANY.to_string(), lost)]);
    assert!(c.bond_of(ID.into(), acc(ONYX)).is_none());
    // A crew enlists only when every member has a bond.
    as_(BACKER, FUEL + ONE, 3 * MIN);
    c.bond(ID.into(), acc(KIRA));
    as_(CREWS, 0, 3 * MIN);
    assert_eq!(
        panics(|| c.enlist_crew(ID.into(), duo())),
        "every mask takes a job with a bond locked for it first: bond(id, mask)"
    );
    // No new bonds once the work window is over.
    as_(BACKER, FUEL + ONE, u64::from(WORK) * MIN);
    assert_eq!(panics(|| c.bond(ID.into(), acc(NOVA))), "the job takes no new masks");
}

/// Third review, finding 2: a mask the judge calls fake loses its bond to the company, never to the winner, so a
/// client's puppet that wins collects nobody's bond. Every other bond goes back to whoever locked it, the winner's
/// crew's included.
#[test]
fn a_fake_mask_loses_its_bond_to_the_company_never_to_the_winner() {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let out =
        json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [0, 1], "fake": [2] }, "error": null });
    let v = answered(&mut c, ID, false, stdout(&out.to_string()), judge_at() + MIN);
    assert_eq!(v.verdict.unwrap().fake, vec![2]);
    as_("anyone.testnet", 0, settle_at());
    assert_eq!(c.settle(ID.into()).status, Status::Paid { winner: 0 });
    let fee = REWARD * 500 / 10_000;
    let net = REWARD - fee;
    assert_eq!((paid_to(KIRA), paid_to(NOVA)), (net * 3 / 10, net - net * 3 / 10), "the reward alone, no bond in it");
    assert_eq!(paid_to(ONYX), 0);
    assert_eq!(paid_to(COMPANY), fee + FUEL, "ONYX's bond goes to the company");
    assert_eq!(paid_to(BACKER), 2 * FUEL, "KIRA's and NOVA's bonds come back");
    assert_eq!(paid_to(TREASURY), 70 * MILLI, "the fake step's fuel is not the client's to pay");
    let bonds = settled()["bonds"].clone();
    let lost: Vec<&Value> = bonds.as_array().unwrap().iter().filter(|b| b["why"] == "fake").collect();
    assert_eq!((lost.len(), lost[0]["mask"].as_str(), yocto_of(&lost[0]["lost"])), (1, Some(ONYX), FUEL));
}

/// With nobody to pay, a fake mask's bond goes to the company that paid to judge it too, never to the client: a client
/// gains nothing by baiting masks into work its judge would call fake.
#[test]
fn with_no_winner_a_fake_mask_s_bond_goes_to_the_company_not_the_client() {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let out = json!({ "success": true, "output": { "job": ID, "winner": null, "counted": [0, 1], "fake": [2] }, "error": null });
    answered(&mut c, ID, false, stdout(&out.to_string()), judge_at() + MIN);
    as_("anyone.testnet", 0, settle_at());
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    assert_eq!(c.settle(ID.into()).status, Status::Closed);
    assert_eq!(paid_to(COMPANY), FUEL, "ONYX's bond: the company's, no fee taken on an unpaid reward");
    assert_eq!(paid_to(BACKER), 2 * FUEL);
    client_got(REWARD + 4 * FUEL - 70 * MILLI + JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - 1) + reserve, reserve, 4);
}

/// A verdict that calls one step both counted and fake, or names a step that is not revealed work as fake, decides
/// nothing.
#[test]
fn a_verdict_that_calls_a_step_both_real_and_fake_decides_nothing() {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let both =
        json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [0, 1], "fake": [1] }, "error": null });
    assert_eq!(answered(&mut c, ID, false, stdout(&both.to_string()), judge_at()).status, Status::Open);
    assert!(get_logs().iter().any(|l| l.contains("the judge called step 1 both counted and fake")));
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let ghost =
        json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [0, 1], "fake": [9] }, "error": null });
    assert_eq!(answered(&mut c, ID, false, stdout(&ghost.to_string()), judge_at()).status, Status::Open);
}

// ---------------------------------------------------------------------------------------------------------------
// Private by default
// ---------------------------------------------------------------------------------------------------------------

/// No work of a `tee_tests` or `ai_review` job is ever on chain in the open: a revealed step is a box sealed for the
/// judge's key, of one size. A drain's plan is a drain's: plain text, as its round shows it anyway.
#[test]
fn a_revealed_step_of_a_private_job_is_a_box_for_the_judge() {
    let mut c = opened();
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    let plain = "review: section 4 counts abstentions toward quorum";
    as_(ONYX, 0, 2 * MIN);
    let s = c.step(ID.into(), step_hash(ID, &acc(ONYX), &salt_of(ONYX), plain)).seq;
    as_(ONYX, 0, u64::from(WORK) * MIN);
    assert_eq!(
        panics(|| c.reveal(ID.into(), s, salt_of(ONYX), plain.into())),
        "content: a box sealed for the judge's key, mw1.…: no work is revealed in the open"
    );
    let short = format!("{BOX_PREFIX}{}", "A".repeat(BOX_CHARS - 1));
    assert!(
        !box_ok(&short) && !box_ok(&format!("{BOX_PREFIX}{}=", "A".repeat(BOX_CHARS - 1))) && box_ok(&boxed(plain))
    );
    let mut c = drain_job();
    let v = c.steps(ID.into(), None, None);
    assert_eq!(v[1].content.as_deref(), Some("plan"), "a drain's plan is plain text");
    let _ = &mut c;
}

/// The winning work goes to the client alone, and only once the job is paid: anyone (the client, its board) asks the
/// judge to seal it again for the client's key, paying the run. Before the job is paid, for a drain, or without the
/// run's fee, nothing is asked. The judge's answer says where the box is kept.
#[test]
fn the_winning_work_goes_to_the_client_only_once_the_job_is_paid() {
    let mut c = judged(Some(0), &[0, 1, 2]);
    as_(CLIENT, JUDGE_FEE.as_yoctonear(), judge_at() + 2 * MIN);
    assert_eq!(panics(|| c.deliver(ID.into())), "the winning work goes to the client once the job is paid");
    as_("anyone.testnet", 0, settle_at());
    c.settle(ID.into());
    as_(CLIENT, JUDGE_FEE.as_yoctonear() - 1, settle_at());
    assert_eq!(panics(|| c.deliver(ID.into())), "a delivery is one judge run: attach 0.01 NEAR");
    as_(CLIENT, JUDGE_FEE.as_yoctonear() + 5, settle_at());
    let _ = c.deliver(ID.into());
    let receipts = get_created_receipts();
    let call = receipts
        .iter()
        .flat_map(|r| r.actions.iter())
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"request_execution" => {
                serde_json::from_slice::<Value>(args).ok()
            }
            _ => None,
        })
        .unwrap();
    let input: Value = serde_json::from_str(call["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        (input["deliver"].clone(), input["appeal"].clone(), input["check"].clone()),
        (json!(true), json!(false), json!(false))
    );
    assert!(call["secrets_ref"].is_null(), "a delivery names no secrets of the client");
    assert_eq!(call["payer_account_id"], CLIENT);
    assert!(transfers().contains(&(CLIENT.to_string(), 5)), "what the run did not take comes back");
    // The judge's answer: where the box is, and its hash. The job stays paid.
    let sha = "e".repeat(64);
    let answer = json!({ "success": true, "output": { "job": ID, "delivered": format!("delivery/{CONTRACT}/{ID}"), "sha256": sha }, "error": null });
    testing_env!(
        ctx(CONTRACT, 0, settle_at()).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![stdout(&answer.to_string())]
    );
    let d = c.on_delivered(ID.into()).unwrap();
    assert_eq!(
        (d.at.as_str(), d.sha256.as_str(), d.key.as_str()),
        (format!("delivery/{CONTRACT}/{ID}").as_str(), sha.as_str(), CLIENT_KEY)
    );
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"deliver\"")));
    assert_eq!(c.get(ID.into()).unwrap().status, Status::Paid { winner: 0 });
    // A verdict is no delivery.
    testing_env!(
        ctx(CONTRACT, 0, settle_at()).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![stdout(&reply(Some(0), &[0]))]
    );
    assert!(c.on_delivered(ID.into()).is_none());
    // A drain's plan is on chain: there is nothing to deliver.
    let mut d = drain_job();
    let drained = json!({ "owner": CLIENT, "amount": "1", "target": "safe", "deadline_ns": "1",
                          "status": { "state": "drained", "winner": NOVA, "tx_hash": "abc" } });
    round_says(&mut d, Some(drained));
    as_("anyone.testnet", 0, settle_at());
    d.settle(ID.into());
    as_(CLIENT, JUDGE_FEE.as_yoctonear(), settle_at());
    assert_eq!(panics(|| d.deliver(ID.into())), "a drain's plan is on chain: there is nothing to deliver");
}

/// Finding 1 of the second review: the client swapped its test set after the check and appealed, and the judge read
/// the swapped set from the client's row. The check is now the only run that names the client's secrets: the judge
/// keeps its own copy there, and every later run (verdict, appeal, delivery) names none.
#[test]
fn after_the_check_no_judge_run_names_the_client_s_secrets() {
    let mut c = contract();
    open_unchecked(&mut c, ID, Kind::TeeTests, 2, OpenTo::Anyone, 0);
    let secrets_of = || {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .find_map(|a| match a {
                MockAction::FunctionCallWeight { method_name, args, .. } if method_name == b"request_execution" => {
                    serde_json::from_slice::<Value>(&args).ok()
                }
                _ => None,
            })
            .unwrap()["secrets_ref"]
            .clone()
    };
    as_("anyone.testnet", 0, MIN);
    let _ = c.check(ID.into());
    assert_eq!(secrets_of(), json!({ "profile": "bench", "account_id": CLIENT }), "the check reads the client's row");
    answered(&mut c, ID, false, stdout(&check_reply(ID, true)), MIN);
    as_(ONYX, 0, 2 * MIN);
    enlist_now(&mut c, ID.into());
    let s = seal(&mut c, ID, ONYX, "module", 3 * MIN);
    open_up(&mut c, ID, ONYX, s, "module", MIN + u64::from(WORK) * MIN);
    as_("anyone.testnet", 0, MIN + judge_at());
    let _ = c.judge(ID.into());
    assert!(secrets_of().is_null(), "the verdict reads the judge's own copy");
    answered(&mut c, ID, false, stdout(&reply(Some(0), &[0])), MIN + judge_at());
    as_(CLIENT, APPEAL_BOND.as_yoctonear(), MIN + judge_at() + MIN);
    let _ = c.appeal(ID.into());
    assert!(secrets_of().is_null(), "so does the appeal: a swapped row changes nothing");
}

// ---------------------------------------------------------------------------------------------------------------
// The judge's final word
// ---------------------------------------------------------------------------------------------------------------

/// Finding 6 of the second review: an appeal whose answers never agree ran again and again on its bond and lapsed with
/// the bond back. Now the judge, once every seed is spent, answers that it cannot decide: the appeal ends there, the
/// verdict it was against stands, final, and the bond goes to the company that paid for the runs.
#[test]
fn the_judge_s_final_word_that_it_cannot_decide_ends_an_appeal() {
    let mut c = judged(Some(0), &[0, 1, 2]);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    let undecided = json!({ "success": true, "output": { "job": ID, "undecided": true, "winner": 1, "counted": [2] }, "error": null });
    let v = answered(&mut c, ID, true, stdout(&undecided.to_string()), judge_at() + 3 * MIN);
    let verdict = v.verdict.unwrap();
    assert_eq!(
        (v.status, verdict.winner, verdict.is_final, verdict.undecided),
        (Status::Decided, Some(0), true, false)
    );
    assert_eq!(transfers(), vec![(COMPANY.to_string(), APPEAL_BOND.as_yoctonear())]);
    // Final: no more runs, settle pays at once.
    as_("anyone.testnet", 0, judge_at() + 4 * MIN);
    assert_eq!(panics(|| c.judge(ID.into())), "the job is not waiting for a judge");
    assert_eq!(c.settle(ID.into()).status, Status::Paid { winner: 0 });
}

/// A first verdict the judge cannot reach (every seed spent on a model that never answered) names nobody: no winner,
/// nobody fake. The reward and every bond go back, and the fuel of every revealed attempt is paid, as with no verdict.
#[test]
fn an_undecided_first_verdict_names_nobody() {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let undecided = json!({ "success": true, "output": { "job": ID, "undecided": true, "fake": [2] }, "error": null });
    let v = answered(&mut c, ID, false, stdout(&undecided.to_string()), judge_at() + MIN);
    let verdict = v.verdict.unwrap();
    assert_eq!(
        (verdict.winner, verdict.counted.clone(), verdict.fake.clone(), verdict.undecided),
        (None, vec![0, 1, 2], vec![], true)
    );
    as_("anyone.testnet", 0, settle_at());
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    assert_eq!(c.settle(ID.into()).status, Status::Closed);
    assert_eq!(paid_to(BACKER), 3 * FUEL);
    assert_eq!(paid_to(TREASURY), 120 * MILLI);
    client_got(REWARD + 4 * FUEL - 120 * MILLI + JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - 1) + reserve, reserve, 4);
}

/// Finding 5 of the second review: a drain whose round never ended (no winner, no refund by the bounty contract's
/// clock) shared the reward among every revealed strike, so junk plans were paid. Now no verdict by `judge_until`
/// gives the reward back to the client.
#[test]
fn a_drain_whose_round_never_ends_gives_the_reward_back_at_judge_until() {
    let mut c = drain_job();
    let open =
        json!({ "owner": CLIENT, "amount": "1", "target": "safe", "deadline_ns": "1", "status": { "state": "open" } });
    assert_eq!(round_says(&mut c, Some(open)).status, Status::Open);
    let until = c.get(ID.into()).unwrap().terms.judge_until.0;
    as_("anyone.testnet", 0, until - MIN);
    assert_eq!(panics(|| c.close(ID.into())), "a striker's work waits for the judge until judge_until");
    as_("anyone.testnet", 0, until);
    assert_eq!(c.close(ID.into()).status, Status::Closed);
    assert_eq!(
        (paid_to(KIRA), paid_to(NOVA), paid_to(ONYX), paid_to(COMPANY)),
        (0, 0, 0, 0),
        "junk plans earn nothing"
    );
    assert_eq!(paid_to(BACKER), 3 * FUEL);
    assert!(paid_to(CLIENT) > REWARD, "the reward goes back with the unused fuel, runs and storage");
}

#[test]
fn a_judge_that_never_answers_is_dropped_and_the_job_waits_again() {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    as_("anyone.testnet", 0, judge_at() + (JUDGE_TIMEOUT_BLOCKS - 1) * 1_000_000_000);
    assert_eq!(panics(|| c.unstick(ID.into())), "the judge may still answer");
    as_("anyone.testnet", 0, judge_at() + JUDGE_TIMEOUT_BLOCKS * 1_000_000_000);
    assert_eq!(c.unstick(ID.into()).status, Status::Open);
    // Run 1 was the check; run 2 never answered. Its late answer is ignored.
    let v = answered_run(&mut c, ID, false, 2, stdout(&reply(Some(0), &[0, 1])), judge_at() + 700 * 1_000_000_000);
    assert_eq!(v.status, Status::Open);
    // Run 3 is out: run 2's answer, coming even later, still decides nothing; run 3's does.
    as_("anyone.testnet", 0, judge_at() + 800 * 1_000_000_000);
    let _ = c.judge(ID.into());
    let at = judge_at() + 801 * 1_000_000_000;
    let v = answered_run(&mut c, ID, false, 2, stdout(&reply(Some(1), &[2])), at);
    assert!(matches!(v.status, Status::Judging { run: 3, .. }), "{:?}", v.status);
    let v = answered_run(&mut c, ID, false, 3, stdout(&reply(Some(0), &[0, 1])), at);
    assert_eq!(v.verdict.unwrap().winner, Some(0));
}

// ---------------------------------------------------------------------------------------------------------------
// Settling: the reward split by contribution
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_crew_wins_and_the_reward_splits_by_its_rule_the_fuel_of_real_attempts_goes_to_near_ai() {
    let mut c = judged(Some(0), &[0, 1, 2]);
    as_("anyone.testnet", 0, settle_at() - 1);
    assert_eq!(panics(|| c.settle(ID.into())), "the verdict may still be appealed");
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    as_("anyone.testnet", 0, settle_at());
    let v = c.settle(ID.into());
    assert_eq!(v.status, Status::Paid { winner: 0 });
    let fee = REWARD * 500 / 10_000;
    let net = REWARD - fee;
    // 30% to the scout, 70% to the striker.
    assert_eq!(paid_to(KIRA), net * 3 / 10);
    assert_eq!(paid_to(NOVA), net - net * 3 / 10);
    assert_eq!(paid_to(COMPANY), fee);
    // Every real attempt's fuel: ONYX lost, but its review counted.
    assert_eq!(paid_to(TREASURY), 120 * MILLI);
    let budget = JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - 1);
    client_got(4 * FUEL - 120 * MILLI + budget + reserve, reserve, 4);
    assert_eq!(paid_to(ONYX), 0);
    // The job's masks, steps and seats are cleared: the client got their storage back.
    assert!(
        c.steps(ID.into(), None, None).is_empty() && c.entrants(ID.into()).is_empty() && c.fuel(ID.into()).is_empty()
    );
    assert_eq!(c.config().live, 0);
    assert_eq!(panics(|| c.settle(ID.into())), "the job has no verdict to pay");
}

#[test]
fn a_crew_mask_whose_step_did_not_count_gets_nothing_and_its_role_s_share_goes_to_the_others() {
    let mut c = judged(Some(0), &[1]);
    as_("anyone.testnet", 0, settle_at());
    c.settle(ID.into());
    let net = REWARD - REWARD * 500 / 10_000;
    assert_eq!(paid_to(KIRA), 0);
    assert_eq!(paid_to(NOVA), net);
    assert_eq!(paid_to(TREASURY), 40 * MILLI, "only NOVA's attempt counted");
}

#[test]
fn nobody_won_the_reward_goes_back_but_real_attempts_still_burn_fuel() {
    let mut c = judged(None, &[1, 2]);
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    as_("anyone.testnet", 0, settle_at());
    let v = c.settle(ID.into());
    assert_eq!(v.status, Status::Closed);
    assert_eq!(paid_to(COMPANY), idle_part(FUEL), "no fee without a winner: only KIRA's uncounted seat pays its half");
    assert_eq!(paid_to(TREASURY), 90 * MILLI);
    let budget = JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - 1);
    client_got(REWARD + 4 * FUEL - 90 * MILLI + budget + reserve, reserve, 4);
}

#[test]
fn every_yocto_of_a_job_is_accounted_for() {
    let mut c = contract();
    let before = env::storage_usage();
    let deposit = price(&c, 4);
    open_unchecked(&mut c, ID, Kind::AiReview, 4, OpenTo::Anyone, 0);
    let mut out = transfers().iter().map(|(_, a)| a).sum::<u128>();
    let record = cost_of(env::storage_usage() - before);
    pass_check(&mut c, ID, 0);
    let reserve0 = c.get(ID.into()).unwrap().reserve.0;
    // The owner locks a bond for each of the duo: in, with what each record's storage costs.
    let mut locked = 0;
    for m in [KIRA, NOVA] {
        as_(BACKER, FUEL + ONE, MIN);
        c.bond(ID.into(), acc(m));
        locked += FUEL + ONE;
        out += transfers().iter().map(|(_, a)| a).sum::<u128>();
    }
    // Masks work, the judge decides, the job pays.
    as_(CREWS, 0, MIN);
    c.enlist_crew(ID.into(), duo());
    out += transfers().iter().map(|(_, a)| a).sum::<u128>();
    let s = seal(&mut c, ID, NOVA, "strike", 2 * MIN);
    as_(METER, 0, 3 * MIN);
    c.burn(ID.into(), acc(NOVA), U128(FUEL));
    open_up(&mut c, ID, NOVA, s, "strike", u64::from(WORK) * MIN);
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    // Two runs went to OutLayer: the check and the verdict.
    let run = 2 * JUDGE_FEE.as_yoctonear();
    let r = json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [s] }, "error": null });
    answered(&mut c, ID, false, stdout(&r.to_string()), judge_at());
    let reserve1 = c.get(ID.into()).unwrap().reserve.0;
    as_("anyone.testnet", 0, settle_at());
    c.settle(ID.into());
    out += transfers().iter().map(|(_, a)| a).sum::<u128>();
    // In: the deposit and the bonds. Out: every transfer and the judge's run. What stays: the job's record, and its
    // verdict.
    let kept = deposit + locked - out - run - record;
    assert!(kept > 0 && kept <= cost_of(JOB_GROWTH_BYTES), "only the verdict stays: {kept}");
    assert!(reserve0 - reserve1 > kept, "the masks' storage came back");
}

// ---------------------------------------------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn an_appeal_that_changes_the_verdict_gets_its_bond_back_and_the_second_verdict_is_final() {
    let mut c = judged(Some(1), &[1, 2]);
    as_(KIRA, APPEAL_BOND.as_yoctonear() - 1, judge_at() + 2 * MIN);
    assert_eq!(panics(|| c.appeal(ID.into())), "an appeal locks 0.2 NEAR");
    as_(KIRA, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    let v = c.get(ID.into()).unwrap();
    assert!(matches!(v.status, Status::Judging { .. }));
    assert_eq!(v.prior.as_ref().unwrap().winner, Some(1));
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    assert_eq!(panics(|| c.appeal(ID.into())), "there is no verdict to appeal");
    let v = answered(&mut c, ID, true, stdout(&reply(Some(0), &[0, 1, 2])), judge_at() + 3 * MIN);
    assert_eq!(v.status, Status::Decided);
    let verdict = v.verdict.unwrap();
    assert_eq!((verdict.winner, verdict.is_final), (Some(0), true));
    assert_eq!(transfers(), vec![(KIRA.to_string(), APPEAL_BOND.as_yoctonear())]);
    // Final: it pays at once, and nobody appeals again.
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 4 * MIN);
    assert_eq!(panics(|| c.appeal(ID.into())), "this verdict is final");
    as_("anyone.testnet", 0, judge_at() + 4 * MIN);
    assert_eq!(c.settle(ID.into()).status, Status::Paid { winner: 0 });
}

#[test]
fn an_appeal_the_judge_upholds_pays_its_bond_to_the_company() {
    let mut c = judged(Some(0), &[0, 1, 2]);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    answered(&mut c, ID, true, stdout(&reply(Some(0), &[2, 1, 0, 1])), judge_at() + 3 * MIN);
    assert_eq!(transfers(), vec![(COMPANY.to_string(), APPEAL_BOND.as_yoctonear())]);
}

/// An appeal is not free: a second verdict with the same winner, the same fake steps and other counted steps (runs of
/// a model always differ a little on which steps are real) upholds the verdict, and the bond goes to the company. Only
/// a changed winner, a change to or from equal parts for the client's fault (`shared`), or other fake steps give the
/// bond back.
#[test]
fn an_appeal_gets_its_bond_back_only_when_who_is_paid_or_who_loses_a_bond_changes() {
    let mut c = judged(Some(0), &[0, 1, 2]);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    let v = answered(&mut c, ID, true, stdout(&reply(Some(0), &[1])), judge_at() + 3 * MIN);
    assert_eq!(v.verdict.unwrap().counted, vec![1], "the second verdict's steps count");
    assert_eq!(transfers(), vec![(COMPANY.to_string(), APPEAL_BOND.as_yoctonear())], "the winner held: no bond back");

    let mut c = judged(Some(0), &[0, 1, 2]);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    let shared = json!({ "success": true, "output": { "job": ID, "shared": true }, "error": null }).to_string();
    answered(&mut c, ID, true, stdout(&shared), judge_at() + 3 * MIN);
    assert_eq!(transfers(), vec![(ONYX.to_string(), APPEAL_BOND.as_yoctonear())], "equal parts change who is paid");
}

/// Third review, finding 7: the first verdict calls ONYX's step fake (it would lose its bond) and names the same winner
/// the appeal names. The appeal clears ONYX: who loses a bond changed, so the appeal's bond comes back, and ONYX keeps
/// its own.
#[test]
fn an_appeal_that_changes_only_the_fake_steps_gets_its_bond_back() {
    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let first =
        json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [0, 1], "fake": [2] }, "error": null });
    answered(&mut c, ID, false, stdout(&first.to_string()), judge_at() + MIN);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    let v = answered(&mut c, ID, true, stdout(&reply(Some(0), &[0, 1, 2])), judge_at() + 3 * MIN);
    let verdict = v.verdict.unwrap();
    assert_eq!((verdict.winner, verdict.fake.clone(), verdict.is_final), (Some(0), vec![], true));
    assert_eq!(transfers(), vec![(ONYX.to_string(), APPEAL_BOND.as_yoctonear())], "the fake steps changed: bond back");
    as_("anyone.testnet", 0, judge_at() + 4 * MIN);
    c.settle(ID.into());
    assert_eq!(paid_to(BACKER), 3 * FUEL, "ONYX keeps its bond");
}

/// An appeal may take more than one judge run: one that gives no answer keeps the appeal in (`appealing`), and anyone
/// runs it again, paid from the job's runs; once those are spent, whoever asks fronts the run, and the held bond pays
/// it back if the run called NEAR AI. The judge keeps the answers it already has between runs. With no answer by the
/// appeal's deadline, the verdict appealed against stands and the bond goes back.
#[test]
fn an_appeal_runs_again_until_it_is_answered_or_its_time_is_over() {
    let mut c = judged(Some(0), &[0, 1, 2]);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    let v = answered(&mut c, ID, true, PromiseResult::Failed, judge_at() + 3 * MIN);
    assert_eq!((v.status.clone(), v.phase.as_str()), (Status::Appealing, "appealing"));
    assert!(v.appeal.is_some() && v.verdict.is_none() && transfers().is_empty(), "the appeal and its bond stay in");
    as_("anyone.testnet", APPEAL_BOND.as_yoctonear(), judge_at() + 4 * MIN);
    assert_eq!(panics(|| c.appeal(ID.into())), "there is no verdict to appeal");
    as_("anyone.testnet", 0, judge_at() + 4 * MIN);
    assert_eq!(panics(|| c.settle(ID.into())), "the appeal may still be answered: anyone runs it with judge");
    // Anyone runs it again; a partial answer decides nothing either.
    let _ = c.judge(ID.into());
    let partial =
        json!({ "success": false, "error": "an appeal needs three answers: 1 kept, the next run asks again" });
    let v = answered(&mut c, ID, true, stdout(&partial.to_string()), judge_at() + 5 * MIN);
    assert_eq!(v.status, Status::Appealing);
    // Once the job's runs are spent, whoever asks fronts the next run: the held bond is not touched to ask it.
    while c.get(ID.into()).unwrap().judge_budget.0 > 0 {
        as_("anyone.testnet", 0, judge_at() + 6 * MIN);
        let _ = c.judge(ID.into());
        answered(&mut c, ID, true, PromiseResult::Failed, judge_at() + 6 * MIN);
    }
    as_("anyone.testnet", 0, judge_at() + 7 * MIN);
    assert_eq!(panics(|| c.judge(ID.into())), "the job's judge runs are spent: attach 0.01 NEAR");
    as_("anyone.testnet", JUDGE_FEE.as_yoctonear(), judge_at() + 7 * MIN);
    let _ = c.judge(ID.into());
    assert_eq!(c.get(ID.into()).unwrap().appeal.unwrap().bond.0, APPEAL_BOND.as_yoctonear());
    // The run called NEAR AI twice and answered: the bond pays the run back, and the rest comes back to ONYX.
    let r = json!({ "success": true, "output": { "job": ID, "winner": 1, "counted": [2], "asked": 2 }, "error": null });
    let v = answered(&mut c, ID, true, stdout(&r.to_string()), judge_at() + 8 * MIN);
    assert_eq!((v.verdict.clone().unwrap().winner, v.verdict.unwrap().is_final), (Some(1), true));
    let held = APPEAL_BOND.as_yoctonear() - JUDGE_FEE.as_yoctonear();
    assert_eq!(
        transfers(),
        vec![("anyone.testnet".to_string(), JUDGE_FEE.as_yoctonear()), (ONYX.to_string(), held)],
        "the winner changed: what is left of the bond comes back"
    );

    // No answer in time: the verdict appealed against is paid, and the bond comes back.
    let mut c = judged(Some(0), &[0, 1, 2]);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    answered(&mut c, ID, true, PromiseResult::Failed, judge_at() + 3 * MIN);
    let deadline = settle_at() + APPEAL_GRACE_HOURS * HOUR;
    as_("anyone.testnet", 0, deadline);
    assert_eq!(panics(|| c.judge(ID.into())), "the appeal's time is over: settle pays the verdict it was against");
    let v = c.settle(ID.into());
    assert_eq!(v.status, Status::Paid { winner: 0 });
    assert_eq!(paid_to(ONYX), APPEAL_BOND.as_yoctonear());
    let net = REWARD - REWARD * 500 / 10_000;
    assert_eq!(paid_to(NOVA), net - net * 3 / 10, "the first verdict pays");
}

// ---------------------------------------------------------------------------------------------------------------
// Drain: the job follows a sealed round of the bounty contract
// ---------------------------------------------------------------------------------------------------------------

fn drain_job() -> Jobs {
    let mut c = contract();
    open_with(&mut c, ID, Kind::Drain, 4, OpenTo::Anyone, 0);
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    for (m, w) in [(KIRA, "recon"), (NOVA, "plan"), (ONYX, "plan b")] {
        let s = seal(&mut c, ID, m, w, 2 * MIN);
        open_up(&mut c, ID, m, s, w, u64::from(WORK) * MIN);
    }
    c
}

fn round_says(c: &mut Jobs, bounty: Option<Value>) -> JobView {
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let result = PromiseResult::Successful(serde_json::to_vec(&bounty).unwrap());
    testing_env!(
        ctx(CONTRACT, 0, judge_at()).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    let run = run_of(c, ID);
    c.on_round(ID.into(), run, Ok(bounty))
}

#[test]
fn a_drain_job_is_decided_by_its_round_and_its_winner_is_the_striker_s_crew() {
    let mut c = drain_job();
    let v = c.get(ID.into()).unwrap();
    assert!(v.terms.judge.is_none());
    assert_eq!(v.terms.judge_until.0, DRAIN_ROUND_HOURS * HOUR, "a drain waits for its round");
    // The round is still open: the job waits.
    let open =
        json!({ "owner": CLIENT, "amount": "1", "target": "safe", "deadline_ns": "1", "status": { "state": "open" } });
    assert_eq!(round_says(&mut c, Some(open)).status, Status::Open);
    // NOVA drained the safe and the bounty paid it: NOVA's crew wins, every revealed step counts, final at once.
    let drained = json!({ "owner": CLIENT, "amount": "1", "target": "safe", "deadline_ns": "1",
                          "status": { "state": "drained", "winner": NOVA, "tx_hash": "abc" } });
    let v = round_says(&mut c, Some(drained));
    let verdict = v.verdict.unwrap();
    assert_eq!((verdict.winner, verdict.counted, verdict.is_final), (Some(0), vec![0, 1, 2], true));
    as_("anyone.testnet", APPEAL_BOND.as_yoctonear(), judge_at() + MIN);
    assert_eq!(panics(|| c.appeal(ID.into())), "this verdict is final");
}

#[test]
fn a_drain_won_by_a_mask_that_is_no_striker_here_wins_nothing_here() {
    // KIRA won the round itself, but on this job it is the crew's scout: the job's reward goes back.
    let mut c = drain_job();
    let drained = json!({ "status": { "state": "drained", "winner": KIRA, "tx_hash": "abc" } });
    assert_eq!(round_says(&mut c, Some(drained)).verdict.unwrap().winner, None);
    let mut c = drain_job();
    let refunded = json!({ "status": { "state": "refunded" } });
    assert_eq!(round_says(&mut c, Some(refunded)).verdict.unwrap().winner, None);
    let mut c = drain_job();
    assert_eq!(round_says(&mut c, None).status, Status::Open, "no such round: nothing decided");
}

// ---------------------------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------------------------

/// The longest names, a crew of eight, four steps each of the longest content, and a verdict that counts every
/// step: the reserve the client paid covers all of it. Measured: 6452 bytes a mask, 274 bytes for the verdict.
#[test]
fn the_reserve_covers_the_biggest_masks_and_the_biggest_verdict() {
    let long = |i: usize| -> AccountId {
        let tail = ".maskwars.testnet";
        acc(&format!("{}{i:02}{tail}", "m".repeat(64 - tail.len() - 2)))
    };
    let crews = || {
        (0..2).map(move |half| CrewTicket {
            crew: format!("{}{half}", "c".repeat(31)),
            version: u32::MAX,
            members: (0..8)
                .map(|i| Member { mask: long(half * 8 + i), role: [Role::Scout, Role::Striker, Role::Verifier][i % 3] })
                .collect(),
            split: Split { scout: 3000, striker: 6000, verifier: 1000 },
        })
    };
    let salt = "s".repeat(128);
    // The longest content a mask may reveal is a drain's plan, 1024 bytes; a box for the judge is 938.
    for (kind, text) in [(Kind::Drain, true), (Kind::AiReview, false)] {
        let mut c = contract();
        let id = "j".repeat(64);
        as_(CLIENT, 2 * price(&c, 16) + 20 * ONE, 0);
        let (rubric, version, round) = match kind {
            Kind::Drain => (None, None, Some(RoundRef { bounty: acc(BOUNTY), id: "r".repeat(64) })),
            _ => (Some(RUBRIC.to_string()), Some(REVIEW_V.to_string()), None),
        };
        c.open(
            id.clone(),
            kind,
            "b".repeat(MAX_BRIEF_BYTES),
            SPEC.into(),
            rubric,
            version,
            round,
            None,
            bar_of(kind),
            U128(20 * ONE),
            U128(FUEL),
            16,
            OpenTo::Anyone,
            WORK,
            REVEAL,
            APPEAL,
            Some(U128(ONE)),
            key_of(kind),
        );
        if kind != Kind::Drain {
            pass_check(&mut c, &id, 0);
        }
        let reserve0 = c.get(id.clone()).unwrap().reserve.0;
        for ticket in crews() {
            as_(CREWS, 0, MIN);
            enlist_crew_now(&mut c, id.clone(), ticket);
        }
        let mut seqs = vec![];
        for i in 0..16 {
            let mask = long(i);
            for k in 0..MAX_STEPS {
                let content = if text {
                    format!("{i:02}{k}{}", "x".repeat(MAX_CONTENT_BYTES - 3))
                } else {
                    boxed(&format!("{i:02}{k}"))
                };
                as_(mask.as_str(), 0, 2 * MIN);
                seqs.push(c.step(id.clone(), step_hash(&id, &mask, &salt, &content)).seq);
                as_(mask.as_str(), 0, u64::from(WORK) * MIN);
                c.reveal(id.clone(), *seqs.last().unwrap(), salt.clone(), content);
            }
        }
        let used = reserve0 - c.get(id.clone()).unwrap().reserve.0;
        assert!(used <= cost_of(16 * MASK_STORAGE_BYTES), "16 masks took {} bytes", used / cost_of(1));
        if kind == Kind::Drain {
            continue;
        }
        as_("anyone.testnet", 0, judge_at());
        let _ = c.judge(id.clone());
        let before = c.get(id.clone()).unwrap().reserve.0;
        // The biggest verdict: every step named, half counted and half fake.
        let (counted, fake): (Vec<u32>, Vec<u32>) = seqs.iter().partition(|s| *s % 2 == 0);
        let r = json!({ "success": true, "output": { "job": id, "winner": 0, "counted": counted, "fake": fake }, "error": null });
        let v = answered(&mut c, &id, false, stdout(&r.to_string()), judge_at());
        assert_eq!(v.status, Status::Decided, "{:?}", get_logs());
        let verdict_bytes = ((before - v.reserve.0) / cost_of(1)) as u64;
        assert!(verdict_bytes > 0);
        // The appeal keeps the first verdict next to the second: twice the verdict and the appeal.
        assert!(2 * verdict_bytes + 200 <= JOB_GROWTH_BYTES, "a verdict of 64 steps takes {verdict_bytes} bytes");
        assert!(v.reserve.0 > 0);
    }
}

/// Every slot given back once by a mask with the longest name, then taken again by two crews of eight with the longest
/// names that seal and reveal four steps each of the longest content: the reserve holds it all, and a mask that left
/// keeps at most `LEFT_SEAT_BYTES` on the job.
#[test]
fn a_left_slot_taken_again_fits_the_reserve() {
    let named = |p: &str, i: usize| -> AccountId {
        let tail = ".maskwars.testnet";
        acc(&format!("{}{i:02}{tail}", p.repeat(64 - tail.len() - 2)))
    };
    let mut c = contract();
    let id = "j".repeat(64);
    as_(CLIENT, 2 * price(&c, 16) + 20 * ONE, 0);
    c.open(
        id.clone(),
        Kind::Drain,
        "b".repeat(MAX_BRIEF_BYTES),
        SPEC.into(),
        None,
        None,
        Some(RoundRef { bounty: acc(BOUNTY), id: "r".repeat(64) }),
        None,
        None,
        U128(20 * ONE),
        U128(FUEL),
        16,
        OpenTo::Anyone,
        WORK,
        REVEAL,
        APPEAL,
        Some(U128(ONE)),
        None,
    );
    let reserve0 = c.get(id.clone()).unwrap().reserve.0;
    let mut most = 0;
    for i in 0..16 {
        let before = c.get(id.clone()).unwrap().reserve.0;
        let mask = named("l", i);
        as_(mask.as_str(), 0, MIN);
        enlist_now(&mut c, id.clone());
        c.leave(id.clone());
        most = most.max((before - c.get(id.clone()).unwrap().reserve.0) / cost_of(1));
    }
    println!("a mask that left keeps {most} bytes");
    assert!(most as u64 <= LEFT_SEAT_BYTES, "a mask that left keeps {most} bytes");
    for half in 0..2 {
        let ticket = CrewTicket {
            crew: format!("{}{half}", "c".repeat(31)),
            version: u32::MAX,
            members: (0..8)
                .map(|i| Member {
                    mask: named("m", half * 8 + i),
                    role: [Role::Scout, Role::Striker, Role::Verifier][i % 3],
                })
                .collect(),
            split: Split { scout: 3000, striker: 6000, verifier: 1000 },
        };
        as_(CREWS, 0, MIN);
        enlist_crew_now(&mut c, id.clone(), ticket);
    }
    let salt = "s".repeat(128);
    for i in 0..16 {
        let mask = named("m", i);
        for k in 0..MAX_STEPS {
            let content = format!("{i:02}{k}{}", "x".repeat(MAX_CONTENT_BYTES - 3));
            as_(mask.as_str(), 0, 2 * MIN);
            let seq = c.step(id.clone(), step_hash(&id, &mask, &salt, &content)).seq;
            as_(mask.as_str(), 0, u64::from(WORK) * MIN);
            c.reveal(id.clone(), seq, salt.clone(), content);
        }
    }
    let v = c.get(id.clone()).unwrap();
    let used = reserve0 - v.reserve.0;
    assert_eq!((v.masks, v.left, v.entrants), (16, 16, 18));
    println!("32 seats took {} bytes of {}", used / cost_of(1), reserve0 / cost_of(1));
    assert!(used + cost_of(JOB_GROWTH_BYTES) <= reserve0, "32 seats took {} bytes", used / cost_of(1));
}

// ---------------------------------------------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn shares_follow_the_rule_and_rounding_goes_to_the_striker() {
    let m = |s: &str, r: Role| Member { mask: acc(s), role: r };
    let crew = vec![
        m("a.testnet", Role::Scout),
        m("b.testnet", Role::Scout),
        m("c.testnet", Role::Striker),
        m("d.testnet", Role::Verifier),
    ];
    let split = Split { scout: 2000, striker: 7000, verifier: 1000 };
    // Everyone counted: 20% split between two scouts, 70% to the striker, 10% to the verifier.
    let s = shares(1000, &crew, &split, &[true, true, true, true]);
    assert_eq!(s.iter().map(|x| x.1).collect::<Vec<_>>(), vec![100, 100, 700, 100]);
    // One scout did not count: the other takes the whole scout share.
    let s = shares(1000, &crew, &split, &[false, true, true, true]);
    assert_eq!(s.iter().map(|x| x.1).collect::<Vec<_>>(), vec![0, 200, 700, 100]);
    // No verifier counted: its 10% goes to the others in proportion (20:70).
    let s = shares(900, &crew, &split, &[true, true, true, false]);
    assert_eq!(s.iter().map(|x| x.1).collect::<Vec<_>>(), vec![100, 100, 700, 0]);
    // Rounding goes to the striker; nothing is lost.
    let s = shares(1001, &crew, &split, &[true, true, true, true]);
    assert_eq!(s.iter().map(|x| x.1).sum::<u128>(), 1001);
    assert_eq!(s[2].1, 701);
    // Solo.
    let s = shares(5, &[m("o.testnet", Role::Striker)], &Split::SOLO, &[true]);
    assert_eq!(s, vec![(acc("o.testnet"), 5)]);
}

#[test]
fn a_split_pays_every_role_in_the_crew_and_no_role_outside_it() {
    let m = |s: &str, r: Role| Member { mask: acc(s), role: r };
    let duo = vec![m("a.testnet", Role::Scout), m("b.testnet", Role::Striker)];
    assert!(split_ok(&Split { scout: 1, striker: 9999, verifier: 0 }, &duo));
    assert!(!split_ok(&Split { scout: 0, striker: 10_000, verifier: 0 }, &duo), "the scout would work for nothing");
    assert!(!split_ok(&Split { scout: 1000, striker: 8000, verifier: 1000 }, &duo), "nobody verifies");
    assert!(!split_ok(&Split { scout: 5000, striker: 5001, verifier: 0 }, &duo));
    let no_striker = vec![m("a.testnet", Role::Scout), m("b.testnet", Role::Verifier)];
    assert!(!split_ok(&Split { scout: 5000, striker: 0, verifier: 5000 }, &no_striker));
}

#[test]
fn a_factory_mask_is_a_direct_sub_account_of_its_factory() {
    let f = acc(FACTORY);
    assert!(direct_sub(&acc(KIRA), &f));
    assert!(!direct_sub(&acc("a.kira.masks.maskwars.testnet"), &f));
    assert!(!direct_sub(&acc("xmasks.maskwars.testnet"), &f));
    assert!(!direct_sub(&acc(FACTORY), &f));
}

// ---------------------------------------------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------------------------------------------

#[test]
fn new_code_waits_out_every_live_job_and_no_job_opens_meanwhile() {
    let mut c = opened();
    as_(CLIENT, 0, MIN);
    assert_eq!(panics(|| c.propose(Change::Code { sha256: "a".repeat(64) })), "only the admin proposes changes");
    as_(ADMIN, 0, MIN);
    let p = c.propose(Change::Code { sha256: "a".repeat(64) });
    assert_eq!(p.ready_ns.0, MIN + CHANGE_DELAY_HOURS * HOUR);
    const { assert!(CHANGE_DELAY_HOURS >= MAX_JOB_HOURS + 24) };
    // The longest job decides within MAX_JOB_HOURS: the check, the longest windows, the time to judge, the longest
    // appeal window and the time its runs may take. New code waits that and a day: a week.
    assert_eq!(
        CHECK_HOURS * HOUR
            + u64::from(MAX_WORK_MINUTES) * MIN
            + 24 * HOUR
            + JUDGE_GRACE_HOURS * HOUR
            + 24 * HOUR
            + APPEAL_GRACE_HOURS * HOUR,
        MAX_JOB_HOURS * HOUR
    );
    assert_eq!(CHANGE_DELAY_HOURS, 7 * 24);
    let q = price(&c, 4);
    as_(CLIENT, q, 2 * MIN);
    let got = panics(|| {
        c.open(
            "job-2".into(),
            Kind::AiReview,
            "x".into(),
            SPEC.into(),
            Some(RUBRIC.into()),
            Some(REVIEW_V.into()),
            None,
            None,
            bar_of(Kind::AiReview),
            U128(REWARD),
            U128(FUEL),
            4,
            OpenTo::Anyone,
            WORK,
            REVEAL,
            APPEAL,
            None,
            Some(CLIENT_KEY.into()),
        )
    });
    assert!(got.contains("new code is waiting"), "{got}");
    as_("anyone.testnet", 0, p.ready_ns.0 - 1);
    assert_eq!(panics(|| c.upgrade()), "the change is still waiting");

    // With no job live it waits an hour.
    let mut c = contract();
    as_(ADMIN, 0, MIN);
    assert_eq!(c.propose(Change::Code { sha256: "a".repeat(64) }).ready_ns.0, MIN + CHANGE_NOTICE_HOURS * HOUR);
}

#[test]
fn a_new_judge_applies_to_new_jobs_only() {
    let mut c = opened();
    let other = "9".repeat(64);
    as_(ADMIN, 0, MIN);
    c.propose(Change::Judge {
        judge: Judge {
            kind: Kind::AiReview,
            project: "maskwars.testnet/review".into(),
            version: other.clone(),
            key: REVIEW_KEY.into(),
        },
    });
    as_("anyone.testnet", 0, MIN + HOUR - 1);
    assert_eq!(panics(|| c.apply()), "the change is still waiting");
    as_("anyone.testnet", 0, MIN + HOUR);
    c.apply();
    assert_eq!(c.get(ID.into()).unwrap().terms.judge.unwrap().version, REVIEW_V, "the open job keeps its judge");
    // A client who still names the old judge opens nothing.
    let q = price(&c, 4);
    as_(CLIENT, q, MIN + HOUR);
    let got = panics(|| {
        c.open(
            "job-2".into(),
            Kind::AiReview,
            "x".into(),
            SPEC.into(),
            Some(RUBRIC.into()),
            Some(REVIEW_V.into()),
            None,
            None,
            bar_of(Kind::AiReview),
            U128(REWARD),
            U128(FUEL),
            4,
            OpenTo::Anyone,
            WORK,
            REVEAL,
            APPEAL,
            None,
            Some(CLIENT_KEY.into()),
        )
    });
    assert!(got.contains("judge_version"), "{got}");
    // A judge for a drain, or two for one kind, is refused.
    as_(ADMIN, 0, 2 * HOUR);
    let bad =
        Judge { kind: Kind::Drain, project: "maskwars.testnet/drain".into(), version: other, key: REVIEW_KEY.into() };
    assert_eq!(panics(|| c.propose(Change::Judge { judge: bad })), "judge: a project and a sha256");
    assert!(!judges_ok(&[judges()[0].clone(), judges()[0].clone()]));
}

#[test]
fn the_fee_meter_and_treasury_a_job_opened_with_are_the_ones_it_pays() {
    let mut c = worked();
    as_(ADMIN, 0, 10 * MIN);
    c.propose(Change::Treasury { account: acc("thief.testnet") });
    as_("anyone.testnet", 0, 10 * MIN + HOUR);
    c.apply();
    as_(ADMIN, 0, 10 * MIN + HOUR);
    c.propose(Change::Fee { bps: 1000, to: acc("thief.testnet") });
    as_("anyone.testnet", 0, 10 * MIN + 2 * HOUR);
    c.apply();
    as_(ADMIN, 0, 10 * MIN + 2 * HOUR);
    assert_eq!(panics(|| c.propose(Change::Fee { bps: 1001, to: acc(COMPANY) })), "fee: at most 10%");
    let t = 10 * MIN + 2 * HOUR;
    as_("anyone.testnet", 0, t);
    let _ = c.judge(ID.into());
    answered(&mut c, ID, false, stdout(&reply(Some(0), &[0, 1, 2])), t);
    as_("anyone.testnet", 0, t + u64::from(APPEAL) * MIN);
    c.settle(ID.into());
    assert_eq!(paid_to("thief.testnet"), 0);
    assert_eq!(paid_to(TREASURY), 120 * MILLI);
    assert_eq!(paid_to(COMPANY), REWARD * 500 / 10_000);
}

/// NEAR attached where nothing needs it does not stay on the contract without an owner: a judge run the job's own
/// runs pay for, and reading a drain's round, give it back to whoever attached it.
#[test]
fn near_attached_where_nothing_needs_it_goes_back() {
    let mut c = worked();
    as_("anyone.testnet", JUDGE_FEE.as_yoctonear(), judge_at());
    let _ = c.judge(ID.into());
    assert_eq!(transfers(), vec![("anyone.testnet".to_string(), JUDGE_FEE.as_yoctonear())]);
    assert_eq!(c.get(ID.into()).unwrap().judge_budget.0, JUDGE_FEE.as_yoctonear() * (RUNS_LEFT - 1));

    let mut c = drain_job();
    as_("anyone.testnet", 7, judge_at());
    let _ = c.judge(ID.into());
    assert_eq!(transfers(), vec![("anyone.testnet".to_string(), 7)]);
    assert_eq!(c.get(ID.into()).unwrap().judge_budget.0, JUDGE_FEE.as_yoctonear() * JUDGE_RUNS, "a round costs no run");
}

// ---------------------------------------------------------------------------------------------------------------
// The independent review's findings, each as an attack
// ---------------------------------------------------------------------------------------------------------------

fn open_tests(c: &mut Jobs, id: &str, secrets: Option<SecretsRef>) -> String {
    as_(CLIENT, price(c, 2), 0);
    panics(|| {
        c.open(
            id.into(),
            Kind::TeeTests,
            "Pass the private benchmark".into(),
            SPEC.into(),
            Some(RUBRIC.into()),
            Some(TESTS_V.into()),
            None,
            secrets,
            bar_of(Kind::TeeTests),
            U128(REWARD),
            U128(FUEL),
            2,
            OpenTo::Anyone,
            WORK,
            REVEAL,
            APPEAL,
            None,
            Some(CLIENT_KEY.into()),
        )
    })
}

/// A client names another client's private test set: it would read B's set as an oracle through its own job.
#[test]
fn a_job_reads_only_its_own_client_s_secrets() {
    let mut c = contract();
    let other = SecretsRef { profile: "bench".into(), account_id: acc("rival-lab.testnet") };
    assert!(open_tests(&mut c, "tests-1", Some(other)).contains("only the client's own"));
    let long = SecretsRef { profile: "p".repeat(65), account_id: acc(CLIENT) };
    assert!(open_tests(&mut c, "tests-1", Some(long)).contains("secrets profile"));
    // Its own: opens.
    as_(CLIENT, price(&c, 2), 0);
    let v = c.open(
        "tests-1".into(),
        Kind::TeeTests,
        "Pass the private benchmark".into(),
        SPEC.into(),
        Some(RUBRIC.into()),
        Some(TESTS_V.into()),
        None,
        Some(SecretsRef { profile: "bench".into(), account_id: acc(CLIENT) }),
        bar_of(Kind::TeeTests),
        U128(REWARD),
        U128(FUEL),
        2,
        OpenTo::Anyone,
        WORK,
        REVEAL,
        APPEAL,
        None,
        Some(CLIENT_KEY.into()),
    );
    assert_eq!(v.terms.secrets.unwrap().account_id, acc(CLIENT));
}

/// A squatter on every job: one mask is on at most four live jobs at once, and a job's end frees it.
#[test]
fn a_mask_is_on_at_most_four_live_jobs_and_a_job_s_end_frees_it() {
    let mut c = contract();
    for i in 0..5 {
        open_with(&mut c, &format!("job-{i}"), Kind::AiReview, 2, OpenTo::Anyone, 0);
    }
    for i in 0..4 {
        as_(ONYX, 0, MIN);
        enlist_now(&mut c, format!("job-{i}"));
    }
    as_(ONYX, 0, MIN);
    assert_eq!(panics(|| enlist_now(&mut c, "job-4".into())), "a mask is on at most 4 live jobs at once");
    // job-0 ends with nothing revealed: ONYX is free for one more.
    as_("anyone.testnet", 0, judge_at());
    c.close("job-0".into());
    assert!(!c.live_of.contains_key(&acc(ONYX)) || c.live_of[&acc(ONYX)] == 3);
    open_with(&mut c, "job-5", Kind::AiReview, 2, OpenTo::Anyone, judge_at());
    as_(ONYX, 0, judge_at() + MIN);
    assert_eq!(enlist_now(&mut c, "job-5".into()), 0);
    assert_eq!(c.live_of[&acc(ONYX)], 4);
}

/// The round paid NOVA, but NOVA revealed nothing on this job: nobody here is paid, so the company takes nothing.
#[test]
fn a_drain_won_by_a_striker_who_revealed_nothing_here_pays_no_fee() {
    let mut c = contract();
    open_with(&mut c, ID, Kind::Drain, 4, OpenTo::Anyone, 0);
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    as_(ONYX, 0, MIN);
    enlist_now(&mut c, ID.into());
    // Only ONYX reveals a strike; NOVA sealed nothing.
    let s = seal(&mut c, ID, ONYX, "plan b", 2 * MIN);
    open_up(&mut c, ID, ONYX, s, "plan b", u64::from(WORK) * MIN);
    let drained = json!({ "status": { "state": "drained", "winner": NOVA, "tx_hash": "abc" } });
    let v = round_says(&mut c, Some(drained));
    assert_eq!(v.verdict.unwrap().winner, None);
    as_("anyone.testnet", 0, judge_at() + MIN);
    c.settle(ID.into());
    assert_eq!(settled()["fee"], "0", "no fee: nobody here is paid");
    assert_eq!(paid_to(NOVA), 0);
    // KIRA and NOVA held their slots and revealed nothing here: half of each bond is the company's.
    assert_eq!(paid_to(COMPANY), 2 * idle_part(FUEL));
    assert_eq!(paid_to(BACKER), 3 * FUEL - 2 * idle_part(FUEL));
}

/// The biggest record a client can open: `quote` is a ceiling, so paying exactly what it says always opens.
#[test]
fn the_quote_covers_the_biggest_record() {
    let mut c = contract();
    let long = |i: usize| -> AccountId { acc(&format!("{}{i:02}.maskwars.testnet", "m".repeat(64 - 17 - 2))) };
    let client = format!("{}.testnet", "c".repeat(64 - 8));
    let total = c.quote(U128(REWARD), U128(FUEL), 16).total.0;
    as_(&client, total, 0);
    let before = env::storage_usage();
    c.open(
        "j".repeat(64),
        Kind::TeeTests,
        "b".repeat(MAX_BRIEF_BYTES),
        SPEC.into(),
        Some(RUBRIC.into()),
        Some(TESTS_V.into()),
        None,
        Some(SecretsRef { profile: "p".repeat(64), account_id: acc(&client) }),
        Some(Bar { win_at: 64, cases: Some(64), fuel: Some(U64(u64::MAX)), reference: Some(reference()) }),
        U128(REWARD),
        U128(FUEL),
        16,
        OpenTo::Masks { masks: (0..16).map(long).collect() },
        WORK,
        REVEAL,
        APPEAL,
        None,
        Some(CLIENT_KEY.into()),
    );
    let record = env::storage_usage() - before;
    assert!(record <= JOB_RECORD_BYTES, "the biggest record takes {record} bytes");
    assert!(transfers().is_empty() || transfers()[0].0 == client);
}

/// An appeal's record is paid from the job's reserve; NEAR attached over a judge run's fee goes back.
#[test]
fn an_appeal_pays_its_storage_and_overpaying_a_run_gets_the_rest_back() {
    let mut c = judged(Some(0), &[0, 1, 2]);
    let before = c.get(ID.into()).unwrap().reserve.0;
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    assert!(c.get(ID.into()).unwrap().reserve.0 < before, "the appeal's record comes out of the reserve");

    let mut c = worked();
    for i in 0..RUNS_LEFT {
        as_("anyone.testnet", 0, judge_at() + i as u64);
        let _ = c.judge(ID.into());
        answered(&mut c, ID, false, PromiseResult::Failed, judge_at() + i as u64);
    }
    as_("anyone.testnet", 50 * MILLI, judge_at() + MIN);
    let _ = c.judge(ID.into());
    assert_eq!(transfers(), vec![("anyone.testnet".to_string(), 40 * MILLI)]);
}

/// A captain cannot lock a mask's places: a mask leaves a job before it seals a step, while the work window is open,
/// frees its slot on the job and its place among its live jobs, and never comes back to that job; its crew's win pays
/// it nothing.
#[test]
fn a_mask_leaves_a_job_before_its_first_step_and_frees_its_place() {
    let mut c = opened();
    as_(CREWS, 0, MIN);
    enlist_crew_now(&mut c, ID.into(), duo());
    assert_eq!(c.live_of[&acc(KIRA)], 1);
    as_(METER, 0, MIN);
    c.burn(ID.into(), acc(KIRA), U128(10 * MILLI));
    as_(KIRA, 0, 2 * MIN);
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    let v = c.leave(ID.into());
    assert_eq!((v.masks, v.left), (1, 1), "KIRA's slot is free for another mask");
    assert!(v.reserve.0 > reserve, "the storage of KIRA's place goes back to the reserve");
    let lost = held_cost(FUEL, MIN, 2 * MIN, u64::from(WORK) * MIN);
    assert_eq!(transfers(), vec![(BACKER.to_string(), FUEL - lost), (COMPANY.to_string(), lost)]);
    assert!(!c.live_of.contains_key(&acc(KIRA)), "KIRA's place is free for another job");
    assert_eq!(panics(|| c.leave(ID.into())), "this mask left the job");
    assert_eq!(panics(|| enlist_now(&mut c, ID.into())), "a mask is on a job once");
    let h = step_hash(ID, &acc(KIRA), &salt_of(KIRA), "x");
    assert_eq!(panics(|| c.step(ID.into(), h)), "this mask left the job");
    as_(METER, 0, 2 * MIN);
    assert_eq!(panics(|| c.burn(ID.into(), acc(KIRA), U128(1))), "this mask left the job");
    // NOVA works and the crew wins: the whole net reward goes to NOVA.
    let n = seal(&mut c, ID, NOVA, "review", 3 * MIN);
    as_(NOVA, 0, 3 * MIN);
    assert_eq!(panics(|| c.leave(ID.into())), "a mask that sealed a step stays to the end");
    open_up(&mut c, ID, NOVA, n, "review", u64::from(WORK) * MIN);
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let r = json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [n] }, "error": null });
    answered(&mut c, ID, false, stdout(&r.to_string()), judge_at());
    as_("anyone.testnet", 0, settle_at());
    c.settle(ID.into());
    assert_eq!(paid_to(KIRA), 0);
    assert_eq!(paid_to(NOVA), REWARD - REWARD * 500 / 10_000);
    assert_eq!(paid_to(TREASURY), 0, "KIRA's burned fuel is its own tank's; NOVA burned none");
    assert!(!c.live_of.contains_key(&acc(KIRA)) && !c.live_of.contains_key(&acc(NOVA)), "both masks are free");
}

/// The heaviest payout a job can make: sixteen masks took every slot and left, then a crew of eight wins over eight
/// solo masks, sixty-four steps of the longest content and thirty-two seats are cleared. It fits well inside
/// `MIN_SETTLE_GAS`: measured, 27 TGas of host work and receipts.
#[test]
fn the_heaviest_settle_fits_its_gas() {
    let mut c = contract();
    let long = |i: usize| -> AccountId { acc(&format!("{}{i:02}.maskwars.testnet", "m".repeat(64 - 17 - 2))) };
    as_(CLIENT, price(&c, 16) + 20 * ONE, 0);
    c.open(
        ID.into(),
        Kind::AiReview,
        "Review".into(),
        SPEC.into(),
        Some(RUBRIC.into()),
        Some(REVIEW_V.into()),
        None,
        None,
        bar_of(Kind::AiReview),
        U128(20 * ONE),
        U128(FUEL),
        16,
        OpenTo::Anyone,
        WORK,
        REVEAL,
        APPEAL,
        None,
        Some(CLIENT_KEY.into()),
    );
    pass_check(&mut c, ID, 0);
    for i in 0..16 {
        let mask = format!("{}{i:02}.maskwars.testnet", "l".repeat(64 - 17 - 2));
        as_(&mask, 0, MIN);
        enlist_now(&mut c, ID.into());
        c.leave(ID.into());
    }
    let ticket = CrewTicket {
        crew: "octet".into(),
        version: 1,
        members: (0..8)
            .map(|i| Member { mask: long(i), role: [Role::Scout, Role::Striker, Role::Verifier][i % 3] })
            .collect(),
        split: Split { scout: 3000, striker: 6000, verifier: 1000 },
    };
    // Every mask's bond locked by someone else: sixteen bonds go back to sixteen accounts.
    for i in 0..16 {
        as_(&format!("backer-{i:02}.testnet"), FUEL + ONE, MIN);
        c.bond(ID.into(), long(i));
    }
    as_(CREWS, 0, MIN);
    c.enlist_crew(ID.into(), ticket);
    for i in 8..16 {
        as_(long(i).as_str(), 0, MIN);
        c.enlist(ID.into());
    }
    let salt = "s".repeat(128);
    let mut seqs = vec![];
    for i in 0..16 {
        for k in 0..MAX_STEPS {
            let content = boxed(&format!("{i:02}{k}"));
            as_(long(i).as_str(), 0, 2 * MIN);
            seqs.push(c.step(ID.into(), step_hash(ID, &long(i), &salt, &content)).seq);
            as_(long(i).as_str(), 0, u64::from(WORK) * MIN);
            c.reveal(ID.into(), *seqs.last().unwrap(), salt.clone(), content);
        }
        as_(METER, 0, 3 * MIN);
        c.burn(ID.into(), long(i), U128(FUEL));
    }
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    // The sixteen that left are entrants 0 to 15; the crew is 16.
    let r = json!({ "success": true, "output": { "job": ID, "winner": 16, "counted": seqs }, "error": null });
    answered(&mut c, ID, false, stdout(&r.to_string()), judge_at());
    as_("anyone.testnet", 0, settle_at());
    c.settle(ID.into());
    let used = env::used_gas().as_tgas();
    println!("the heaviest settle: {used} TGas");
    assert_eq!(transfers().iter().filter(|(to, _)| to.starts_with('m')).count(), 8, "the crew of eight is paid");
    assert_eq!(transfers().iter().filter(|(to, _)| to.starts_with("backer-")).count(), 16, "every bond goes back");
    assert!(used < 50, "the heaviest settle takes {used} TGas of host work and receipts");
    assert!(MIN_SETTLE_GAS.as_tgas() >= 4 * used);
}

/// A mask that leaves gives its slot back, so leaving is never squatting. But a job gives slots back at most `slots`
/// times: enlisting and leaving in a loop never grows it past twice its masks (the first review's H3), and after that a
/// mask on it stays to the end. The reserve holds it all, and cancelling pays no fuel for masks that left.
#[test]
fn leaving_gives_the_slot_back_but_never_grows_a_job_past_twice_its_slots() {
    let mut c = contract();
    open_with(&mut c, ID, Kind::AiReview, 2, OpenTo::Anyone, 0);
    for m in ["a1.testnet", "a2.testnet"] {
        as_(m, 0, MIN);
        enlist_now(&mut c, ID.into());
        as_(METER, 0, MIN);
        c.burn(ID.into(), acc(m), U128(FUEL));
        as_(m, 0, MIN);
        let v = c.leave(ID.into());
        assert_eq!(v.masks, 0, "the slot is free again");
        assert_eq!(transfers(), vec![(BACKER.to_string(), FUEL)], "leaving at once costs nothing");
    }
    // Two slots, given back twice: the next two masks take them and stay.
    for m in ["a3.testnet", "a4.testnet"] {
        as_(m, 0, 2 * MIN);
        enlist_now(&mut c, ID.into());
    }
    as_("a5.testnet", 0, 2 * MIN);
    assert_eq!(panics(|| enlist_now(&mut c, ID.into())), "the job has no slot left for this many masks");
    as_("a3.testnet", 0, 3 * MIN);
    assert_eq!(
        panics(|| c.leave(ID.into())),
        "this job gave its slots back as many times as it has slots: a mask on it stays to the end"
    );
    let v = c.get(ID.into()).unwrap();
    assert_eq!((v.masks, v.left, v.entrants), (2, 2, 4), "never more than twice its masks");
    as_(CLIENT, 0, 3 * MIN);
    let reserve = c.get(ID.into()).unwrap().reserve.0;
    c.cancel(ID.into());
    assert_eq!(paid_to(TREASURY), 0, "the masks that left pay their own fuel");
    assert_eq!(paid_to(BACKER), 2 * FUEL, "a cancelled job takes nothing of a bond: nobody could work yet");
    client_got(REWARD + 2 * FUEL + JUDGE_FEE.as_yoctonear() * RUNS_LEFT + reserve, reserve, 2);
}

/// Third review, finding 6: bonds did not deter squatting. A squatter took a slot and left with its whole bond while
/// the slot stayed taken, or sat on it to the end and got it all back. Now leaving gives the slot back and costs the
/// share of the window it held, so leaving at the last minute costs nearly what sitting to the end costs: half the
/// bond, to the company, for a seat with no revealed step of its own.
#[test]
fn a_squatter_pays_for_the_slot_it_holds() {
    const SQUAT: &str = "squat.maskwars.testnet";
    let mut c = contract();
    open_with(&mut c, ID, Kind::AiReview, 2, OpenTo::Anyone, 0);
    as_(SQUAT, 0, 0);
    assert_eq!(enlist_now(&mut c, ID.into()), 0);
    as_(ONYX, 0, 0);
    assert_eq!(enlist_now(&mut c, ID.into()), 1);
    as_(NOVA, 0, MIN);
    assert_eq!(panics(|| enlist_now(&mut c, ID.into())), "the job has no slot left for this many masks");
    // SQUAT held its slot all but the last minute of the window and leaves: the slot comes back, at 29/30 of half its
    // bond.
    let end = u64::from(WORK) * MIN;
    as_(SQUAT, 0, end - MIN);
    c.leave(ID.into());
    let lost = held_cost(FUEL, 0, end - MIN, end);
    assert_eq!(lost, idle_part(FUEL) * 29 / 30);
    assert_eq!(transfers(), vec![(BACKER.to_string(), FUEL - lost), (COMPANY.to_string(), lost)]);
    as_(SQUAT, 0, end);
    assert_eq!(panics(|| c.leave(ID.into())), "the work window is over: a mask on the job stays to the end");
    // NOVA takes the slot back in time, seals and reveals; ONYX sits to the end and reveals nothing.
    as_(NOVA, 0, end - MIN);
    assert_eq!(enlist_now(&mut c, ID.into()), 2);
    let n = seal(&mut c, ID, NOVA, "review: the quorum bug", end - MIN);
    open_up(&mut c, ID, NOVA, n, "review: the quorum bug", end);
    as_(ONYX, 0, end);
    assert_eq!(panics(|| c.leave(ID.into())), "the work window is over: a mask on the job stays to the end");
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    let r = json!({ "success": true, "output": { "job": ID, "winner": 2, "counted": [n] }, "error": null });
    answered(&mut c, ID, false, stdout(&r.to_string()), judge_at());
    as_("anyone.testnet", 0, settle_at());
    assert_eq!(c.settle(ID.into()).status, Status::Paid { winner: 2 });
    let fee = REWARD * 500 / 10_000;
    assert_eq!(paid_to(NOVA), REWARD - fee);
    assert_eq!(paid_to(COMPANY), fee + idle_part(FUEL), "ONYX's idle seat: half its bond to the company");
    assert_eq!(paid_to(BACKER), FUEL + FUEL - idle_part(FUEL), "NOVA's bond, and the other half of ONYX's");
    let onyx = settled()["bonds"].as_array().unwrap().iter().find(|b| b["mask"] == ONYX).cloned().unwrap();
    assert_eq!((onyx["why"].as_str(), yocto_of(&onyx["lost"])), (Some("idle"), idle_part(FUEL)));
}

// ---------------------------------------------------------------------------------------------------------------
// The fourth review's findings, each as an attack
// ---------------------------------------------------------------------------------------------------------------

/// Fourth review, finding 1: fifteen puppets take fifteen of sixteen slots and each reveals work that counts for nothing:
/// a module that loads and passes no case of the private set, or a bland review the model scores zero on two seeds.
/// The judge rightly calls none of it fake: fake is only objectively no work. Before, a revealed step was all a seat
/// needed to get its whole bond back, so the slots were free to hold. Now a seat with no counted step pays half its
/// bond to the company, whatever it revealed.
#[test]
fn fifteen_puppets_whose_work_counts_for_nothing_pay_half_their_bonds() {
    const JOB: &str = "bench-0016";
    let mut c = contract();
    open_with(&mut c, JOB, Kind::TeeTests, MAX_SLOTS, OpenTo::Anyone, 0);
    as_(NOVA, 0, MIN);
    assert_eq!(enlist_now(&mut c, JOB.into()), 0);
    let puppets: Vec<String> = (0..15).map(|i| format!("puppet{i:02}.maskwars.testnet")).collect();
    for (i, p) in puppets.iter().enumerate() {
        as_(p, 0, MIN);
        assert_eq!(enlist_now(&mut c, JOB.into()), i as u32 + 1);
    }
    as_(ONYX, 0, MIN);
    assert_eq!(panics(|| enlist_now(&mut c, JOB.into())), "the job has no slot left for this many masks");
    // NOVA seals its work first; every puppet seals a module that loads and passes nothing.
    assert_eq!(seal(&mut c, JOB, NOVA, "module: reverse, 12 of 12", 2 * MIN), 0);
    for (i, p) in puppets.iter().enumerate() {
        assert_eq!(seal(&mut c, JOB, p, &format!("module: returns nothing #{i}"), 2 * MIN), i as u32 + 1);
    }
    let after = u64::from(WORK) * MIN;
    open_up(&mut c, JOB, NOVA, 0, "module: reverse, 12 of 12", after);
    for (i, p) in puppets.iter().enumerate() {
        open_up(&mut c, JOB, p, i as u32 + 1, &format!("module: returns nothing #{i}"), after);
    }
    // The judge: NOVA passes 12 of 12 and wins; every puppet's module loads and passes no case, so it is neither counted
    // nor fake.
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(JOB.into());
    let out =
        json!({ "success": true, "output": { "job": JOB, "winner": 0, "counted": [0], "fake": [] }, "error": null });
    assert_eq!(answered(&mut c, JOB, false, stdout(&out.to_string()), judge_at()).status, Status::Decided);
    as_("anyone.testnet", 0, settle_at());
    assert_eq!(c.settle(JOB.into()).status, Status::Paid { winner: 0 });
    let fee = REWARD * 500 / 10_000;
    assert_eq!(paid_to(NOVA), REWARD - fee);
    assert_eq!(paid_to(COMPANY), fee + 15 * idle_part(FUEL), "every puppet's seat costs half its bond");
    assert_eq!(paid_to(BACKER), FUEL + 15 * (FUEL - idle_part(FUEL)), "NOVA's bond whole, the puppets' other halves");
    let bonds = settled()["bonds"].as_array().unwrap().clone();
    for p in &puppets {
        let b = bonds.iter().find(|b| b["mask"] == p.as_str()).unwrap();
        assert_eq!((b["why"].as_str(), yocto_of(&b["lost"])), (Some("idle"), idle_part(FUEL)), "{p}");
    }
    let nova = bonds.iter().find(|b| b["mask"] == NOVA).unwrap();
    assert_eq!((nova["why"].clone(), yocto_of(&nova["lost"])), (Value::Null, 0));
}

/// A judge's answer that failed for an outage: what it said of itself, and its run's number of NEAR AI calls.
fn outage(job: &str, retry_at: u64, asked: u32) -> PromiseResult {
    stdout(
        &json!({ "success": false, "error": "1 of 3 entrants still wait for an answer; the next run asks again",
                 "output": { "job": job, "retry_at": retry_at.to_string(), "asked": asked } })
        .to_string(),
    )
}

/// Fourth review, finding 3: while NEAR AI is down the review judge cannot finish, and a run during its back-off calls
/// nothing at all. Every run was still paid from the job's runs and then from the appeal's held bond: anyone could burn
/// the appellant's 0.2 NEAR with twenty runs that call nothing. Now the judge says when a run can make progress again
/// (`retry_at`) and the contract asks no run before it; and once the job's runs are spent, whoever asks a run fronts
/// it, and the held bond pays it back only if the run called NEAR AI.
#[test]
fn runs_during_an_outage_never_burn_the_appeal_s_bond() {
    const GRIEFER: &str = "griefer.testnet";
    let mut c = judged(Some(0), &[0, 1, 2]);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    let mut t = judge_at() + 3 * MIN;
    // NEAR AI is down: the appeal's first run tried twice and backs off two minutes.
    let v = answered(&mut c, ID, true, outage(ID, t + 2 * MIN, 2), t);
    assert_eq!((v.status, v.retry_at.0), (Status::Appealing, t + 2 * MIN));
    // A griefer runs the judge again and again at once: every run is refused until the back-off is over.
    for i in 0..20 {
        as_(GRIEFER, 0, t + i);
        assert_eq!(
            panics(|| c.judge(ID.into())),
            format!("the judge asked to be run again from {}: until then a run would call nothing", t + 2 * MIN)
        );
    }
    // After it, runs go on, each waiting out the judge's next back-off, until the job's runs are spent.
    while c.get(ID.into()).unwrap().judge_budget.0 > 0 {
        t = c.get(ID.into()).unwrap().retry_at.0;
        as_(GRIEFER, 0, t);
        let _ = c.judge(ID.into());
        answered(&mut c, ID, true, outage(ID, t + 4 * MIN, 1), t);
    }
    assert_eq!(c.get(ID.into()).unwrap().appeal.unwrap().bond.0, APPEAL_BOND.as_yoctonear(), "the job's runs paid");
    // Now the griefer must front a run; a run that called nothing (the RPC sources disagreed) costs the bond nothing.
    t = c.get(ID.into()).unwrap().retry_at.0;
    as_(GRIEFER, 0, t);
    assert_eq!(panics(|| c.judge(ID.into())), "the job's judge runs are spent: attach 0.01 NEAR");
    as_(GRIEFER, JUDGE_FEE.as_yoctonear(), t);
    let _ = c.judge(ID.into());
    let none = json!({ "success": false, "error": "the RPC sources disagree", "output": { "job": ID } }).to_string();
    let v = answered(&mut c, ID, true, stdout(&none), t);
    assert_eq!((v.status, v.retry_at.0), (Status::Appealing, 0));
    assert_eq!(v.appeal.unwrap().bond.0, APPEAL_BOND.as_yoctonear(), "a run that called nothing never costs the bond");
    assert!(transfers().is_empty());
    // A failed promise, or a run nobody heard from, says nothing either.
    as_(GRIEFER, JUDGE_FEE.as_yoctonear(), t);
    let _ = c.judge(ID.into());
    let v = answered(&mut c, ID, true, PromiseResult::Failed, t);
    assert_eq!(v.appeal.unwrap().bond.0, APPEAL_BOND.as_yoctonear());
    // A run that called NEAR AI is the appeal's own work: the bond pays the one who fronted it back.
    as_("nova-owner.testnet", JUDGE_FEE.as_yoctonear(), t);
    let _ = c.judge(ID.into());
    let v = answered(&mut c, ID, true, outage(ID, t + 8 * MIN, 1), t);
    let held = APPEAL_BOND.as_yoctonear() - JUDGE_FEE.as_yoctonear();
    assert_eq!(v.appeal.unwrap().bond.0, held);
    assert_eq!(transfers(), vec![("nova-owner.testnet".to_string(), JUDGE_FEE.as_yoctonear())]);
    // A judge's back-off holds runs back an hour at most.
    as_("nova-owner.testnet", JUDGE_FEE.as_yoctonear(), t + 8 * MIN);
    let _ = c.judge(ID.into());
    let v = answered(&mut c, ID, true, outage(ID, t + 30 * HOUR, 0), t + 8 * MIN);
    assert_eq!(v.retry_at.0, t + 8 * MIN + MAX_RETRY_WAIT_MINUTES * MIN);
    // The appeal that never got its answer lapses at its deadline: the bond, less the one run that called NEAR AI,
    // goes back to ONYX.
    as_("anyone.testnet", 0, settle_at() + APPEAL_GRACE_HOURS * HOUR);
    assert_eq!(c.settle(ID.into()).status, Status::Paid { winner: 0 });
    assert_eq!(paid_to(ONYX), held);
}

/// The same back-off holds the check and a first verdict back, so nobody spends the client's runs on runs that would
/// call nothing; and an appeal that finds the job's runs spent attaches its own run on top of the bond.
#[test]
fn the_judge_s_back_off_holds_every_run_back() {
    let mut c = contract();
    open_unchecked(&mut c, ID, Kind::AiReview, 4, OpenTo::Anyone, 0);
    as_("anyone.testnet", 0, MIN);
    let _ = c.check(ID.into());
    let v = answered(&mut c, ID, false, outage(ID, 4 * MIN, 1), MIN);
    assert_eq!((v.status, v.checked, v.retry_at.0), (Status::Open, false, 4 * MIN));
    as_("anyone.testnet", 0, 3 * MIN);
    assert!(panics(|| c.check(ID.into())).starts_with("the judge asked to be run again from"));
    let v = pass_check(&mut c, ID, 4 * MIN);
    assert_eq!(v.retry_at.0, 0);

    let mut c = worked();
    as_("anyone.testnet", 0, judge_at());
    let _ = c.judge(ID.into());
    answered(&mut c, ID, false, outage(ID, judge_at() + MIN, 2), judge_at());
    as_("anyone.testnet", 0, judge_at() + MIN - 1);
    assert!(panics(|| c.judge(ID.into())).starts_with("the judge asked to be run again from"));
    as_("anyone.testnet", 0, judge_at() + MIN);
    let _ = c.judge(ID.into());
    let r = json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [0, 1, 2], "asked": 1 }, "error": null });
    let v = answered(&mut c, ID, false, stdout(&r.to_string()), judge_at() + 2 * MIN);
    assert_eq!((v.status, v.retry_at.0), (Status::Decided, 0));
    assert!(transfers().is_empty(), "a first verdict's runs are the job's: nobody fronted, nothing to pay back");
    // Spend the job's runs; the appeal then attaches its run on top of its bond.
    let mut job = c.jobs.get(ID).cloned().unwrap();
    job.judge_budget = 0;
    c.jobs.insert(ID.into(), job);
    as_(ONYX, APPEAL_BOND.as_yoctonear(), judge_at() + 3 * MIN);
    assert_eq!(
        panics(|| c.appeal(ID.into())),
        "the job's judge runs are spent: an appeal locks 0.2 NEAR and attaches 0.01 NEAR for its run"
    );
    as_(ONYX, APPEAL_BOND.as_yoctonear() + JUDGE_FEE.as_yoctonear(), judge_at() + 3 * MIN);
    let _ = c.appeal(ID.into());
    assert_eq!(c.get(ID.into()).unwrap().appeal.unwrap().bond.0, APPEAL_BOND.as_yoctonear());
}

/// Fourth review, finding 5: on `ai_review` a model's runs differ a little, so an appeal's second verdict often calls
/// one more step fake than the first. That alone gave the appeal's bond back, as if the appeal had changed something:
/// an appeal was nearly free. Now the bond comes back only when the winner or equal parts changed, or a step is no
/// longer called fake; an appeal that only finds more fake steps upholds the verdict, and its bond goes to the
/// company.
#[test]
fn an_appeal_that_only_adds_fake_steps_upholds_the_verdict() {
    let mut c = judged(Some(0), &[0, 1]);
    as_("noise.testnet", APPEAL_BOND.as_yoctonear(), judge_at() + 2 * MIN);
    let _ = c.appeal(ID.into());
    let second =
        json!({ "success": true, "output": { "job": ID, "winner": 0, "counted": [0, 1], "fake": [2] }, "error": null });
    let v = answered(&mut c, ID, true, stdout(&second.to_string()), judge_at() + 3 * MIN);
    assert_eq!(v.verdict.unwrap().fake, vec![2], "the second verdict stands, final");
    assert_eq!(transfers(), vec![(COMPANY.to_string(), APPEAL_BOND.as_yoctonear())], "more fake steps: no bond back");
    as_("anyone.testnet", 0, judge_at() + 4 * MIN);
    c.settle(ID.into());
    let fee = REWARD * 500 / 10_000;
    assert_eq!(paid_to(COMPANY), fee + FUEL, "ONYX's step is fake now: its bond goes to the company too");
}
