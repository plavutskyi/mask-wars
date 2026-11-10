use super::*;
use crate::admin::GLOBAL_BYTE_COST;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const SEASON: &str = "season.maskwars.testnet";
const ADMIN: &str = "maskwars.testnet";
const SCHEDULER: &str = "scheduler.maskwars.testnet";
const BOUNTY: &str = "bounty.maskwars.testnet";
const JUDGE: &str = "b3818697fb7bdd4b74cdfc4ce2cd7e11ed50911daedec7c854768916e047ab83";
const OTHER_JUDGE: &str = "5048c29063c3c1f3b5ac86e66f8153eb0f28083b671fe33967a29e8512b808b0";
const LIVE_SAFE: &str = "7Hq3rXbK9mP2vW5yZ8cD1fG4hJ6kL9nQ2sT5uV8wX1yA";
const POOL: &str = "GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn";
const MIN: u64 = NS_PER_MINUTE;
/// 18:00 UTC on 9 November 2026, a slot of the daily schedule below.
const SLOT: u64 = (20_401 * 1440 + 1080) * MIN;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn near(n: u128) -> u128 {
    n * 10u128.pow(24)
}

fn milli(n: u128) -> u128 {
    n * 10u128.pow(21)
}

fn ctx(who: &str, deposit: u128, now: u64, balance: u128) -> VMContextBuilder {
    let mut c = VMContextBuilder::new();
    c.current_account_id(acc(SEASON))
        .predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(balance))
        .storage_usage(10_000)
        .block_timestamp(now)
        .block_height(now / 1_000_000_000)
        .random_seed([7; 32])
        .prepaid_gas(Gas::from_tgas(300));
    c
}

/// A call whose input is raw bytes, not JSON: a wasm.
fn with_input(who: &str, deposit: u128, now: u64, input: Vec<u8>) {
    let mut context = ctx(who, deposit, now, near(10)).build();
    context.input = input.into();
    testing_env!(context);
}

fn as_(who: &str, now: u64, balance: u128) {
    testing_env!(ctx(who, 0, now, balance).build());
}

/// A call with `tgas` attached. The mock charges the fees of the runtime's test config, higher than NEAR's own: there
/// a `collect` round takes about 126 TGas, here about 167, so two rounds need more than 300 TGas.
fn as_with_gas(who: &str, now: u64, balance: u128, tgas: u64) {
    let mut c = ctx(who, 0, now, balance);
    c.prepaid_gas(Gas::from_tgas(tgas));
    testing_env!(c.build());
}

/// A callback as NEAR delivers it: called by the contract itself, with the result of the promise before it.
fn callback(now: u64, balance: u128, result: PromiseResult) {
    testing_env!(
        ctx(SEASON, 0, now, balance).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn target(challenge: &str, code: &str) -> Target {
    Target {
        challenge: challenge.into(),
        code_hash: code.into(),
        init: "{}".into(),
        safe_fund: U128(near(2)),
        min_loot: U128(near(1)),
    }
}

fn masks() -> Vec<AccountId> {
    vec![acc("nova.maskwars.testnet"), acc("onyx.maskwars.testnet"), acc("oracle.maskwars.testnet")]
}

fn program() -> Program {
    Program {
        masks: masks(),
        targets: vec![
            target("live-safe", LIVE_SAFE),
            // A second safe code, made with an argument of its own: numbers and amounts only.
            Target {
                init: r#"{"cap":"1000000000000000000000000","slots":[1,2]}"#.into(),
                ..target("pause-bypass", POOL)
            },
        ],
        prize: U128(milli(350)),
        hours: 2,
        commit_minutes: 45,
        reveal_minutes: 60,
        judge_version: JUDGE.into(),
        first_minute: 1080,
        every_minutes: 1440,
    }
}

fn limits() -> Limits {
    Limits { max_prize: U128(near(1)), max_safe_fund: U128(near(3)), max_per_day: 2 }
}

fn season() -> Season {
    as_(ADMIN, 0, near(10));
    Season::new(
        "s1".into(),
        acc(ADMIN),
        acc(SCHEDULER),
        acc(BOUNTY),
        limits(),
        vec![LIVE_SAFE.into(), POOL.into()],
        program(),
    )
}

/// What `governance()` on the bounty contract answers.
fn bounty_state(judge: &str, codes: &[&str], pending: Option<&str>) -> PromiseResult {
    let pending = pending.map(|kind| json!({ "change": { "kind": kind } }));
    let v = json!({ "admin": ADMIN, "judge": { "version": judge }, "safe_codes": codes, "pending": pending });
    PromiseResult::Successful(serde_json::to_vec(&v).unwrap())
}

fn ok_state() -> PromiseResult {
    bounty_state(JUDGE, &[LIVE_SAFE, POOL], None)
}

fn opened_json() -> PromiseResult {
    PromiseResult::Successful(br#"{"status":{"state":"open"}}"#.to_vec())
}

/// What the safe's `get_round` answers once the bounty contract armed it for `id`.
fn armed_for(id: &str) -> Value {
    json!({ "arbiter": BOUNTY, "bounty": id, "opens_ns": "1", "armed_ns": "1" })
}

/// `open_safe` answered for `id`, and the safe said it is armed (`armed`): the round as the season records it, if any.
fn opened_and_armed(
    s: &mut Season,
    now: u64,
    attempt: u32,
    id: &str,
    spare: Spare,
    terms: RoundTerms,
    deadline: Option<u64>,
    armed: Result<Option<Value>, PromiseError>,
) -> Option<SeasonRound> {
    callback(now, near(8), opened_json());
    let bounty = deadline.map_or(json!({}), |d| json!({ "deadline_ns": d.to_string() }));
    let asked = s.on_opened(attempt, id.into(), spare.clone(), terms.clone(), Ok(bounty));
    assert!(matches!(asked, PromiseOrValue::Promise(_)), "the season asks the safe before the round counts");
    drop(asked);
    assert!(receipts().contains(&format!("-> {}: call get_round", spare.safe)), "{}", receipts());
    callback(now + 1, near(8), PromiseResult::Successful(vec![]));
    match s.on_armed(attempt, id.into(), spare, terms, deadline.map(U64), armed) {
        PromiseOrValue::Value(r) => r,
        PromiseOrValue::Promise(_) => panic!("the safe was not armed yet: the season asks the bounty contract"),
    }
}

/// The scheduler calls `open_next` at `now`; the attempt it started.
fn open(s: &mut Season, now: u64) -> u32 {
    as_(SCHEDULER, now, near(10));
    let _ = s.open_next();
    s.opening.as_ref().unwrap().attempt
}

/// One whole round: the bounty contract's state, the safe, the round.
fn full_round(s: &mut Season, now: u64) -> SeasonRound {
    let attempt = open(s, now);
    callback(now + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    // The safe's number is taken before it is made.
    let n = s.made;
    let t = s.program.targets[s.opening.as_ref().unwrap().turn as usize].clone();
    callback(now + 2, near(8), PromiseResult::Successful(vec![]));
    let _ = s.on_safe(attempt, n, t, masks(), acc(BOUNTY), Ok(()));
    let spare = s.spare.clone().unwrap();
    let id = format!("s1-{:04}-070707", spare.n);
    let p = &s.program;
    let terms = RoundTerms { prize: p.prize, hours: p.hours, commit_minutes: p.commit_minutes };
    // What open_safe returns: the bounty, with the deadline it set in the block before.
    let deadline = now + 2 + p.hours * NS_PER_HOUR;
    opened_and_armed(s, now + 3, attempt, &id, spare, terms, Some(deadline), Ok(Some(armed_for(&id)))).unwrap()
}

fn terms(s: &Season) -> RoundTerms {
    RoundTerms { prize: s.program.prize, hours: s.program.hours, commit_minutes: s.program.commit_minutes }
}

fn state_bytes() -> Vec<u8> {
    match ok_state() {
        PromiseResult::Successful(b) => b,
        _ => unreachable!(),
    }
}

/// The receipts the call made, readable: receivers, actions, method names and arguments as text.
fn receipts() -> String {
    let mut out = String::new();
    for r in get_created_receipts() {
        out.push_str(&format!("-> {}:", r.receiver_id));
        for a in r.actions {
            match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => out.push_str(&format!(
                    " call {}({}) {}",
                    String::from_utf8_lossy(&method_name),
                    String::from_utf8_lossy(&args),
                    attached_deposit.as_yoctonear()
                )),
                other => out.push_str(&format!(" {other:?}")),
            }
        }
        out.push('\n');
    }
    out
}

fn panics<F: FnOnce() + std::panic::UnwindSafe>(f: F) -> String {
    let err = std::panic::catch_unwind(f).unwrap_err();
    err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap()
}

#[test]
fn base58_reads_and_writes_a_code_hash() {
    let bytes = b58_32(LIVE_SAFE).unwrap();
    assert_eq!(b58(&bytes), LIVE_SAFE);
    // NEAR's code hash of an empty contract: sha256("") in base58.
    assert_eq!(b58(&env::sha256_array(b"")), POOL);
    assert!(b58_32("0OIl").is_none());
}

#[test]
fn a_sponsor_funds_the_treasury() {
    let mut s = season();
    testing_env!(ctx("sponsor.testnet", near(5), 0, near(15)).build());
    assert_eq!(s.fund(), U128(near(5)));
    testing_env!(ctx("sponsor.testnet", near(1), 0, near(16)).build());
    assert_eq!(s.fund(), U128(near(6)));
    let v = s.season();
    assert_eq!((v.funded, v.sponsors), (U128(near(6)), 1));
    assert_eq!(s.sponsor(acc("sponsor.testnet")), U128(near(6)));
    assert!(get_logs()
        .last()
        .unwrap()
        .starts_with(r#"EVENT_JSON:{"standard":"maskwars_season","version":"1.0.0","event":"fund""#));
}

#[test]
fn only_the_scheduler_opens_a_round() {
    let mut s = season();
    as_(ADMIN, SLOT, near(10));
    let msg = panics(move || {
        let _ = s.open_next();
    });
    assert!(msg.contains("only the scheduler opens rounds"), "{msg}");
}

#[test]
fn a_round_opens_only_when_a_slot_is_due_and_once_per_slot() {
    let mut s = season();
    // Before the first slot of the day nothing is due: the last one was yesterday 18:00, still unused, so it is due.
    // Once a round opened for it, the next is tomorrow.
    let round = full_round(&mut s, SLOT + 5 * MIN);
    assert_eq!(round.slot_ns, U64(SLOT));
    as_(SCHEDULER, SLOT + 10 * MIN, near(10));
    let next = s.next().unwrap();
    assert_eq!(next.at_ns, U64(SLOT + 1440 * MIN));
    let msg = panics(move || {
        let _ = s.open_next();
    });
    assert!(msg.contains("no round is due"), "{msg}");
}

#[test]
fn a_late_scheduler_still_opens_the_slot_it_missed() {
    let mut s = season();
    // The cron ran three hours late: the 18:00 slot is still the latest one.
    let round = full_round(&mut s, SLOT + 180 * MIN);
    assert_eq!(round.slot_ns, U64(SLOT));
}

#[test]
fn the_daily_limit_holds_whatever_the_schedule() {
    let mut s = season();
    s.program.every_minutes = 60;
    s.program.first_minute = 0;
    full_round(&mut s, SLOT);
    full_round(&mut s, SLOT + 60 * MIN);
    let mut s2 = s;
    as_(SCHEDULER, SLOT + 120 * MIN, near(10));
    let msg = panics(move || {
        let _ = s2.open_next();
    });
    assert!(msg.contains("the limit of rounds for 24 hours is reached"), "{msg}");
}

#[test]
fn the_limit_counts_the_last_24_hours() {
    let mut s = season();
    s.program.every_minutes = 60;
    s.program.first_minute = 0;
    full_round(&mut s, SLOT);
    full_round(&mut s, SLOT + 60 * MIN);
    // A day after the first one, a round may open again.
    let r = full_round(&mut s, SLOT + 1441 * MIN);
    assert_eq!(r.n, 3);
}

#[test]
fn a_short_treasury_opens_nothing() {
    let mut s = season();
    // Two NEAR for the safe and 0.35 for the bounty, beyond storage and what the treasury keeps.
    as_(SCHEDULER, SLOT, near(2));
    let msg = panics(move || {
        let _ = s.open_next();
    });
    assert!(msg.contains("the treasury holds"), "{msg}");
}

#[test]
fn one_round_at_a_time_until_a_lost_one_times_out() {
    let mut s = season();
    open(&mut s, SLOT);
    let mut again = s;
    as_(SCHEDULER, SLOT + MIN, near(10));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = again.open_next();
    }));
    assert!(msg.contains("a round is already on its way"), "{msg}");
    // OPENING_TIMEOUT_BLOCKS later (a block a second here) the lost attempt no longer holds it.
    let attempt = open(&mut again, SLOT + (OPENING_TIMEOUT_BLOCKS + 1) * 1_000_000_000);
    assert_eq!(attempt, 2);
}

#[test]
fn no_safe_is_made_when_the_bounty_contract_would_refuse_the_round() {
    for (state, why) in [
        (bounty_state(OTHER_JUDGE, &[LIVE_SAFE, POOL], None), "the season agreed to another judge"),
        (bounty_state(JUDGE, &[POOL], None), "does not know the safe's code"),
        (bounty_state(JUDGE, &[LIVE_SAFE], Some("code")), "new code or a new admin is pending"),
        (bounty_state(JUDGE, &[LIVE_SAFE], Some("admin")), "new code or a new admin is pending"),
    ] {
        let mut s = season();
        let attempt = open(&mut s, SLOT);
        let bytes = match &state {
            PromiseResult::Successful(b) => b.clone(),
            _ => unreachable!(),
        };
        callback(SLOT + 1, near(10), state);
        let r = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&bytes).unwrap()));
        assert!(matches!(r, PromiseOrValue::Value(None)));
        assert!(get_created_receipts().is_empty(), "no safe for {why}");
        assert!(get_logs().iter().any(|l| l.contains(why)), "{why}: {:?}", get_logs());
        assert!(s.opening.is_none());
        assert_eq!(s.last_slot_ns, 0, "the slot is still free");
    }
    // A judge change that is only pending lets rounds open.
    let mut s = season();
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), bounty_state(JUDGE, &[LIVE_SAFE], Some("judge")));
    let v = json!({ "judge": { "version": JUDGE }, "safe_codes": [LIVE_SAFE], "pending": { "change": { "kind": "judge" } } });
    assert!(matches!(s.on_bounty_state(attempt, Ok(v)), PromiseOrValue::Promise(_)));
}

#[test]
fn the_safe_comes_from_global_code_with_the_season_masks_and_owns_itself() {
    let mut s = season();
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    let text = receipts();
    assert!(text.contains("s0001.season.maskwars.testnet"), "{text}");
    assert!(text.contains("CreateAccount"), "{text}");
    assert!(text.contains("UseGlobalContract"), "{text}");
    assert!(!text.contains("AddKey"), "the safe gets no key: {text}");
    assert!(text.contains(&format!("{}", near(2))), "the safe's NEAR: {text}");
    // `new` gets the safe as its own owner, exactly the season's masks, the bounty contract that arms it and the
    // treasury as its team: a safe without them would be a practice safe, which takes no round.
    let owner = r#"call new({"owner":"s0001.season.maskwars.testnet","masks":["nova.maskwars.testnet","onyx.maskwars.testnet","oracle.maskwars.testnet"],"arbiter":"bounty.maskwars.testnet","team":"season.maskwars.testnet"})"#;
    assert!(text.contains(owner), "{text}");
}

#[test]
fn a_round_counts_only_once_the_safe_is_armed_for_it() {
    // Season review, carried over to the locked safe: open_safe answers before the safe arms, and a safe that does
    // not arm sends the bounty back at once. The round counts only once the safe says it is armed for it.
    for (armed, spare_stays) in [
        (Ok(Some(json!({ "arbiter": BOUNTY, "bounty": "s1-0009-ffffff", "opens_ns": "1" }))), false),
        (Ok(Some(json!({ "arbiter": "other.testnet", "bounty": "s1-0001-070707", "opens_ns": "1" }))), false),
        (Err(PromiseError::Failed), false),
    ] {
        let mut s = season();
        let attempt = open(&mut s, SLOT);
        callback(SLOT + 1, near(10), ok_state());
        let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
        callback(SLOT + 2, near(8), PromiseResult::Successful(vec![]));
        let _ = s.on_safe(attempt, 1, target("live-safe", LIVE_SAFE), masks(), acc(BOUNTY), Ok(()));
        let spare = s.spare.clone().unwrap();
        // The opening still holds the slot while the season asks the safe.
        let t = terms(&s);
        let r = opened_and_armed(&mut s, SLOT + 3, attempt, "s1-0001-070707", spare.clone(), t, None, armed);
        assert!(r.is_none());
        assert_eq!((s.season().rounds, s.last_slot_ns, s.spent), (0, 0, near(2)), "no round, the slot is free");
        assert!(s.opening.is_none());
        assert_eq!(s.spare.is_some(), spare_stays, "a free safe waits, a taken one is dropped");
        assert!(get_logs().iter().any(|l| l.contains(r#""event":"skip""#)));
    }
}

/// A round opened on the bounty contract whose safe said it is armed for nothing yet: what the season does once the
/// bounty contract tells it the round's state.
fn not_armed_yet(state: &str) -> (Season, Option<SeasonRound>, Spare) {
    let mut s = season();
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    callback(SLOT + 2, near(8), PromiseResult::Successful(vec![]));
    let _ = s.on_safe(attempt, 1, target("live-safe", LIVE_SAFE), masks(), acc(BOUNTY), Ok(()));
    let spare = s.spare.clone().unwrap();
    let t = terms(&s);
    let id = "s1-0001-070707";
    callback(SLOT + 3, near(8), opened_json());
    drop(s.on_opened(attempt, id.into(), spare.clone(), t.clone(), Ok(json!({}))));
    callback(SLOT + 4, near(8), PromiseResult::Successful(vec![]));
    let asked = s.on_armed(attempt, id.into(), spare.clone(), t.clone(), None, Ok(None));
    assert!(matches!(asked, PromiseOrValue::Promise(_)));
    drop(asked);
    assert!(receipts().contains(&format!("-> {BOUNTY}: call get({{\"id\":\"{id}\"}})")), "{}", receipts());
    callback(SLOT + 5, near(8), PromiseResult::Successful(vec![]));
    let r =
        s.on_round_state(attempt, id.into(), spare.clone(), t, None, Ok(Some(json!({ "status": { "state": state } }))));
    (s, r, spare)
}

#[test]
fn a_safe_that_has_not_heard_arm_yet_counts_once_the_bounty_contract_says_the_round_is_open() {
    // Independent review: NEAR does not promise that the safe runs `arm` before the season's `get_round`. A live round
    // the season did not record would never be brought home. The season asks the bounty contract then.
    let (s, r, _) = not_armed_yet("open");
    let r = r.expect("the round is open on the bounty contract: it is the season's");
    assert_eq!((r.n, s.season().rounds, s.last_slot_ns, s.outstanding), (1, 1, SLOT, milli(350) + near(2)));
    assert!(s.spare.is_none() && s.opening.is_none());
    // The safe refused and the bounty came back: no round, the slot stays free and the safe waits as the spare.
    let (s, r, spare) = not_armed_yet("refunded");
    assert!(r.is_none());
    assert_eq!((s.season().rounds, s.last_slot_ns, s.outstanding), (0, 0, 0));
    assert_eq!(s.spare, Some(spare));
}

#[test]
fn a_spare_made_for_another_bounty_contract_is_not_reused() {
    // Independent review: the spare did not remember which bounty contract it names as its arbiter. After a change of
    // bounty contract every slot reused it, `arm` failed there, and no round ever opened.
    let mut s = season();
    s.spare = Some(Spare {
        n: 1,
        safe: acc("s0001.season.maskwars.testnet"),
        target: target("live-safe", LIVE_SAFE),
        masks: masks(),
        bounty: acc("old-bounty.maskwars.testnet"),
    });
    s.made = 1;
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    let text = receipts();
    assert!(text.contains("s0002.season.maskwars.testnet") && text.contains("CreateAccount"), "{text}");
    assert!(s.spare.is_none());
}

#[test]
fn a_round_opened_before_a_change_of_bounty_contract_is_recorded_on_the_contract_it_opened_on() {
    // Independent review: anyone may apply a ready change, also while a round is on its way. The round was checked
    // against the season's bounty contract of the moment and treated as no round of the season.
    let mut s = season();
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    callback(SLOT + 2, near(8), PromiseResult::Successful(vec![]));
    let _ = s.on_safe(attempt, 1, target("live-safe", LIVE_SAFE), masks(), acc(BOUNTY), Ok(()));
    let spare = s.spare.clone().unwrap();
    s.bounty = acc("bounty-2.maskwars.testnet");
    let id = "s1-0001-070707";
    let t = terms(&s);
    let r = opened_and_armed(&mut s, SLOT + 3, attempt, id, spare, t, None, Ok(Some(armed_for(id)))).unwrap();
    assert_eq!(r.bounty.as_str(), BOUNTY);
}

#[test]
fn collect_does_not_wait_behind_a_round_with_a_later_deadline() {
    // Independent review: after a change of the round's hours, deadlines are no longer in the order rounds opened, and
    // collect stopped at the first round not over yet.
    let mut s = season();
    s.program.every_minutes = 60;
    s.program.first_minute = 0;
    s.limits.max_per_day = 10;
    s.program.hours = 20;
    let long = full_round(&mut s, SLOT);
    s.program.hours = 1;
    let short = full_round(&mut s, SLOT + 60 * MIN);
    assert!(short.deadline_ns.0 < long.deadline_ns.0);
    as_("anyone.testnet", short.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(10));
    assert_eq!((s.collectable(None), s.collect(None)), (1, 1));
    assert!(receipts().contains(&format!("call settle({{\"id\":\"{}\"}})", short.id)));
    callback(short.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(10), PromiseResult::Successful(vec![]));
    s.on_collected(1, bounty_in("refunded"));
    // The cursor stays on the long round, which is not over: the short one is done and not asked again.
    assert_eq!((s.collected, s.collectable(None)), (0, 0));
}

#[test]
fn a_buyer_just_before_a_bounty_comes_back_takes_nobody_s_part() {
    // Independent review, finding 1: shares were priced at what the treasury could spend, without the bounties out in
    // rounds. A buyer who funded while a long change was pending, then called collect on an unwon round and exited,
    // walked off with part of the bounty that came back.
    let mut s = season();
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    // A round takes 2 NEAR into its safe and 0.35 NEAR of bounty: 7.65 NEAR stay free, 2.35 are out.
    full_round(&mut s, SLOT);
    assert_eq!(s.outstanding, milli(350) + near(2));
    as_(ADMIN, SLOT, near(10));
    s.propose(Change::Admin { account: acc("x.testnet") });
    let balance = milli(200) + near(10) - near(2) - milli(350);
    fund(&mut s, "thief.testnet", near(1), SLOT + MIN, balance);
    // The unwon bounty comes back to the treasury, and the safe's NEAR with it.
    let after = balance + near(1) + milli(350) + near(2);
    callback(SLOT + 2 * MIN, after, PromiseResult::Successful(vec![]));
    s.outstanding = 0;
    as_("thief.testnet", SLOT + 3 * MIN, after);
    let took = s.exit().0;
    assert!(took <= near(1), "the thief takes back no more than it put in: {took}");
    assert!(near(1) - took < 1_000_000, "and no less either: {took}");
    as_("a.testnet", SLOT + 3 * MIN, after - took);
    assert!(s.share_of(acc("a.testnet")).0 >= near(10) - 1_000_000);
}

#[test]
fn a_treasury_with_a_bounty_out_starts_no_new_era() {
    // Independent review, finding 2: when a round left less than 0.01 NEAR free, a fund of 0.01 NEAR started a new
    // era and took every share, and with them every bounty that came back.
    let mut s = season();
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    s.outstanding = near(9);
    // Rounds took all but 0.005 NEAR; 9 NEAR of bounties are still out.
    fund(&mut s, "thief.testnet", milli(10), 0, milli(205));
    s.outstanding = 0;
    let back = milli(205) + milli(10) + near(9);
    as_("a.testnet", 0, back);
    let (a, thief) = (s.share_of(acc("a.testnet")).0, s.share_of(acc("thief.testnet")).0);
    assert!(a > near(9), "A keeps the bounties that come back: {a}");
    assert!(thief <= milli(10) + 1_000_000, "the thief has what it paid: {thief}");
}

#[test]
fn shares_never_overflow_however_often_the_treasury_runs_low() {
    // Independent review, finding 6: after a few cycles of 1000 NEAR spent down to almost nothing, the shares
    // overflowed 128 bits and funding stopped for good. Every share is halved instead, and every part stays.
    let mut s = season();
    for cycle in 0..12 {
        fund(&mut s, "a.testnet", near(1000), 0, milli(200) + milli(11));
        // Rounds spend all but 0.011 NEAR.
        as_("a.testnet", 0, milli(200) + milli(11));
        let _ = cycle;
    }
    fund(&mut s, "b.testnet", near(5), 0, milli(200) + milli(11));
    as_("b.testnet", 0, milli(200) + milli(11) + near(5));
    let (a, b) = (s.share_of(acc("a.testnet")).0, s.share_of(acc("b.testnet")).0);
    assert!(s.total_shares <= SHARE_LIMIT && s.shift > 0, "{} {}", s.total_shares, s.shift);
    assert!(b > near(5) - milli(1) && a + b <= milli(11) + near(5), "a {a} b {b}");
}

#[test]
fn an_exit_takes_a_share_of_what_is_here_and_leaves_the_rounds_out_to_the_others() {
    // Second independent review: an exit that kept shares for the bounties still out could be called again and again
    // and drained what could be spent (9.84 of 10 NEAR to a half share), and a bounty refunded before collect counted
    // twice. An exit now takes its share of what is here, once, and all its shares go.
    let mut s = season();
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    fund(&mut s, "b.testnet", near(10), 0, milli(200) + near(10));
    s.outstanding = near(4);
    // 16 NEAR free and 4 out: half each.
    as_(ADMIN, 0, near(10));
    s.propose(Change::Admin { account: acc("x.testnet") });
    as_("a.testnet", 1, milli(200) + near(16));
    assert_eq!(s.exit(), U128(near(8)));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = s.exit();
    }));
    assert!(msg.contains("holds no shares"), "a second exit takes nothing: {msg}");
    // The 4 NEAR out come back to B, who stayed; a round won instead leaves B with what is here.
    s.outstanding = 0;
    as_("b.testnet", 2, milli(200) + near(12));
    assert_eq!(s.share_of(acc("b.testnet")), U128(near(12)));
    as_("b.testnet", 2, milli(200) + near(8));
    assert_eq!(s.share_of(acc("b.testnet")), U128(near(8)));
    // With nothing free, an exit pays nothing and does not fail.
    let mut t = season();
    fund(&mut t, "a.testnet", near(1), 0, milli(200));
    as_(ADMIN, 0, near(10));
    t.propose(Change::Admin { account: acc("x.testnet") });
    as_("a.testnet", 1, milli(200));
    assert_eq!(t.exit(), U128(0));
}

#[test]
fn near_that_belongs_to_nobody_is_not_bought_for_a_cent() {
    // Third independent review: once every sponsor had left, the next deposit got every share, and with them the
    // bounties the others had left behind: 0.01 NEAR bought 5 NEAR. That NEAR stays the treasury's own now.
    let mut s = season();
    // 5 NEAR came back after everyone left; nobody holds a share.
    fund(&mut s, "newcomer.testnet", milli(10), 0, milli(200) + near(5));
    as_("newcomer.testnet", 0, milli(200) + near(5) + milli(10));
    let mine = s.share_of(acc("newcomer.testnet")).0;
    assert!(mine <= milli(10) && mine > milli(10) - 1_000_000, "the newcomer has what it paid: {mine}");
    // What the treasury was deployed with is no sponsor's either: the first sponsor buys in beside it.
    let mut t = season();
    fund(&mut t, "owner.testnet", near(15), 0, milli(200) + near(2));
    as_("owner.testnet", 0, milli(200) + near(17));
    assert!(t.share_of(acc("owner.testnet")).0 <= near(15));
}

#[test]
fn a_deposit_that_buys_no_share_is_refused() {
    let mut s = season();
    fund(&mut s, "a.testnet", near(1), 0, milli(200));
    // Shares were halved so far that a cent buys nothing.
    s.total_shares = 1;
    testing_env!(ctx("b.testnet", milli(10), 0, milli(200) + near(1)).build());
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        s.fund();
    }));
    assert!(msg.contains("buys no share"), "{msg}");
}

#[test]
fn a_round_brought_home_twice_counts_once() {
    // Second independent review: two collects in a row came back to on_collected twice, and the bounty came off what
    // is out twice, so shares sold too cheap.
    let mut s = season();
    s.program.every_minutes = 60;
    s.program.first_minute = 0;
    s.limits.max_per_day = 10;
    let r1 = full_round(&mut s, SLOT);
    full_round(&mut s, SLOT + 60 * MIN);
    assert_eq!(s.outstanding, 2 * (milli(350) + near(2)));
    callback(r1.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(10), PromiseResult::Successful(vec![]));
    assert_eq!(s.on_collected(0, bounty_in("refunded")).as_deref(), Some("refunded"));
    assert_eq!(s.on_collected(0, bounty_in("refunded")).as_deref(), Some("refunded"));
    // Round 1's bounty is home, its safe's NEAR not yet; round 2 is out whole.
    assert_eq!(s.outstanding, milli(350) + near(2) + near(2));
    // The safe answers once; an answer that comes twice counts once too.
    callback(r1.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(12), PromiseResult::Successful(vec![]));
    assert!(s.on_reclaimed(0));
    assert!(s.on_reclaimed(0));
    assert_eq!(s.outstanding, milli(350) + near(2));
}

#[test]
fn a_round_that_never_ends_holds_up_no_round_far_behind_it() {
    // Second independent review: a round stuck open stopped the cursor, and past the window behind it nothing was
    // brought home again. Anyone may start collect further on.
    let mut s = season();
    s.program.every_minutes = 60;
    s.program.first_minute = 0;
    s.limits.max_per_day = 48;
    let mut last = full_round(&mut s, SLOT);
    for k in 1..20 {
        last = full_round(&mut s, SLOT + k * 1441 * MIN);
    }
    as_with_gas("anyone.testnet", last.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(10), 400);
    assert_eq!(s.collect(None), COLLECT_AT_ONCE);
    assert!(!receipts().contains(&last.id), "the window from the cursor stops before the last round");
    as_("anyone.testnet", last.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(10));
    assert_eq!(s.collect(Some(19)), 1);
    assert!(receipts().contains(&format!("call settle({{\"id\":\"{}\"}})", last.id)), "{}", receipts());
}

#[test]
fn a_safe_code_without_a_lock_is_dropped_after_its_first_round() {
    // A safe of the library that has no `arm` (pause-bypass) never takes a round: the bounty comes back at once. Its
    // `get_round` fails too, and the season makes no more safes from that code instead of losing one every day.
    let mut s = season();
    s.turn = 1;
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    let pool = s.program.targets[1].clone();
    callback(SLOT + 2, near(8), PromiseResult::Successful(vec![]));
    let _ = s.on_safe(attempt, 1, pool, masks(), acc(BOUNTY), Ok(()));
    let spare = s.spare.clone().unwrap();
    let t = terms(&s);
    let r = opened_and_armed(&mut s, SLOT + 3, attempt, "s1-0001-070707", spare, t, None, Err(PromiseError::Failed));
    assert!(r.is_none());
    assert_eq!(s.safe_codes, vec![LIVE_SAFE.to_string()]);
    as_(SCHEDULER, SLOT + 10 * MIN, near(10));
    assert_eq!(s.next().unwrap().challenge, "live-safe");
}

#[test]
fn a_whole_round_is_recorded_and_the_targets_take_turns() {
    let mut s = season();
    let r1 = full_round(&mut s, SLOT);
    assert_eq!((r1.n, r1.challenge.as_str(), r1.safe.as_str()), (1, "live-safe", "s0001.season.maskwars.testnet"));
    assert_eq!(r1.id, "s1-0001-070707");
    // Times as the bounty contract set them, in the block of open_safe.
    assert_eq!(r1.opened_ns, U64(SLOT + 2));
    assert_eq!(r1.commit_until_ns, U64(r1.opened_ns.0 + 45 * MIN));
    assert_eq!(r1.deadline_ns, U64(r1.opened_ns.0 + 120 * MIN));
    let r2 = full_round(&mut s, SLOT + 1440 * MIN);
    assert_eq!((r2.n, r2.challenge.as_str()), (2, "pause-bypass"));
    let r3 = full_round(&mut s, SLOT + 2 * 1440 * MIN);
    assert_eq!(r3.challenge, "live-safe");
    let v = s.season();
    assert_eq!((v.rounds, v.safes), (3, 3));
    assert_eq!(v.spent, U128(3 * (near(2) + milli(350))));
    assert_eq!(s.latest(Some(2)).iter().map(|r| r.n).collect::<Vec<_>>(), vec![3, 2]);
    assert_eq!(s.rounds(Some(1), Some(5)).iter().map(|r| r.n).collect::<Vec<_>>(), vec![2, 3]);
    assert!(get_logs().iter().any(|l| l.contains(r#""event":"open""#)));
}

#[test]
fn a_safe_that_was_not_made_leaves_the_slot_free_and_its_number_is_never_used_again() {
    // Season review finding 6: the safe's number grew only once the safe was made, so an attempt whose batch failed or
    // came back late could name the same account as the next one. The number is taken before the batch.
    let mut s = season();
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    assert_eq!(s.made, 1, "s0001 is taken as soon as the batch is sent");
    callback(SLOT + 2, near(10), PromiseResult::Failed);
    let _ = s.on_safe(attempt, 1, target("live-safe", LIVE_SAFE), masks(), acc(BOUNTY), Err(PromiseError::Failed));
    assert!(s.opening.is_none() && s.spare.is_none());
    assert_eq!((s.last_slot_ns, s.spent), (0, 0));
    // The next try makes s0002: no attempt ever creates the same account twice.
    let r = full_round(&mut s, SLOT + MIN);
    assert_eq!((r.n, r.safe.as_str()), (2, "s0002.season.maskwars.testnet"));
}

#[test]
fn a_spare_safe_is_never_replaced() {
    // Season review finding 6: a safe made by an attempt that came back late replaced the spare, and the safe it
    // replaced kept its NEAR with nobody to race it. The spare stays; the late one is logged as left behind.
    let mut s = season();
    let first = Spare {
        n: 1,
        safe: acc("s0001.season.maskwars.testnet"),
        target: target("live-safe", LIVE_SAFE),
        masks: masks(),
        bounty: acc(BOUNTY),
    };
    s.spare = Some(first.clone());
    s.made = 2;
    callback(SLOT, near(10), PromiseResult::Successful(vec![]));
    let r = s.on_safe(7, 2, target("live-safe", LIVE_SAFE), masks(), acc(BOUNTY), Ok(()));
    assert!(matches!(r, PromiseOrValue::Value(None)), "attempt 7 was dropped");
    assert_eq!(s.spare, Some(first));
    assert!(get_logs().iter().any(|l| l.contains(r#""event":"orphan""#) && l.contains("s0002")), "{:?}", get_logs());
}

#[test]
fn a_round_the_bounty_contract_refused_leaves_its_safe_for_the_next_one() {
    let mut s = season();
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    callback(SLOT + 1, near(10), PromiseResult::Successful(vec![]));
    let _ = s.on_safe(attempt, 1, target("live-safe", LIVE_SAFE), masks(), acc(BOUNTY), Ok(()));
    let spare = s.spare.clone().unwrap();
    callback(SLOT + 2, near(8), PromiseResult::Failed);
    let r = s.on_opened(attempt, "s1-0001-aaaaaa".into(), spare.clone(), terms(&s), Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Value(None)));
    assert_eq!(s.spare, Some(spare));
    assert_eq!((s.season().rounds, s.last_slot_ns), (0, 0));
    // The next try costs only the bounty: the spare safe already holds its NEAR.
    as_(SCHEDULER, SLOT + MIN, near(10));
    assert_eq!(s.next().unwrap().n, 1);
    let attempt = open(&mut s, SLOT + MIN);
    callback(SLOT + MIN + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    let text = receipts();
    assert!(!text.contains("CreateAccount") && text.contains("open_safe"), "{text}");
    let spare = s.spare.clone().unwrap();
    let id = "s1-0001-bbbbbb";
    let t = terms(&s);
    let r = opened_and_armed(&mut s, SLOT + MIN + 2, attempt, id, spare, t, None, Ok(Some(armed_for(id)))).unwrap();
    assert_eq!((r.n, s.made), (1, 1));
    assert!(s.spare.is_none());
}

#[test]
fn a_spare_safe_for_other_masks_is_left_alone() {
    let mut s = season();
    s.spare = Some(Spare {
        n: 1,
        safe: acc("s0001.season.maskwars.testnet"),
        target: target("live-safe", LIVE_SAFE),
        masks: vec![acc("nova.maskwars.testnet")],
        bounty: acc(BOUNTY),
    });
    s.made = 1;
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    assert!(receipts().contains("s0002.season.maskwars.testnet"));
    assert!(s.spare.is_none());
}

#[test]
fn a_target_whose_code_was_dropped_is_skipped() {
    let mut s = season();
    as_(ADMIN, 0, near(10));
    s.drop_safe_code(LIVE_SAFE.into());
    let r = full_round(&mut s, SLOT);
    assert_eq!(r.challenge, "pause-bypass");
    as_(ADMIN, 0, near(10));
    s.drop_safe_code(POOL.into());
    as_(SCHEDULER, SLOT + 1440 * MIN, near(10));
    assert!(s.next().is_none());
    let msg = panics(move || {
        let _ = s.open_next();
    });
    assert!(msg.contains("no target of the program has an allowed safe code"), "{msg}");
}

#[test]
fn next_shows_when_what_and_how_much() {
    let s = season();
    as_("anyone.testnet", SLOT - 60 * MIN, near(10));
    let n = s.next().unwrap();
    // An hour before 18:00 the latest slot, yesterday's, has not been used: it is due now.
    assert_eq!(n.at_ns, U64(SLOT - 1440 * MIN));
    assert_eq!((n.n, n.challenge.as_str(), n.prize, n.safe_fund), (1, "live-safe", U128(milli(350)), U128(near(2))));
    assert!(n.funded);
    as_("anyone.testnet", SLOT - 60 * MIN, near(1));
    assert!(!s.next().unwrap().funded);
}

#[test]
fn the_program_must_fit_the_limits_and_the_bounty_rules() {
    let s = season();
    as_(ADMIN, 0, near(10));
    let bad = |f: &dyn Fn(&mut Program)| {
        let mut p = program();
        f(&mut p);
        s.check_program(&p).unwrap_err()
    };
    assert!(bad(&|p| p.prize = U128(near(2))).contains("prize"));
    // Season review finding 7: the bounty contract keeps the round's storage and every mask's reserve out of the
    // prize; a prize the program allowed could leave less than 0.1 NEAR for the winner, and the round never opened.
    let least = s.min_prize(3).0;
    assert!(least > MIN_PRIZE.as_yoctonear() + milli(120), "3 masks reserve 12 240 bytes on the bounty contract");
    assert!(bad(&|p| p.prize = U128(least - 1)).contains("prize: at least"));
    let mut p = program();
    p.prize = U128(least);
    assert!(s.check_program(&p).is_ok());
    assert!(bad(&|p| p.targets[0].safe_fund = U128(near(4))).contains("over the limit"));
    assert!(bad(&|p| p.targets[0].min_loot = U128(near(2))).contains("min_loot"));
    assert!(bad(&|p| p.targets[0].code_hash = "9".repeat(44)).contains("not one the season allows"));
    for key in ["owner", "masks", "arbiter", "team"] {
        let init = format!(r#"{{"{key}":"me.testnet"}}"#);
        assert!(bad(&|p| p.targets[0].init = init.clone()).contains("owner, masks, arbiter and team itself"), "{key}");
    }
    // Season review finding 1: an init that names an account could hand a safe's NEAR to anyone. Only numbers, flags
    // and amounts.
    for init in [r#"{"admin":"thief.testnet"}"#, r#"{"allotments":[["thief.testnet","1"]]}"#, r#"{"to":""}"#] {
        assert!(bad(&|p| p.targets[1].init = init.into()).contains("init names no account"), "{init}");
    }
    assert!(bad(&|p| p.targets[0].init = "[1]".into()).contains("JSON object"));
    assert!(bad(&|p| p.masks.push(acc("s0009.season.maskwars.testnet"))).contains("a mask is its own account"));
    assert!(bad(&|p| p.masks.push(acc(BOUNTY))).contains("a mask is its own account"));
    assert!(bad(&|p| p.masks.push(acc("nova.maskwars.testnet"))).contains("twice"));
    assert!(bad(&|p| p.hours = 25).contains("hours"));
    assert!(bad(&|p| p.commit_minutes = 100).contains("commit and reveal"));
    // Independent review: a quick change of windows could leave the reveal window short of a turn per mask, and then
    // the bounty contract refused every round.
    assert!(bad(&|p| p.reveal_minutes = 11).contains("reveal_minutes: 3 for each mask"));
    assert!(bad(&|p| p.judge_version = "v5".into()).contains("judge_version"));
    assert!(bad(&|p| p.every_minutes = 0).contains("schedule"));
}

#[test]
fn changes_wait_in_the_open_and_raising_a_limit_waits_long() {
    let mut s = season();
    as_(ADMIN, 0, near(10));
    let p = s.propose(Change::Limits { limits: Limits { max_per_day: 4, ..limits() } });
    assert_eq!(p.ready_ns, U64(CHANGE_DELAY_HOURS * NS_PER_HOUR));
    s.cancel();
    let p = s.propose(Change::Limits { limits: Limits { max_per_day: 1, ..limits() } });
    assert_eq!(p.ready_ns, U64(CHANGE_NOTICE_HOURS * NS_PER_HOUR), "lowering is quick");
    as_("anyone.testnet", NS_PER_HOUR - 1, near(10));
    let mut early = s;
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        early.apply();
    }));
    assert!(msg.contains("still waiting"), "{msg}");
    as_("anyone.testnet", NS_PER_HOUR, near(10));
    assert_eq!(early.apply().limits.max_per_day, 1);
    for (change, long) in [
        (Change::Admin { account: acc("x.testnet") }, true),
        (Change::Bounty { account: acc("x.testnet") }, true),
        (Change::Code { sha256: JUDGE.into() }, true),
        (Change::Scheduler { account: acc("x.testnet") }, false),
        (Change::AllowSafe { code_hash: "8".repeat(44) }, true),
        (Change::Program { program: program() }, false),
    ] {
        let mut s = season();
        as_(ADMIN, 0, near(10));
        let wait = if long { CHANGE_DELAY_HOURS } else { CHANGE_NOTICE_HOURS };
        let p = s.propose(change);
        assert_eq!((p.ready_ns, p.long), (U64(wait * NS_PER_HOUR), long));
    }
}

#[test]
fn a_program_that_moves_the_money_waits_long_and_only_time_is_quick() {
    // Season review finding 1: other masks, targets or a free init waited an hour, and sponsors could not leave. Now
    // only the schedule and the windows are quick; everything that decides where the NEAR goes waits 72 hours.
    let other_mask = |p: &mut Program| p.masks[2] = acc("thief.testnet");
    let other_fund = |p: &mut Program| p.targets[0].safe_fund = U128(near(3));
    let other_init = |p: &mut Program| p.targets[1].init = r#"{"cap":"1"}"#.into();
    let other_loot = |p: &mut Program| p.targets[0].min_loot = U128(milli(500));
    let other_target = |p: &mut Program| p.targets.reverse();
    let other_prize = |p: &mut Program| p.prize = U128(milli(400));
    let other_judge = |p: &mut Program| p.judge_version = OTHER_JUDGE.into();
    let schedule = |p: &mut Program| p.first_minute = 1200;
    let every = |p: &mut Program| p.every_minutes = 720;
    let windows = |p: &mut Program| {
        p.commit_minutes = 30;
        p.reveal_minutes = 90;
        p.hours = 3;
    };
    type Edit<'a> = &'a dyn Fn(&mut Program);
    let cases: [(Edit, bool); 10] = [
        (&other_mask, true),
        (&other_fund, true),
        (&other_init, true),
        (&other_loot, true),
        (&other_target, true),
        (&other_prize, true),
        (&other_judge, true),
        (&schedule, false),
        (&every, false),
        (&windows, false),
    ];
    for (i, (f, long)) in cases.into_iter().enumerate() {
        let mut s = season();
        as_(ADMIN, 0, near(10));
        let mut p = program();
        f(&mut p);
        let pending = s.propose(Change::Program { program: p });
        let wait = if long { CHANGE_DELAY_HOURS } else { CHANGE_NOTICE_HOURS };
        assert_eq!((pending.ready_ns, pending.long), (U64(wait * NS_PER_HOUR), long), "case {i}");
    }
}

/// A sponsor funds the treasury at `now`; the treasury's balance before is `before` (the mock adds the deposit).
fn fund(s: &mut Season, who: &str, amount: u128, now: u64, before: u128) {
    testing_env!(ctx(who, amount, now, before).build());
    s.fund();
}

#[test]
fn sponsors_exit_with_their_share_while_a_long_change_waits() {
    // Season review finding 1: NEAR could leave the treasury only as rounds, so a sponsor who saw a change it did not
    // want had no way out. While a change that waits long is pending, each sponsor takes its share of the treasury.
    let mut s = season();
    // The treasury keeps 0.2 NEAR: 0.1 of storage and KEEP. 9.8 NEAR are free when the first sponsor comes.
    let free = |balance: u128| balance - milli(200);
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    fund(&mut s, "b.testnet", near(5), 0, milli(200) + near(10));
    as_("a.testnet", 0, milli(200) + near(15));
    assert_eq!((s.share_of(acc("a.testnet")), s.share_of(acc("b.testnet"))), (U128(near(10)), U128(near(5))));
    // Rounds take 6 NEAR: each keeps its part of what is left.
    as_("a.testnet", 0, milli(200) + near(9));
    assert_eq!((s.share_of(acc("a.testnet")).0, s.share_of(acc("b.testnet")).0), (near(6), near(3)));
    // A later sponsor buys in at today's value and takes nobody's part.
    fund(&mut s, "c.testnet", near(3), 0, milli(200) + near(9));
    as_("c.testnet", 0, milli(200) + near(12));
    assert_eq!((s.share_of(acc("a.testnet")).0, s.share_of(acc("c.testnet")).0), (near(6), near(3)));
    assert_eq!(free(milli(200) + near(12)), near(12));

    // No change pending, or a quick one: nobody exits.
    as_("a.testnet", 0, milli(200) + near(12));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = s.exit();
    }));
    assert!(msg.contains("no change is pending"), "{msg}");
    as_(ADMIN, 0, milli(200) + near(12));
    s.propose(Change::Scheduler { account: acc("x.testnet") });
    as_("a.testnet", 0, milli(200) + near(12));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = s.exit();
    }));
    assert!(msg.contains("only a change that waits long"), "{msg}");
    as_(ADMIN, 0, milli(200) + near(12));
    s.cancel();
    let mut p = program();
    p.masks[2] = acc("thief.testnet");
    s.propose(Change::Program { program: p });

    // While the new masks wait, A takes its 6 NEAR; B and C keep theirs.
    as_("a.testnet", NS_PER_HOUR, milli(200) + near(12));
    assert_eq!(s.exit(), U128(near(6)));
    assert!(
        receipts().contains(&format!(
            "-> a.testnet: Transfer {{ receipt_index: 0, deposit: NearToken {{ inner: {} }} }}",
            near(6)
        )),
        "{}",
        receipts()
    );
    as_("b.testnet", NS_PER_HOUR, milli(200) + near(6));
    assert_eq!((s.share_of(acc("b.testnet")).0, s.share_of(acc("c.testnet")).0), (near(3), near(3)));
    assert_eq!(s.season().exited, U128(near(6)));
    as_("a.testnet", NS_PER_HOUR, milli(200) + near(6));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = s.exit();
    }));
    assert!(msg.contains("holds no shares"), "{msg}");
    // Once the change is ready it may apply at any moment: too late to leave.
    as_("b.testnet", CHANGE_DELAY_HOURS * NS_PER_HOUR, milli(200) + near(6));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = s.exit();
    }));
    assert!(msg.contains("the change is ready"), "{msg}");
}

#[test]
fn no_sponsor_exits_while_a_round_is_on_its_way() {
    let mut s = season();
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    as_(ADMIN, SLOT - MIN, near(10));
    s.propose(Change::Admin { account: acc("x.testnet") });
    open(&mut s, SLOT);
    as_("a.testnet", SLOT + 1, near(10));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = s.exit();
    }));
    assert!(msg.contains("a round is on its way"), "{msg}");
}

#[test]
fn a_treasury_the_rounds_emptied_starts_its_shares_afresh() {
    let mut s = season();
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    // Rounds spent everything: A's shares are worth nothing, and B's money is B's alone.
    fund(&mut s, "b.testnet", near(4), 0, milli(200));
    as_("b.testnet", 0, milli(200) + near(4));
    assert_eq!((s.share_of(acc("a.testnet")).0, s.share_of(acc("b.testnet")).0), (0, near(4)));
}

#[test]
fn mul_div_takes_products_beyond_128_bits() {
    assert_eq!(mul_div(near(15), near(15), near(15)), near(15));
    assert_eq!(mul_div(u128::MAX, u128::MAX, u128::MAX), u128::MAX);
    assert_eq!(mul_div(near(12), near(3), near(9)), near(4));
    assert_eq!(mul_div(7, 3, 2), 10);
    assert_eq!(mul_div(0, near(1), 1), 0);
    // A quotient of 128 bits or more is no answer, nor a division by 0.
    assert_eq!(mul_div_checked(u128::MAX, 2, 1), None);
    assert_eq!(mul_div_checked(1 << 64, 1 << 64, 1), None);
    assert_eq!(mul_div_checked(1, 1, 0), None);
    assert_eq!(mul_div_checked((1 << 64) + 3, 1 << 64, 1 << 64), Some((1 << 64) + 3));
}

#[test]
fn only_the_admin_proposes_and_a_change_lapses() {
    let mut s = season();
    as_(SCHEDULER, 0, near(10));
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        s.propose(Change::Scheduler { account: acc(SCHEDULER) });
    }));
    assert!(msg.contains("only the admin"), "{msg}");
    as_(ADMIN, 0, near(10));
    s.propose(Change::Scheduler { account: acc("new.testnet") });
    as_("anyone.testnet", (CHANGE_NOTICE_HOURS + CHANGE_EXPIRY_HOURS) * NS_PER_HOUR, near(10));
    assert!(s.pending().is_none());
    let msg = panics(move || {
        s.apply();
    });
    assert!(msg.contains("lapsed"), "{msg}");
}

#[test]
fn a_new_program_starts_its_targets_from_the_top() {
    let mut s = season();
    full_round(&mut s, SLOT);
    assert_eq!(s.turn, 1);
    as_(ADMIN, SLOT, near(10));
    let mut p = program();
    p.prize = U128(milli(500));
    s.propose(Change::Program { program: p });
    as_("anyone.testnet", SLOT + CHANGE_DELAY_HOURS * NS_PER_HOUR, near(10));
    let v = s.apply();
    assert_eq!((v.program.prize, s.turn), (U128(milli(500)), 0));
}

#[test]
fn a_program_that_no_longer_fits_is_not_applied() {
    let mut s = season();
    as_(ADMIN, 0, near(10));
    s.propose(Change::Program { program: program() });
    s.drop_safe_code(POOL.into());
    as_("anyone.testnet", NS_PER_HOUR, near(10));
    let msg = panics(move || {
        s.apply();
    });
    assert!(msg.contains("pause-bypass: its safe code is not one the season allows"), "{msg}");
}

#[test]
fn upgrade_takes_only_the_proposed_wasm() {
    let mut s = season();
    let wasm = b"\0asm new season".to_vec();
    as_(ADMIN, 0, near(10));
    s.propose(Change::Code { sha256: hex(&env::sha256(&wasm)) });
    with_input("anyone.testnet", 0, CHANGE_DELAY_HOURS * NS_PER_HOUR, b"\0asm other".to_vec());
    let mut other = s;
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = other.upgrade();
    }));
    assert!(msg.contains("not the proposed code"), "{msg}");
    with_input("anyone.testnet", 0, CHANGE_DELAY_HOURS * NS_PER_HOUR, wasm);
    let _ = other.upgrade();
    let text = receipts();
    assert!(text.contains("DeployContract") && text.contains("migrate"), "{text}");
}

#[test]
fn publishing_a_safe_code_takes_only_an_allowed_one_and_the_caller_pays() {
    let mut s = season();
    let wasm = b"\0asm a safe".to_vec();
    let code = b58(&env::sha256_array(&wasm));
    let cost = GLOBAL_BYTE_COST.as_yoctonear() * wasm.len() as u128;
    with_input("anyone.testnet", cost, 0, wasm.clone());
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = s.publish_code();
    }));
    assert!(msg.contains("not a safe code the season allows"), "{msg}");
    s.safe_codes.push(code.clone());
    with_input("anyone.testnet", cost - 1, 0, wasm.clone());
    let msg = panics(std::panic::AssertUnwindSafe(|| {
        let _ = s.publish_code();
    }));
    assert!(msg.contains("attach"), "{msg}");
    with_input("anyone.testnet", cost + 5, 0, wasm);
    let _ = s.publish_code();
    assert!(receipts().contains("DeployGlobalContract"));
    callback(1, near(10), PromiseResult::Successful(vec![]));
    assert!(s.on_published(code.clone(), acc("anyone.testnet"), U128(cost + 5), U128(cost), Ok(())));
    assert!(receipts().contains("Transfer"), "the change goes back");
    callback(1, near(10), PromiseResult::Failed);
    assert!(!s.on_published(code, acc("anyone.testnet"), U128(cost), U128(cost), Err(PromiseError::Failed)));
}

#[test]
fn a_season_starts_only_with_a_program_that_fits() {
    as_(ADMIN, 0, near(10));
    let msg = panics(|| {
        let mut p = program();
        p.prize = U128(near(5));
        Season::new(
            "s1".into(),
            acc(ADMIN),
            acc(SCHEDULER),
            acc(BOUNTY),
            limits(),
            vec![LIVE_SAFE.into(), POOL.into()],
            p,
        );
    });
    assert!(msg.contains("prize"), "{msg}");
    let msg = panics(|| {
        Season::new(
            "S-1".into(),
            acc(ADMIN),
            acc(SCHEDULER),
            acc(BOUNTY),
            limits(),
            vec![LIVE_SAFE.into(), POOL.into()],
            program(),
        );
    });
    assert!(msg.contains("name"), "{msg}");
}

/// What the bounty contract's `get(id)` answers.
fn bounty_in(state: &str) -> Result<Option<Value>, PromiseError> {
    Ok(Some(json!({ "owner": SEASON, "status": { "state": state } })))
}

#[test]
fn finished_rounds_are_brought_home_oldest_first_and_only_once_they_ended() {
    // Season review finding 4: the cursor moved as soon as collect asked, whatever the bounty contract said, so a round
    // whose settle or refund failed was never asked again. It moves only once the round there is paid, drained or
    // refunded.
    let mut s = season();
    s.program.every_minutes = 60;
    s.program.first_minute = 0;
    s.limits.max_per_day = 10;
    let r1 = full_round(&mut s, SLOT);
    let r2 = full_round(&mut s, SLOT + 60 * MIN);
    assert_eq!((r1.bounty.as_str(), r1.outcome.as_deref()), (BOUNTY, None));
    // Before the claims are over nothing is due.
    as_("anyone.testnet", r1.deadline_ns.0 + 12 * NS_PER_HOUR, near(10));
    assert_eq!((s.collectable(None), s.collect(None)), (0, 0));
    assert!(receipts().is_empty());
    // An hour after the claim grace the first round is asked about: settle, then refund, then its state.
    as_("anyone.testnet", r1.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(10));
    assert_eq!((s.collectable(None), s.collect(None)), (1, 1));
    let text = receipts();
    let settle = text.find("call settle({\"id\":\"s1-0001-070707\"})").expect(&text);
    let refund = text.find("call refund({\"id\":\"s1-0001-070707\"})").expect(&text);
    let get = text.find("call get({\"id\":\"s1-0001-070707\"})").expect(&text);
    let back = text.find("call on_collected({\"index\":0})").expect(&text);
    assert!(settle < refund && refund < get && get < back, "{text}");
    // A claim was still with the judge: nothing moves, and the next collect asks again.
    callback(r1.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(10), PromiseResult::Successful(vec![]));
    assert_eq!(s.on_collected(0, bounty_in("open")), None);
    assert_eq!(s.on_collected(0, Err(PromiseError::Failed)), None);
    assert_eq!((s.collected, s.collectable(None)), (0, 1));
    // Refunded: done, and the cursor moves on.
    assert_eq!(s.on_collected(0, bounty_in("refunded")).as_deref(), Some("refunded"));
    assert_eq!((s.collected, s.latest(Some(2))[1].outcome.as_deref()), (1, Some("refunded")));
    as_("anyone.testnet", r1.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR, near(10));
    assert_eq!(s.collect(None), 0, "once");
    // The second round ended before the first did: the cursor waits for the oldest, and then moves past both.
    let mut t = season();
    t.program = s.program.clone();
    t.limits = s.limits.clone();
    let a = full_round(&mut t, SLOT);
    full_round(&mut t, SLOT + 60 * MIN);
    as_with_gas("anyone.testnet", SLOT + 3 * 1440 * MIN, near(10), 400);
    assert_eq!((t.collectable(None), t.collect(None)), (2, 2));
    callback(SLOT + 3 * 1440 * MIN, near(10), PromiseResult::Successful(vec![]));
    t.on_collected(1, bounty_in("drained"));
    assert_eq!((t.collected, t.collectable(None)), (0, 1), "the second is done, the first is not");
    t.on_collected(0, bounty_in("paid"));
    assert_eq!(t.collected, 2);
    assert_eq!(a.id, r1.id);
    assert_eq!(r2.n, 2);
}

#[test]
fn a_round_is_collected_from_the_bounty_contract_it_opened_on() {
    // Season review finding 4: collect always asked the season's bounty contract of today, so a round opened on the
    // old one after a change of bounty contract was never brought home.
    let mut s = season();
    let r = full_round(&mut s, SLOT);
    as_(ADMIN, SLOT, near(10));
    s.propose(Change::Bounty { account: acc("bounty-2.maskwars.testnet") });
    as_("anyone.testnet", SLOT + CHANGE_DELAY_HOURS * NS_PER_HOUR, near(10));
    s.apply();
    as_("anyone.testnet", r.deadline_ns.0 + CHANGE_DELAY_HOURS * NS_PER_HOUR, near(10));
    assert_eq!(s.collect(None), 1);
    let text = receipts();
    assert!(text.contains(&format!("-> {BOUNTY}: call settle")), "{text}");
    assert!(!text.contains("bounty-2"), "{text}");
}

#[test]
fn limits_lowered_under_the_program_stop_the_next_round_at_once() {
    let mut s = season();
    as_(ADMIN, 0, near(10));
    s.propose(Change::Limits { limits: Limits { max_prize: U128(milli(200)), ..limits() } });
    as_("anyone.testnet", NS_PER_HOUR, near(10));
    s.apply();
    as_(SCHEDULER, SLOT, near(10));
    let msg = panics(move || {
        let _ = s.open_next();
    });
    assert!(msg.contains("the program is over the limits"), "{msg}");
}

#[test]
fn the_round_records_what_it_was_opened_with_even_if_the_program_changed_since() {
    let mut s = season();
    let attempt = open(&mut s, SLOT);
    callback(SLOT + 1, near(10), PromiseResult::Successful(vec![]));
    let _ = s.on_safe(attempt, 1, target("live-safe", LIVE_SAFE), masks(), acc(BOUNTY), Ok(()));
    let spare = s.spare.clone().unwrap();
    let sent = terms(&s);
    s.program.prize = U128(milli(900));
    let id = "s1-0001-cccccc";
    let r = opened_and_armed(&mut s, SLOT + 2, attempt, id, spare, sent, None, Ok(Some(armed_for(id)))).unwrap();
    assert_eq!(r.prize, U128(milli(350)));
}

// The final independent review of the season. Each test is the attack, run first on the code before the fix.

/// The panic message of a call that failed, or what it returned if it did not.
fn refusal<T: std::fmt::Debug>(r: std::thread::Result<T>) -> String {
    match r {
        Ok(v) => format!("no refusal: it returned {v:?}"),
        Err(e) => {
            e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap()
        }
    }
}

#[test]
fn publishing_and_exiting_in_one_transaction_takes_nobody_else_s_near() {
    // Final review, finding 1: publish_code kept the whole deposit in the treasury's balance until on_published sent
    // the change back, and the treasury counted that deposit as its own. One transaction of two actions,
    // [publish_code with A attached, exit], paid the sponsor its share of T + A; on_published then sent A less NEAR's
    // price back to it, out of the other sponsors' NEAR.
    let mut s = season();
    let wasm = b"\0asm a safe".to_vec();
    let code = b58(&env::sha256_array(&wasm));
    s.safe_codes.push(code.clone());
    let cost = GLOBAL_BYTE_COST.as_yoctonear() * wasm.len() as u128;
    // A and the thief hold half each of 20 free NEAR, and a change that waits long lets sponsors exit.
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    fund(&mut s, "thief.testnet", near(10), 0, milli(200) + near(10));
    as_(ADMIN, 0, near(10));
    s.propose(Change::Admin { account: acc("x.testnet") });
    let base = milli(200) + near(20);
    let deposit = near(100);
    // Action 1: publish with 100 NEAR attached. They sit in the treasury's balance until on_published.
    let mut c = ctx("thief.testnet", deposit, 1, base + deposit).build();
    c.input = wasm.clone().into();
    testing_env!(c);
    let _ = s.publish_code();
    // Action 2, in the same transaction, the same block: exit.
    as_("thief.testnet", 1, base + deposit);
    let exit = refusal(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.exit())));
    assert!(exit.contains("a safe code is being published"), "{exit}");
    assert_eq!(s.treasury(), near(20), "the deposit of a publication on its way is not the treasury's");
    // Nobody buys in while it is out either: once NEAR burns the price, the treasury holds less until the change
    // goes back, and a share would sell too cheap.
    testing_env!(ctx("b.testnet", near(1), 1, base + deposit + near(1)).build());
    let fund = refusal(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.fund())));
    assert!(fund.contains("a safe code is being published"), "{fund}");
    // NEAR burns the price, on_published sends the change back: the thief leaves with its 10 NEAR and no more.
    callback(2, base + deposit - cost, PromiseResult::Successful(vec![]));
    assert!(s.on_published(code, acc("thief.testnet"), U128(deposit), U128(cost), Ok(())));
    as_("thief.testnet", 3, base);
    assert_eq!(s.exit(), U128(near(10)));
}

#[test]
fn an_init_names_no_account_in_its_keys_either() {
    // Final review, finding 3: the check of init looked only at its values, so {"allotments":{"thief.testnet":"1"}}
    // passed, and a safe code that pays out by such a map would pay the thief. Every key is a plain name now.
    let s = season();
    as_(ADMIN, 0, near(10));
    let hex64 = "a1".repeat(32);
    let long = "a".repeat(33);
    for init in [
        r#"{"allotments":{"thief.testnet":"1"}}"#.to_string(),
        r#"{"a":{"b":[{"thief.near":"1"}]}}"#.to_string(),
        format!(r#"{{"allotments":{{"{hex64}":"1"}}}}"#),
        r#"{"payouts":{"0x52908400098527886e0f7030069857d2e4169ee7":"1"}}"#.to_string(),
        r#"{"Cap":"1"}"#.to_string(),
        r#"{"cap-2":"1"}"#.to_string(),
        r#"{"":"1"}"#.to_string(),
        format!(r#"{{"{long}":"1"}}"#),
    ] {
        let mut p = program();
        p.targets[1].init = init.clone();
        match s.check_program(&p) {
            Ok(()) => panic!("{init} passed"),
            Err(e) => assert!(e.contains("init names no account"), "{init}: {e}"),
        }
    }
    let mut p = program();
    p.targets[1].init = r#"{"cap":"1","_slots":[1,2],"max_9":{"per_call":"5"}}"#.into();
    assert_eq!(s.check_program(&p), Ok(()));
}

#[test]
fn a_commit_window_is_half_an_hour_at_least() {
    // Final review, finding 2: commit_minutes changed within an hour, with no floor. A window of one minute left the
    // masks no time to seal: no round was won, and every safe kept the sponsors' NEAR.
    let s = season();
    as_(ADMIN, 0, near(10));
    let mut p = program();
    p.commit_minutes = 29;
    match s.check_program(&p) {
        Ok(()) => panic!("a commit window of 29 minutes passed"),
        Err(e) => assert!(e.contains("commit_minutes: at least 30"), "{e}"),
    }
    p.commit_minutes = 30;
    assert_eq!(s.check_program(&p), Ok(()));
    let mut t = season();
    as_(ADMIN, 0, near(10));
    p.commit_minutes = 1;
    let quick = refusal(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        t.propose(Change::Program { program: p });
    })));
    assert!(quick.contains("commit_minutes: at least 30"), "{quick}");
}

#[test]
fn a_round_nobody_won_brings_its_safe_s_near_home() {
    // Final review, finding 2: a round with no seal or no drain left the 2 NEAR of its safe there for good: the safe
    // holds no key, and nothing took them back. collect now asks the safe for them once the bounty came back.
    let mut s = season();
    let r = full_round(&mut s, SLOT);
    let at = r.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR;
    as_("anyone.testnet", at, near(10));
    assert_eq!(s.collect(None), 1);
    callback(at, near(10), PromiseResult::Successful(vec![]));
    assert_eq!(s.on_collected(0, bounty_in("refunded")).as_deref(), Some("refunded"));
    let text = receipts();
    assert!(text.contains(&format!("-> {}: call reclaim()", r.safe)), "the safe is asked for its NEAR: {text}");
    assert!(text.contains("call on_reclaimed({\"index\":0})"), "{text}");
    // The bounty is home; the safe's 2 NEAR count as out until the safe has sent them, and the round is done.
    assert_eq!((s.outstanding, s.collected), (near(2), 1));
    assert_eq!(s.latest(Some(1))[0].reclaimed, None);
    callback(at + 1, near(12), PromiseResult::Successful(vec![]));
    assert!(s.on_reclaimed(0));
    assert_eq!((s.outstanding, s.latest(Some(1))[0].reclaimed), (0, Some(true)));

    // A round a mask won: its safe's NEAR went to the winner, and nobody asks the safe for anything.
    let mut s = season();
    let r = full_round(&mut s, SLOT);
    let at = r.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR;
    callback(at, near(10), PromiseResult::Successful(vec![]));
    assert_eq!(s.on_collected(0, bounty_in("drained")).as_deref(), Some("drained"));
    assert!(!receipts().contains("reclaim"), "{}", receipts());
    assert_eq!((s.outstanding, s.latest(Some(1))[0].reclaimed), (0, Some(false)));

    // A safe that does not send (it refused, or ran out of gas): its NEAR stays there, and stops counting as out.
    let mut s = season();
    let r = full_round(&mut s, SLOT);
    let at = r.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR;
    callback(at, near(10), PromiseResult::Successful(vec![]));
    s.on_collected(0, bounty_in("refunded"));
    callback(at + 1, near(10), PromiseResult::Failed);
    assert!(!s.on_reclaimed(0));
    assert_eq!((s.outstanding, s.latest(Some(1))[0].reclaimed), (0, Some(false)));
    assert!(get_logs().iter().any(|l| l.contains("did not send its NEAR home")), "{:?}", get_logs());
}

#[test]
fn collect_takes_only_as_many_rounds_as_its_gas_carries_home() {
    // A round nobody won takes its safe's reclaim along: collect sends a round only with the gas for the whole way,
    // and never fails half-way for lack of it.
    let mut s = season();
    s.program.every_minutes = 60;
    s.program.first_minute = 0;
    s.limits.max_per_day = 10;
    let mut last = full_round(&mut s, SLOT);
    for k in 1..3 {
        last = full_round(&mut s, SLOT + k * 60 * MIN);
    }
    let at = last.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR;
    for (tgas, asked) in [(100, 0), (300, 1), (400, 2)] {
        as_with_gas("anyone.testnet", at, near(10), tgas);
        assert_eq!(s.collect(None), asked, "{tgas} TGas");
        assert_eq!(receipts().matches("call on_collected").count(), asked as usize, "{tgas} TGas");
    }
}

#[test]
fn a_spare_safe_s_near_counts_as_the_treasury_s_while_it_waits() {
    // A safe made for a round that did not open waits as the spare, with its NEAR, for the next round: it is the
    // treasury's, so a sponsor who funds meanwhile buys it at its price, and nobody funds mid-way through a round.
    let mut s = season();
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    let attempt = open(&mut s, SLOT);
    // While the round is on its way, nobody buys in: the treasury's balance is not what it has.
    testing_env!(ctx("b.testnet", near(1), SLOT, milli(200) + near(10) + near(1)).build());
    let mid = refusal(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| s.fund())));
    assert!(mid.contains("a round is on its way"), "{mid}");
    callback(SLOT + 1, near(10), ok_state());
    let _ = s.on_bounty_state(attempt, Ok(serde_json::from_slice(&state_bytes()).unwrap()));
    callback(SLOT + 1, near(8), PromiseResult::Successful(vec![]));
    let _ = s.on_safe(attempt, 1, target("live-safe", LIVE_SAFE), masks(), acc(BOUNTY), Ok(()));
    let spare = s.spare.clone().unwrap();
    callback(SLOT + 2, near(8), PromiseResult::Failed);
    let _ = s.on_opened(attempt, "s1-0001-aaaaaa".into(), spare, terms(&s), Err(PromiseError::Failed));
    // 8 NEAR free and 2 in the spare safe: B's 1 NEAR buys a tenth of what A had.
    fund(&mut s, "b.testnet", near(1), SLOT + MIN, milli(200) + near(8));
    as_("b.testnet", SLOT + MIN, milli(200) + near(9));
    let (a, b) = (s.held(&acc("a.testnet")), s.held(&acc("b.testnet")));
    assert_eq!(b * 10, a, "B bought at the price of 10 NEAR: free and the spare's");
}

#[test]
fn a_buyer_just_before_a_safe_s_near_comes_home_takes_nobody_s_part() {
    // The safe's NEAR counts as the treasury's while the round is out, as its bounty does (V1): a sponsor who comes
    // just before it comes home buys it at its price.
    let mut s = season();
    fund(&mut s, "a.testnet", near(10), 0, milli(200));
    let r = full_round(&mut s, SLOT);
    assert_eq!(s.outstanding, milli(350) + near(2));
    let after_round = milli(200) + near(10) - near(2) - milli(350);
    as_(ADMIN, SLOT, near(10));
    s.propose(Change::Admin { account: acc("x.testnet") });
    fund(&mut s, "thief.testnet", near(1), SLOT + MIN, after_round);
    // Nobody won: the bounty and then the safe's NEAR (less its storage) come home.
    let at = r.deadline_ns.0 + COLLECT_AFTER_HOURS * NS_PER_HOUR;
    let home = after_round + near(1) + milli(350) + near(2) - milli(5);
    callback(at, home, PromiseResult::Successful(vec![]));
    s.on_collected(0, bounty_in("refunded"));
    callback(at + 1, home, PromiseResult::Successful(vec![]));
    s.on_reclaimed(0);
    as_("thief.testnet", at + 2, home);
    let took = s.exit().0;
    assert!(took <= near(1), "the thief takes back no more than it put in: {took}");
    as_("a.testnet", at + 2, home - took);
    assert!(s.share_of(acc("a.testnet")).0 >= near(10) - milli(6), "A keeps what came home");
}
