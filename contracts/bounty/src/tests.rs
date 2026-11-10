use super::*;
use crate::admin::{CHANGE_DELAY_HOURS, CHANGE_NOTICE_HOURS};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const ID: &str = "race-0001";
const HOUR: u64 = NS_PER_HOUR;
const CONTRACT: &str = "bounty.maskwars.testnet";
const ADMIN: &str = "maskwars.testnet";
const VERSION: &str = "018b7143aa00000000000000000000000000000000000000000000000000c200";
const VERSION_2: &str = "5048c29063c3c1f3b5ac86e66f8153eb0f28083b671fe33967a29e8512b808b0";
const SAFE_CODE: &str = "7Hq3rXbK9mP2vW5yZ8cD1fG4hJ6kL9nQ2sT5uV8wX1yA";
/// What a sandbox claim attaches: the judge's fee and the claim's own storage.
const FEE: NearToken = NearToken::from_millinear(20);

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// A block a second.
fn ctx(who: &str, deposit: NearToken, now: u64) -> VMContextBuilder {
    let mut c = VMContextBuilder::new();
    c.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(who))
        .attached_deposit(deposit)
        .block_timestamp(now)
        .block_height(now / 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    c
}

fn as_(who: &str, deposit: NearToken, now: u64) {
    testing_env!(ctx(who, deposit, now).build());
}

fn zero() -> NearToken {
    NearToken::from_near(0)
}

/// The judge the contract shows for new bounties: what a team agrees to when it opens one.
fn judge_of(c: &Bounties) -> String {
    c.judge()["version"].as_str().unwrap().to_string()
}

/// The masks a sandbox race in these tests may pay.
fn sandbox_masks() -> Vec<AccountId> {
    vec![acc("nova.maskwars.testnet"), acc("onyx.maskwars.testnet"), acc("nobody-here.testnet")]
}

fn contract() -> Bounties {
    as_(ADMIN, zero(), 0);
    Bounties::new(
        acc("outlayer.testnet"),
        "maskwars.testnet/judge".into(),
        VERSION.into(),
        acc(ADMIN),
        vec![SAFE_CODE.into()],
    )
}

fn opened() -> Bounties {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(5), 0);
    c.open(ID.into(), "open-admin".into(), 24, VERSION.into(), sandbox_masks());
    c
}

/// The number the next claim gets.
fn next(c: &Bounties) -> u64 {
    c.next_claim
}

fn sandbox_claim(c: &mut Bounties, who: &str, run: u64, at: u64) -> u64 {
    as_(who, FEE, at);
    let no = next(c);
    let _ = c.claim(ID.into(), U64(run));
    no
}

fn claimed() -> Bounties {
    let mut c = opened();
    sandbox_claim(&mut c, "nova.maskwars.testnet", 42, HOUR);
    c
}

/// OutLayer hands the callback the judge's stdout as a JSON string, or a failed promise.
fn reply_of(reply: Option<&str>) -> PromiseResult {
    match reply {
        Some(s) => PromiseResult::Successful(serde_json::to_vec(&Some(s.to_string())).unwrap()),
        None => PromiseResult::Failed,
    }
}

/// The callback as OutLayer delivers it, called by the contract itself.
fn answer(
    c: &mut Bounties,
    id: &str,
    drain: Option<Drain>,
    claim: u64,
    result: PromiseResult,
    at: u64,
) -> Option<Status> {
    testing_env!(
        ctx(CONTRACT, zero(), at).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    c.on_judged(id.into(), drain, Some(U64(claim)))
}

fn judge_says(c: &mut Bounties, claim: u64, reply: Option<&str>) -> Status {
    answer(c, ID, None, claim, reply_of(reply), 2 * HOUR).unwrap()
}

fn yes(id: &str, winner: &str) -> String {
    json!({ "success": true, "output": { "bounty_id": id, "winner": winner, "run_id": "42" }, "error": null })
        .to_string()
}

fn paid_back(c: &mut Bounties, id: &str, ok: bool) -> Option<Status> {
    as_(CONTRACT, zero(), 3 * HOUR);
    c.on_paid(id.into(), if ok { Ok(()) } else { Err(PromiseError::Failed) })
}

fn terms(c: &Bounties, id: &str) -> Terms {
    c.get_terms(id.into()).unwrap()
}

#[test]
fn open_locks_the_deposit_until_the_deadline() {
    let c = opened();
    let b = c.get(ID.into()).unwrap();
    assert_eq!(b.owner, acc("team.testnet"));
    // The bounty pays for its own storage and sets aside what its final status takes: a few hundred bytes.
    let five = NearToken::from_near(5).as_yoctonear();
    assert!(b.amount.0 < five && b.amount.0 > five - NearToken::from_millinear(10).as_yoctonear(), "{:?}", b.amount);
    assert_eq!(b.deadline_ns, U64(24 * HOUR));
    assert_eq!(b.status, Status::Open);
    assert_eq!(terms(&c, ID).reserve, U128(cost_of(BOUNTY_GROWTH_BYTES)));
}

#[test]
#[should_panic(expected = "bounty: at least 0.1 NEAR")]
fn tiny_bounty_is_refused() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_millinear(50), 0);
    c.open(ID.into(), "open-admin".into(), 24, VERSION.into(), sandbox_masks());
}

#[test]
#[should_panic(expected = "this id is taken")]
fn an_id_is_used_once() {
    let mut c = opened();
    as_("other.testnet", NearToken::from_near(1), 0);
    c.open(ID.into(), "open-admin".into(), 24, VERSION.into(), sandbox_masks());
}

#[test]
#[should_panic(expected = "hours: 1 to 72")]
fn a_sandbox_race_runs_three_days_at_most() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    c.open(ID.into(), "open-admin".into(), 73, VERSION.into(), sandbox_masks());
}

#[test]
fn a_claim_does_not_lock_the_bounty() {
    let mut c = claimed();
    assert_eq!(c.get(ID.into()).unwrap().status, Status::Open);
    sandbox_claim(&mut c, "onyx.maskwars.testnet", 43, HOUR);
    assert_eq!(terms(&c, ID).judging, 2);
    assert_eq!(c.get_claim(U64(1)).unwrap().by, acc("onyx.maskwars.testnet"));
}

#[test]
fn junk_claims_do_not_block_the_real_one() {
    // The team floods the judge with claims for runs that never broke anything; the real claim comes last.
    let mut c = opened();
    let junk: Vec<u64> = (0..5).map(|n| sandbox_claim(&mut c, "team.testnet", 1000 + n, HOUR)).collect();
    let real = sandbox_claim(&mut c, "nova.maskwars.testnet", 42, HOUR);
    let status = judge_says(&mut c, real, Some(&yes(ID, "nova.maskwars.testnet")));
    assert_eq!(status, Status::Paid { winner: acc("nova.maskwars.testnet"), run_id: U64(42) });
    // The junk answers come back later and change nothing.
    let held = json!({ "success": false, "output": null, "error": "no such run" }).to_string();
    for no in junk {
        assert_eq!(judge_says(&mut c, no, Some(&held)), status);
    }
    assert_eq!(terms(&c, ID).judging, 0);
}

#[test]
fn the_judge_gets_every_bound_as_a_number() {
    let limits = judge_limits();
    for key in ["max_instructions", "max_memory_mb", "max_execution_seconds"] {
        assert!(limits[key].is_u64(), "{key}");
    }
}

#[test]
#[should_panic(expected = "attach at least 0.01 NEAR for the judge and the claim's storage")]
fn a_claim_pays_for_the_judge() {
    let mut c = opened();
    as_("nova.maskwars.testnet", NearToken::from_millinear(1), HOUR);
    let _ = c.claim(ID.into(), U64(42));
}

#[test]
#[should_panic(expected = "attach at least 0.01 NEAR for the judge and the claim's storage")]
fn a_claim_pays_for_its_own_storage() {
    let mut c = opened();
    as_("nova.maskwars.testnet", MIN_JUDGE_FEE, HOUR);
    let _ = c.claim(ID.into(), U64(42));
}

#[test]
fn confirmed_break_pays_the_winner_the_judge_names() {
    let mut c = claimed();
    let status = judge_says(&mut c, 0, Some(&yes(ID, "nova.maskwars.testnet")));
    assert_eq!(status, Status::Paid { winner: acc("nova.maskwars.testnet"), run_id: U64(42) });
    assert!(get_logs().iter().any(|l| l.contains("paid to nova.maskwars.testnet")));
    assert!(c.get_claim(U64(0)).is_none());
}

#[test]
fn a_bounced_payout_reopens_the_bounty() {
    let mut c = claimed();
    judge_says(&mut c, 0, Some(&yes(ID, "nobody-here.testnet")));
    assert_eq!(paid_back(&mut c, ID, false), Some(Status::Open));
    assert_eq!(c.live, 1);
}

#[test]
fn a_delivered_payout_stays_paid_and_the_unused_reserve_goes_back_to_the_team() {
    let mut c = claimed();
    judge_says(&mut c, 0, Some(&yes(ID, "nova.maskwars.testnet")));
    let paid = Status::Paid { winner: acc("nova.maskwars.testnet"), run_id: U64(42) };
    assert_eq!(paid_back(&mut c, ID, true), Some(paid));
    assert!(get_logs().iter().any(|l| l.contains("of unused storage back to team.testnet")), "{:?}", get_logs());
    assert_eq!(terms(&c, ID).reserve, U128(0));
    assert_eq!(c.live, 0);
}

#[test]
fn a_verdict_for_another_bounty_pays_nothing() {
    let mut c = claimed();
    assert_eq!(judge_says(&mut c, 0, Some(&yes("race-9999", "nova.maskwars.testnet"))), Status::Open);
}

#[test]
fn no_break_keeps_the_bounty_open() {
    let mut c = claimed();
    let held = json!({ "success": false, "output": null, "error": "vault held" }).to_string();
    assert_eq!(judge_says(&mut c, 0, Some(&held)), Status::Open);
    assert_eq!(terms(&c, ID).judging, 0);
}

#[test]
fn an_unreadable_answer_keeps_the_bounty_open() {
    let mut c = claimed();
    assert_eq!(judge_says(&mut c, 0, Some("not json")), Status::Open);
}

#[test]
fn an_answer_that_is_not_even_a_json_string_keeps_the_bounty_open() {
    let mut c = claimed();
    assert_eq!(answer(&mut c, ID, None, 0, PromiseResult::Successful(b"[1,".to_vec()), HOUR), Some(Status::Open));
}

#[test]
fn a_failed_judge_keeps_the_bounty_open() {
    let mut c = claimed();
    assert_eq!(judge_says(&mut c, 0, None), Status::Open);
}

#[test]
fn an_answer_too_long_to_read_is_no_answer() {
    // A judge that floods its stdout must not make the callback run out of gas and leave the claim hanging.
    let mut c = claimed();
    let long = format!("{{\"success\":true,\"padding\":\"{}\"}}", "x".repeat(MAX_REPLY_BYTES));
    assert_eq!(judge_says(&mut c, 0, Some(&long)), Status::Open);
    assert!(get_logs().iter().any(|l| l.contains("too long")), "{:?}", get_logs());
    assert_eq!(terms(&c, ID).judging, 0);
}

#[test]
fn an_answer_with_no_promise_result_is_no_answer() {
    let mut c = claimed();
    as_(CONTRACT, zero(), 2 * HOUR);
    assert_eq!(c.on_judged(ID.into(), None, Some(U64(0))), Some(Status::Open));
}

#[test]
fn an_answer_for_a_dropped_claim_or_a_lost_bounty_changes_nothing() {
    let mut c = claimed();
    assert_eq!(judge_says(&mut c, 7, Some(&yes(ID, "nova.maskwars.testnet"))), Status::Open);
    assert!(get_logs().iter().any(|l| l.contains("was dropped before the judge answered")));
    assert_eq!(answer(&mut c, "race-9999", None, 0, reply_of(Some("x")), HOUR), None);
}

#[test]
#[should_panic(expected = "the race is still on")]
fn no_refund_before_the_deadline() {
    let mut c = opened();
    as_("team.testnet", zero(), HOUR);
    c.refund(ID.into());
}

#[test]
#[should_panic(expected = "the masks can still claim")]
fn a_sandbox_race_has_a_claim_grace_too() {
    let mut c = opened();
    as_("team.testnet", zero(), 24 * HOUR);
    c.refund(ID.into());
}

#[test]
fn a_break_made_before_the_deadline_is_claimed_in_the_grace() {
    let mut c = opened();
    sandbox_claim(&mut c, "nova.maskwars.testnet", 42, 35 * HOUR);
    assert_eq!(terms(&c, ID).judging, 1);
}

#[test]
#[should_panic(expected = "the race is over")]
fn no_claim_after_the_grace() {
    let mut c = opened();
    sandbox_claim(&mut c, "nova.maskwars.testnet", 42, 36 * HOUR);
}

#[test]
fn after_the_grace_the_team_gets_its_near_back() {
    let mut c = opened();
    as_("anyone.testnet", zero(), 36 * HOUR);
    assert_eq!(c.refund(ID.into()), Status::Refunded);
    assert_eq!(c.get(ID.into()).unwrap().status, Status::Refunded);
    assert!(get_logs().iter().any(|l| l.contains("of unused storage back to team.testnet")));
    assert_eq!(c.live, 0);
}

#[test]
#[should_panic(expected = "a claim is still with the judge")]
fn no_refund_while_a_claim_is_with_the_judge() {
    let mut c = opened();
    sandbox_claim(&mut c, "nova.maskwars.testnet", 42, 35 * HOUR);
    as_("team.testnet", zero(), 36 * HOUR);
    c.refund(ID.into());
}

#[test]
#[should_panic(expected = "the judge may still answer")]
fn a_claim_is_not_dropped_while_the_judge_may_answer() {
    let mut c = claimed();
    as_("anyone.testnet", zero(), HOUR + (CLAIM_TIMEOUT_BLOCKS - 1) * 1_000_000_000);
    c.unstick(ID.into(), Some(U64(0)));
}

#[test]
fn a_claim_the_judge_never_answered_is_dropped_and_the_team_is_refunded() {
    // The judge's answer is lost (its callback failed, or OutLayer never called back): the bounty must not hang.
    let mut c = opened();
    sandbox_claim(&mut c, "nova.maskwars.testnet", 42, 35 * HOUR);
    let later = 35 * HOUR + CLAIM_TIMEOUT_BLOCKS * 1_000_000_000;
    as_("anyone.testnet", zero(), later);
    assert_eq!(c.unstick(ID.into(), Some(U64(0))), Status::Open);
    assert_eq!(terms(&c, ID).judging, 0);
    assert!(c.get_claim(U64(0)).is_none());
    as_("team.testnet", zero(), later.max(36 * HOUR));
    assert_eq!(c.refund(ID.into()), Status::Refunded);
    // The lost answer turns up after all: ignored.
    assert_eq!(judge_says(&mut c, 0, Some(&yes(ID, "nova.maskwars.testnet"))), Status::Refunded);
}

#[test]
#[should_panic(expected = "attach at least 180 TGas")]
fn a_claim_brings_gas_for_the_judge() {
    let mut c = opened();
    testing_env!(ctx("nova.maskwars.testnet", FEE, HOUR).prepaid_gas(Gas::from_tgas(100)).build());
    let _ = c.claim(ID.into(), U64(42));
}

// ---- live safe: a sealed round ----

const SAFE_ID: &str = "race-0004";
const SAFE: &str = "safe-0002.maskwars.testnet";
const NOVA: &str = "nova.maskwars.testnet";
const ONYX: &str = "onyx.maskwars.testnet";
// NOVA's two transactions on the safe: set_owner, then the sweep that drains it.
const NOVA_OWNER_TX: &str = "7vZy5fJ3bQhW2nT8kR4mX1cLpA6sDgE7uYoHiNjKwMzV";
const TX: &str = "9vZy5fJ3bQhW2nT8kR4mX1cLpA6sDgE7uYoHiNjKwMzV";
const ONYX_OWNER_TX: &str = "5vZy5fJ3bQhW2nT8kR4mX1cLpA6sDgE7uYoHiNjKwMzV";
const ONYX_TX: &str = "6vZy5fJ3bQhW2nT8kR4mX1cLpA6sDgE7uYoHiNjKwMzV";
const SALT: &str = "salt-0123456789abcdef";
const MINUTE: u64 = NS_PER_MINUTE;
const OPEN_AT: u64 = 1_000;
const COMMIT_END: u64 = OPEN_AT + 30 * MINUTE;
const REVEAL_END: u64 = COMMIT_END + DEFAULT_REVEAL_MINUTES * MINUTE;
/// After the commit window, inside the reveal window.
const PLAY: u64 = COMMIT_END + MINUTE;
const DEADLINE: u64 = OPEN_AT + 24 * HOUR;

fn masks() -> Vec<AccountId> {
    vec![acc(NOVA), acc(ONYX)]
}

/// The plan the live safe's hole takes: become the owner, then sweep 2 NEAR to oneself.
fn plan_of(mask: &str) -> String {
    json!([
        { "method": "set_owner", "args": { "new_owner": mask } },
        { "method": "sweep", "args": { "to": mask, "amount": NearToken::from_near(2).as_yoctonear().to_string() } },
    ])
    .to_string()
}

fn txs_of(mask: &str) -> Vec<String> {
    match mask {
        NOVA => vec![NOVA_OWNER_TX.into(), TX.into()],
        _ => vec![ONYX_OWNER_TX.into(), ONYX_TX.into()],
    }
}

fn drain_of(mask: &str) -> &'static str {
    if mask == NOVA {
        TX
    } else {
        ONYX_TX
    }
}

fn open_round(c: &mut Bounties, masks: Vec<AccountId>, deposit: NearToken) -> Bounty {
    as_("team.testnet", deposit, OPEN_AT);
    let loot = U128(NearToken::from_near(2).as_yoctonear());
    c.open_safe(SAFE_ID.into(), acc(SAFE), masks, loot, 24, 30, None, SAFE_CODE.into(), judge_of(&c))
}

fn safe_opened() -> Bounties {
    let mut c = contract();
    open_round(&mut c, masks(), NearToken::from_near(1));
    c
}

fn seal(c: &mut Bounties, mask: &str, plan: &str, at: u64) -> Seal {
    as_(mask, zero(), at);
    let hash = seal_hash(SAFE_ID, &acc(mask), SALT, plan);
    c.commit(SAFE_ID.into(), hash)
}

fn reveal(c: &mut Bounties, mask: &str, plan: &str, at: u64) -> Seal {
    as_(mask, zero(), at);
    c.reveal(SAFE_ID.into(), plan.into(), SALT.into(), txs_of(mask))
}

/// The mask sealed its plan, played it and revealed it.
fn sealed_and_revealed(c: &mut Bounties, mask: &str) {
    reveal(c, mask, &plan_of(mask), PLAY);
}

/// NOVA alone sealed its plan in the window and revealed it after.
fn nova_revealed() -> Bounties {
    let mut c = safe_opened();
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
    sealed_and_revealed(&mut c, NOVA);
    c
}

/// The mask claims its drain; returns the claim's number.
fn claim_as(c: &mut Bounties, mask: &str, deposit: NearToken, at: u64) -> u64 {
    as_(mask, deposit, at);
    let no = next(c);
    let _ = c.claim_drain(SAFE_ID.into(), drain_of(mask).into());
    no
}

fn drain_claimed() -> Bounties {
    let mut c = nova_revealed();
    claim_as(&mut c, NOVA, MIN_JUDGE_FEE, PLAY);
    c
}

fn drain(tx: &str, mask: &str) -> Option<Drain> {
    Some(Drain { tx_hash: tx.into(), mask: acc(mask) })
}

fn judge_says_drain_of(c: &mut Bounties, mask: &str, claim: u64, reply: &str, at: u64) -> Status {
    answer(c, SAFE_ID, drain(drain_of(mask), mask), claim, reply_of(Some(reply)), at).unwrap()
}

fn judge_says_drain(c: &mut Bounties, claim: u64, reply: &str) -> Status {
    judge_says_drain_of(c, NOVA, claim, reply, PLAY)
}

fn drained(id: &str, winner: &str, tx: &str) -> String {
    json!({ "success": true, "output": { "bounty_id": id, "winner": winner, "tx_hash": tx, "loot": "1", "block_height": 7 }, "error": null })
        .to_string()
}

fn refused() -> String {
    json!({ "success": false, "output": null, "error": "the transaction does not make the plan's call" }).to_string()
}

fn state_of(c: &Bounties, mask: &str) -> SealState {
    c.get_round(SAFE_ID.into()).unwrap().seals.into_iter().find(|s| s.mask == acc(mask)).unwrap().state
}

fn prize(c: &Bounties) -> u128 {
    c.get(SAFE_ID.into()).unwrap().amount.0
}

#[test]
fn a_seal_is_the_sha256_both_sides_compute() {
    // The same vector is checked in packages/race/test/seal.test.ts, where the masks compute their seals.
    as_(CONTRACT, zero(), 0);
    let plan = r#"[{"method":"set_owner","args":{"new_owner":"nova.tinygif8324.testnet"}},{"method":"sweep","args":{"to":"nova.tinygif8324.testnet","amount":"1000000000000000000000000"}}]"#;
    assert_eq!(
        seal_hash("race-0004", &acc("nova.tinygif8324.testnet"), "0123456789abcdef0123456789abcdef", plan),
        "cce78cfbfb2d6aee8c1b5aed63ee1fdc5c1efe8cab8a421bae8a200979e6ca10"
    );
}

#[test]
fn a_live_race_keeps_its_safe_masks_start_round_and_terms() {
    let c = safe_opened();
    let race = c.get_safe(SAFE_ID.into()).unwrap();
    assert_eq!(race.safe, acc(SAFE));
    assert_eq!(race.masks, masks());
    assert_eq!(race.opened_ns, U64(OPEN_AT));
    assert_eq!(c.get(SAFE_ID.into()).unwrap().target, SAFE);
    assert!(c.get_safe(ID.into()).is_none());
    let round = c.get_round(SAFE_ID.into()).unwrap();
    assert_eq!(round.commit_until, U64(COMMIT_END));
    assert_eq!(round.reveal_until, U64(REVEAL_END));
    assert_eq!(round.deadline_ns, U64(DEADLINE));
    assert!(round.seals.is_empty() && round.judging.is_empty());
    let t = terms(&c, SAFE_ID);
    assert_eq!(t.judge_version, VERSION);
    assert_eq!(t.safe_code.as_deref(), Some(SAFE_CODE));
    assert_eq!(t.reserve, U128(cost_of(BOUNTY_GROWTH_BYTES + 2 * MASK_STORAGE_BYTES)));
}

#[test]
#[should_panic(expected = "hours: a sealed round runs 24 hours at most")]
fn a_round_ends_while_the_rpc_still_keeps_its_opening_block() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    c.open_safe(
        SAFE_ID.into(),
        acc(SAFE),
        masks(),
        U128(MIN_LOOT.as_yoctonear()),
        72,
        30,
        None,
        SAFE_CODE.into(),
        judge_of(&c),
    );
}

#[test]
#[should_panic(expected = "the safe's code is not one the contract knows")]
fn a_round_runs_only_on_a_known_safe() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    let fake = "11111111111111111111111111111111";
    c.open_safe(
        SAFE_ID.into(),
        acc(SAFE),
        masks(),
        U128(MIN_LOOT.as_yoctonear()),
        24,
        30,
        None,
        fake.into(),
        judge_of(&c),
    );
}

#[test]
#[should_panic(expected = "bounty: at least 0.1 NEAR beyond its storage")]
fn a_round_sets_aside_the_storage_of_every_mask() {
    let mut c = contract();
    let sixteen: Vec<AccountId> = (0..16).map(|i| acc(&format!("mask{i}.maskwars.testnet"))).collect();
    open_round(&mut c, sixteen, NearToken::from_millinear(500));
}

#[test]
#[should_panic(expected = "commit_minutes: at least 1 and less than the race")]
fn the_commit_window_ends_before_the_race() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    c.open_safe(
        SAFE_ID.into(),
        acc(SAFE),
        masks(),
        U128(MIN_LOOT.as_yoctonear()),
        1,
        60,
        None,
        SAFE_CODE.into(),
        judge_of(&c),
    );
}

#[test]
#[should_panic(expected = "commit_minutes: at least 1 and less than the race")]
fn a_round_has_a_commit_window() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    c.open_safe(
        SAFE_ID.into(),
        acc(SAFE),
        masks(),
        U128(MIN_LOOT.as_yoctonear()),
        24,
        0,
        None,
        SAFE_CODE.into(),
        judge_of(&c),
    );
}

#[test]
#[should_panic(expected = "reveal_minutes: 3 for each mask's turn on the safe, and 3 more")]
fn the_reveal_window_gives_every_sealed_mask_its_slot_on_the_safe() {
    // The turns go in the order of the seals, each earlier seal holding a later one up to 3 minutes: with two masks
    // the second may start 3 minutes after the window and needs its own 3 to play.
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    let loot = U128(MIN_LOOT.as_yoctonear());
    c.open_safe(SAFE_ID.into(), acc(SAFE), masks(), loot, 24, 30, Some(8), SAFE_CODE.into(), judge_of(&c));
}

#[test]
#[should_panic(expected = "reveal_minutes: at least 1, and the windows fit in the race")]
fn the_reveal_window_fits_in_the_race() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    c.open_safe(
        SAFE_ID.into(),
        acc(SAFE),
        masks(),
        U128(MIN_LOOT.as_yoctonear()),
        1,
        30,
        Some(31),
        SAFE_CODE.into(),
        judge_of(&c),
    );
}

#[test]
fn seals_are_numbered_as_they_arrive_and_show_no_plan() {
    let mut c = safe_opened();
    let (before, reserve) = (prize(&c), terms(&c, SAFE_ID).reserve.0);
    let onyx = seal(&mut c, ONYX, &plan_of(ONYX), OPEN_AT + MINUTE);
    let nova = seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + 2 * MINUTE);
    assert_eq!((onyx.seq, nova.seq), (0, 1));
    let round = c.get_round(SAFE_ID.into()).unwrap();
    assert_eq!(round.seals.iter().map(|s| s.mask.to_string()).collect::<Vec<_>>(), vec![ONYX, NOVA]);
    assert!(round.seals.iter().all(|s| s.plan.is_none() && s.salt.is_none() && s.state == SealState::Sealed));
    assert_eq!(round.seals[1].hash, seal_hash(SAFE_ID, &acc(NOVA), SALT, &plan_of(NOVA)));
    // The reserve pays the seals' storage: the masks' keys attach nothing, and the prize stays whole.
    assert_eq!(prize(&c), before);
    assert!(terms(&c, SAFE_ID).reserve.0 < reserve);
}

#[test]
#[should_panic(expected = "the commit window is closed")]
fn no_seal_after_the_window() {
    let mut c = safe_opened();
    seal(&mut c, NOVA, &plan_of(NOVA), COMMIT_END);
}

#[test]
#[should_panic(expected = "only a mask of this race can seal a plan")]
fn a_stranger_cannot_seal() {
    let mut c = safe_opened();
    seal(&mut c, "stranger.testnet", "[]", OPEN_AT + MINUTE);
}

#[test]
#[should_panic(expected = "this mask has already sealed its plan")]
fn a_seal_is_final() {
    let mut c = safe_opened();
    seal(&mut c, NOVA, "[]", OPEN_AT + MINUTE);
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + 2 * MINUTE);
}

#[test]
#[should_panic(expected = "hash: sha256 in lowercase hex")]
fn a_seal_is_a_hash() {
    let mut c = safe_opened();
    as_(NOVA, zero(), OPEN_AT + MINUTE);
    c.commit(SAFE_ID.into(), plan_of(NOVA));
}

#[test]
#[should_panic(expected = "the commit window is still open: reveal after it")]
fn no_reveal_in_the_window() {
    let mut c = safe_opened();
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
    reveal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + 2 * MINUTE);
}

#[test]
#[should_panic(expected = "the reveal window is closed")]
fn no_reveal_after_the_reveal_window() {
    let mut c = safe_opened();
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
    reveal(&mut c, NOVA, &plan_of(NOVA), REVEAL_END);
}

#[test]
fn a_reveal_makes_the_plan_public() {
    let c = nova_revealed();
    let s = c.get_round(SAFE_ID.into()).unwrap().seals.remove(0);
    assert_eq!(s.state, SealState::Revealed);
    assert_eq!(s.plan.as_deref(), Some(plan_of(NOVA).as_str()));
    assert_eq!(s.salt.as_deref(), Some(SALT));
    assert_eq!(s.txs, txs_of(NOVA));
}

#[test]
#[should_panic(expected = "the plan does not match the seal")]
fn a_peeked_plan_does_not_match_an_earlier_seal() {
    // ONYX sealed a guess early. After the window it sees NOVA's plan on chain and tries to pass it off as its own.
    let mut c = safe_opened();
    seal(&mut c, ONYX, r#"[{"method":"sweep","args":{}}]"#, OPEN_AT + MINUTE);
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + 2 * MINUTE);
    sealed_and_revealed(&mut c, NOVA);
    reveal(&mut c, ONYX, &plan_of(ONYX), PLAY);
}

#[test]
#[should_panic(expected = "the plan does not match the seal")]
fn a_copied_seal_seals_nothing() {
    // ONYX copies NOVA's hash in the window, then reveals NOVA's plan and salt: the hash holds NOVA's name.
    let mut c = safe_opened();
    let nova = seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
    as_(ONYX, zero(), OPEN_AT + 2 * MINUTE);
    c.commit(SAFE_ID.into(), nova.hash);
    reveal(&mut c, ONYX, &plan_of(NOVA), PLAY);
}

#[test]
#[should_panic(expected = "this mask sealed no plan")]
fn no_reveal_without_a_seal() {
    let mut c = safe_opened();
    reveal(&mut c, ONYX, &plan_of(ONYX), PLAY);
}

#[test]
#[should_panic(expected = "one transaction per call of the plan")]
fn a_reveal_names_a_transaction_per_call() {
    let mut c = safe_opened();
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
    as_(NOVA, zero(), PLAY);
    c.reveal(SAFE_ID.into(), plan_of(NOVA), SALT.into(), vec![TX.into()]);
}

#[test]
#[should_panic(expected = "plan: a JSON array of { method, args }")]
fn a_plan_is_calls() {
    let mut c = safe_opened();
    seal(&mut c, NOVA, "drain it", OPEN_AT + MINUTE);
    reveal(&mut c, NOVA, "drain it", PLAY);
}

#[test]
#[should_panic(expected = "reveal the plan before claiming")]
fn no_claim_before_the_reveal() {
    let mut c = safe_opened();
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
    claim_as(&mut c, NOVA, MIN_JUDGE_FEE, PLAY);
}

#[test]
#[should_panic(expected = "the drain is not a transaction of the revealed plan")]
fn the_drain_is_in_the_revealed_plan() {
    let mut c = nova_revealed();
    as_(NOVA, MIN_JUDGE_FEE, PLAY);
    let _ = c.claim_drain(SAFE_ID.into(), ONYX_TX.into());
}

#[test]
#[should_panic(expected = "this mask sealed no plan")]
fn a_mask_that_sealed_nothing_cannot_claim() {
    let mut c = nova_revealed();
    claim_as(&mut c, ONYX, MIN_JUDGE_FEE, PLAY);
}

#[test]
fn a_drain_claim_asks_the_judge_about_the_plan_its_transactions_and_the_safe() {
    let c = drain_claimed();
    assert_eq!(c.get(SAFE_ID.into()).unwrap().status, Status::Open);
    assert_eq!(c.get_round(SAFE_ID.into()).unwrap().judging, vec![acc(NOVA)]);
    // A drain counts as claimed only once the judge confirms it.
    assert_eq!(c.drain_claimed(TX.into()), None);
    let b = c.get(SAFE_ID.into()).unwrap();
    let round = c.round(SAFE_ID);
    let s = c.seals.get(&seal_key(SAFE_ID, &acc(NOVA))).unwrap().clone();
    let q = drain_input(SAFE_ID, &c.get_safe(SAFE_ID.into()).unwrap(), &round, &b, &terms(&c, SAFE_ID), &s, TX);
    assert_eq!(
        q,
        json!({ "kind": "drain", "contract": CONTRACT, "bounty_id": SAFE_ID, "safe": SAFE, "mask": NOVA, "tx_hash": TX,
                "min_loot": NearToken::from_near(2).as_yoctonear().to_string(),
                // A drain counts only once the commit window is over.
                "opened_ns": COMMIT_END.to_string(),
                "commit_until": COMMIT_END.to_string(),
                "deadline_ns": DEADLINE.to_string(),
                "plan": serde_json::from_str::<Value>(&plan_of(NOVA)).unwrap(),
                "plan_txs": [NOVA_OWNER_TX, TX],
                "opened_height": "0",
                "safe_code": SAFE_CODE,
                "masks": [NOVA, ONYX] })
    );
}

#[test]
#[should_panic(expected = "only a mask of this race can win it")]
fn only_the_mask_claims_its_drain() {
    let mut c = nova_revealed();
    as_("team.testnet", MIN_JUDGE_FEE, PLAY);
    let _ = c.claim_drain(SAFE_ID.into(), TX.into());
}

#[test]
#[should_panic(expected = "tx_hash: a NEAR transaction hash")]
fn a_drain_names_a_real_transaction_hash() {
    let mut c = nova_revealed();
    as_(NOVA, MIN_JUDGE_FEE, PLAY);
    let _ = c.claim_drain(SAFE_ID.into(), "0xdeadbeef".into());
}

#[test]
#[should_panic(expected = "this bounty pays for a drain on chain: use claim_drain")]
fn a_live_race_is_not_paid_from_github() {
    let mut c = safe_opened();
    as_("anyone.testnet", FEE, PLAY);
    let _ = c.claim(SAFE_ID.into(), U64(42));
}

#[test]
#[should_panic(expected = "this bounty is a sandbox race: use claim")]
fn a_sandbox_race_is_not_paid_for_a_drain() {
    let mut c = opened();
    as_(NOVA, MIN_JUDGE_FEE, HOUR);
    let _ = c.claim_drain(ID.into(), TX.into());
}

#[test]
fn the_earliest_seal_confirmed_is_paid_at_once() {
    let mut c = drain_claimed();
    let status = judge_says_drain(&mut c, 0, &drained(SAFE_ID, NOVA, TX));
    assert_eq!(status, Status::Drained { winner: acc(NOVA), tx_hash: TX.into() });
    assert_eq!(c.drain_claimed(TX.into()), Some(SAFE_ID.into()));
    assert!(get_logs().iter().any(|l| l.contains("paid to nova.maskwars.testnet for seal #0")));
    assert_eq!(state_of(&c, NOVA), SealState::Confirmed);
    assert_eq!(paid_back(&mut c, SAFE_ID, true), Some(status));
}

/// NOVA sealed first, ONYX second. ONYX played first on the safe and was confirmed; NOVA, which played after it, is
/// refused by the judge (its plan started on a safe someone had already moved).
fn two_masks() -> Bounties {
    let mut c = safe_opened();
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
    seal(&mut c, ONYX, &plan_of(ONYX), OPEN_AT + 2 * MINUTE);
    c
}

#[test]
fn a_later_confirmed_seal_waits_for_an_unrevealed_earlier_seal_only_until_the_reveal_window_ends() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, ONYX);
    let no = claim_as(&mut c, ONYX, MIN_JUDGE_FEE, PLAY);
    assert_eq!(judge_says_drain_of(&mut c, ONYX, no, &drained(SAFE_ID, ONYX, ONYX_TX), PLAY), Status::Open);
    assert!(get_logs().iter().any(|l| l.contains("an earlier seal can still win")));
    // NOVA never reveals. Its seal holds ONYX back until the reveal window closes, not until the deadline.
    as_("anyone.testnet", zero(), REVEAL_END);
    assert_eq!(c.settle(SAFE_ID.into()), Status::Drained { winner: acc(ONYX), tx_hash: ONYX_TX.into() });
}

#[test]
#[should_panic(expected = "an earlier seal can still win")]
fn no_settle_while_an_earlier_seal_is_in_play() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, ONYX);
    let no = claim_as(&mut c, ONYX, MIN_JUDGE_FEE, PLAY);
    judge_says_drain_of(&mut c, ONYX, no, &drained(SAFE_ID, ONYX, ONYX_TX), PLAY);
    as_("anyone.testnet", zero(), REVEAL_END - 1);
    c.settle(SAFE_ID.into());
}

#[test]
fn an_earlier_claim_with_the_judge_holds_a_confirmed_seal_until_it_is_answered() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, NOVA);
    sealed_and_revealed(&mut c, ONYX);
    let nova = claim_as(&mut c, NOVA, zero(), PLAY);
    // Both claims are with the judge side by side.
    let onyx = claim_as(&mut c, ONYX, zero(), PLAY);
    assert_eq!(c.get_round(SAFE_ID.into()).unwrap().judging, masks());
    assert_eq!(judge_says_drain_of(&mut c, ONYX, onyx, &drained(SAFE_ID, ONYX, ONYX_TX), PLAY), Status::Open);
    // Past the reveal window NOVA still holds ONYX back: its claim may yet be confirmed.
    as_("anyone.testnet", zero(), REVEAL_END + HOUR);
    assert!(c.winner(SAFE_ID).is_err());
    // NOVA's claim is refused: ONYX is paid in the same answer.
    let status = judge_says_drain_of(&mut c, NOVA, nova, &refused(), REVEAL_END + HOUR);
    assert_eq!(status, Status::Drained { winner: acc(ONYX), tx_hash: ONYX_TX.into() });
    assert_eq!(state_of(&c, NOVA), SealState::Refused);
}

#[test]
fn a_refused_earlier_seal_lets_a_later_one_be_paid_at_once() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, NOVA);
    sealed_and_revealed(&mut c, ONYX);
    let nova = claim_as(&mut c, NOVA, MIN_JUDGE_FEE, PLAY);
    judge_says_drain_of(&mut c, NOVA, nova, &refused(), PLAY);
    let onyx = claim_as(&mut c, ONYX, MIN_JUDGE_FEE, PLAY);
    let status = judge_says_drain_of(&mut c, ONYX, onyx, &drained(SAFE_ID, ONYX, ONYX_TX), PLAY);
    assert_eq!(status, Status::Drained { winner: acc(ONYX), tx_hash: ONYX_TX.into() });
}

#[test]
fn an_unrevealed_earlier_seal_drops_out_and_the_grace_still_pays() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, ONYX);
    let no = claim_as(&mut c, ONYX, MIN_JUDGE_FEE, PLAY);
    judge_says_drain_of(&mut c, ONYX, no, &drained(SAFE_ID, ONYX, ONYX_TX), PLAY);
    as_("anyone.testnet", zero(), DEADLINE + HOUR);
    assert_eq!(c.settle(SAFE_ID.into()), Status::Drained { winner: acc(ONYX), tx_hash: ONYX_TX.into() });
}

#[test]
#[should_panic(expected = "an earlier seal is already confirmed")]
fn a_later_seal_is_not_judged_once_an_earlier_one_is_confirmed() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, NOVA);
    sealed_and_revealed(&mut c, ONYX);
    // NOVA's seal is confirmed while the round is still open (say, its payout is on its way): NOVA leads, and
    // ONYX, sealed later, is not judged at all.
    let key = seal_key(SAFE_ID, &acc(NOVA));
    let mut s = c.seals.get(&key).unwrap().clone();
    s.state = SealState::Confirmed;
    s.drain_tx = Some(TX.into());
    c.seals.insert(key, s);
    claim_as(&mut c, ONYX, MIN_JUDGE_FEE, PLAY);
}

#[test]
#[should_panic(expected = "this mask's claim is already with the judge")]
fn a_mask_has_one_claim_with_the_judge_at_a_time() {
    let mut c = drain_claimed();
    as_(NOVA, MIN_JUDGE_FEE, PLAY);
    let _ = c.claim_drain(SAFE_ID.into(), NOVA_OWNER_TX.into());
}

#[test]
fn a_verdict_about_another_drain_or_mask_pays_nothing() {
    let mut c = nova_revealed();
    for reply in [
        drained(SAFE_ID, ONYX, TX),
        drained(SAFE_ID, NOVA, "11111111111111111111111111111111"),
        drained("race-9999", NOVA, TX),
        yes(SAFE_ID, NOVA),
    ] {
        // A refused drain can be claimed again.
        let no = claim_as(&mut c, NOVA, MIN_JUDGE_FEE, PLAY);
        assert_eq!(judge_says_drain(&mut c, no, &reply), Status::Open, "{reply}");
        assert_eq!(c.drain_claimed(TX.into()), None, "{reply}");
        assert_eq!(state_of(&c, NOVA), SealState::Refused, "{reply}");
    }
}

#[test]
fn a_confirmed_drain_of_a_mask_with_no_seal_does_not_fail_the_answer() {
    let mut c = drain_claimed();
    c.seals.remove(&seal_key(SAFE_ID, &acc(NOVA)));
    assert_eq!(judge_says_drain(&mut c, 0, &drained(SAFE_ID, NOVA, TX)), Status::Open);
    assert!(get_logs().iter().any(|l| l.contains("has no seal")));
    assert_eq!(c.drain_claimed(TX.into()), None);
}

#[test]
fn a_mask_with_only_a_function_call_key_claims_once_on_the_bounty() {
    let mut c = nova_revealed();
    let before = prize(&c);
    let no = claim_as(&mut c, NOVA, zero(), PLAY);
    assert_eq!(prize(&c), before - MIN_JUDGE_FEE.as_yoctonear());
    // The judge's fee stays spent when the drain is refused; the winner gets what is left.
    assert_eq!(judge_says_drain(&mut c, no, &drained("race-9999", NOVA, TX)), Status::Open);
    assert_eq!(prize(&c), before - MIN_JUDGE_FEE.as_yoctonear());
}

#[test]
#[should_panic(expected = "the bounty paid this mask's judge once: attach 0.01 NEAR")]
fn the_bounty_pays_a_masks_judge_once() {
    let mut c = nova_revealed();
    let no = claim_as(&mut c, NOVA, zero(), PLAY);
    judge_says_drain(&mut c, no, &drained("race-9999", NOVA, TX));
    claim_as(&mut c, NOVA, zero(), PLAY);
}

#[test]
fn after_its_free_claim_a_mask_attaches_the_fee_and_another_mask_still_has_its_own() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, NOVA);
    sealed_and_revealed(&mut c, ONYX);
    let no = claim_as(&mut c, NOVA, zero(), PLAY);
    judge_says_drain(&mut c, no, &drained("race-9999", NOVA, TX));
    let left = prize(&c);
    let no = claim_as(&mut c, NOVA, MIN_JUDGE_FEE, PLAY);
    assert_eq!(prize(&c), left);
    judge_says_drain(&mut c, no, &drained("race-9999", NOVA, TX));
    claim_as(&mut c, ONYX, zero(), PLAY);
    assert_eq!(prize(&c), left - MIN_JUDGE_FEE.as_yoctonear());
}

#[test]
#[should_panic(expected = "attach at least 0.01 NEAR for the judge and the claim's storage")]
fn a_sandbox_claim_always_attaches_the_fee() {
    let mut c = opened();
    as_(NOVA, zero(), HOUR);
    let _ = c.claim(ID.into(), U64(42));
}

#[test]
fn only_a_sandbox_race_asks_for_the_github_secret() {
    as_(CONTRACT, zero(), 0);
    let project = "maskwars.testnet/judge";
    assert_eq!(judge_secrets(project, drain(TX, NOVA).as_ref()), None);
    // The token is stored by the project's owner: the contract's own account has no key to store it with.
    let secret = judge_secrets(project, None).unwrap();
    assert_eq!(secret["profile"], "default");
    assert_eq!(secret["account_id"], "maskwars.testnet");
}

#[test]
fn a_drain_verdict_does_not_pay_a_sandbox_claim() {
    let mut c = claimed();
    assert_eq!(judge_says(&mut c, 0, Some(&drained(ID, NOVA, TX))), Status::Open);
}

#[test]
fn a_bounced_drain_payout_reopens_the_bounty_and_frees_the_drain() {
    let mut c = drain_claimed();
    judge_says_drain(&mut c, 0, &drained(SAFE_ID, NOVA, TX));
    assert_eq!(paid_back(&mut c, SAFE_ID, false), Some(Status::Open));
    assert_eq!(c.drain_claimed(TX.into()), None);
    // The winner's account could not take the NEAR: its seal gives way, so settle does not bounce for ever.
    assert_eq!(state_of(&c, NOVA), SealState::Refused);
}

#[test]
fn the_payout_names_the_drained_code() {
    let mut c = drain_claimed();
    let reply = json!({ "success": true, "output": { "bounty_id": SAFE_ID, "winner": NOVA, "tx_hash": TX,
        "loot": "1", "block_height": 7, "safe_code_hash": "Code111" }, "error": null });
    judge_says_drain(&mut c, 0, &reply.to_string());
    assert!(get_logs().iter().any(|l| l.ends_with("the safe's code: Code111")));
}

#[test]
#[should_panic(expected = "the safe is another account")]
fn the_contract_is_not_a_safe() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    c.open_safe(
        SAFE_ID.into(),
        acc(CONTRACT),
        masks(),
        U128(MIN_LOOT.as_yoctonear()),
        24,
        30,
        None,
        SAFE_CODE.into(),
        judge_of(&c),
    );
}

#[test]
#[should_panic(expected = "the team or the safe cannot race for its own bounty")]
fn the_team_is_not_a_mask() {
    let mut c = contract();
    open_round(&mut c, vec![acc(NOVA), acc("team.testnet")], NearToken::from_near(1));
}

#[test]
#[should_panic(expected = "a mask is listed twice")]
fn a_mask_is_listed_once() {
    let mut c = contract();
    open_round(&mut c, vec![acc(NOVA), acc(NOVA)], NearToken::from_near(1));
}

#[test]
#[should_panic(expected = "masks: 1 to 16 accounts")]
fn a_live_race_has_masks() {
    let mut c = contract();
    open_round(&mut c, vec![], NearToken::from_near(1));
}

#[test]
#[should_panic(expected = "min_loot: at least 0.1 NEAR")]
fn dust_is_not_a_drain() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    c.open_safe(SAFE_ID.into(), acc(SAFE), masks(), U128(1), 24, 30, None, SAFE_CODE.into(), judge_of(&c));
}

#[test]
fn a_mask_that_revealed_in_time_may_claim_in_the_grace_after_the_deadline() {
    let mut c = nova_revealed();
    claim_as(&mut c, NOVA, MIN_JUDGE_FEE, DEADLINE + 11 * HOUR);
    assert_eq!(terms(&c, SAFE_ID).judging, 1);
}

#[test]
#[should_panic(expected = "the race is over")]
fn the_grace_ends() {
    let mut c = nova_revealed();
    claim_as(&mut c, NOVA, MIN_JUDGE_FEE, DEADLINE + 12 * HOUR);
}

#[test]
#[should_panic(expected = "the masks can still claim")]
fn no_refund_while_the_masks_can_still_claim() {
    let mut c = safe_opened();
    as_("team.testnet", zero(), DEADLINE + HOUR);
    c.refund(SAFE_ID.into());
}

#[test]
fn after_the_grace_the_team_gets_its_round_back() {
    let mut c = safe_opened();
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
    as_("team.testnet", zero(), DEADLINE + 12 * HOUR);
    assert_eq!(c.refund(SAFE_ID.into()), Status::Refunded);
}

#[test]
#[should_panic(expected = "a mask won this round: settle pays it")]
fn no_refund_when_a_seal_won() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, ONYX);
    let no = claim_as(&mut c, ONYX, MIN_JUDGE_FEE, PLAY);
    // Hold ONYX back with NOVA's open seal, then come back after the grace.
    as_(CONTRACT, zero(), PLAY);
    judge_says_drain_of(&mut c, ONYX, no, &drained(SAFE_ID, ONYX, ONYX_TX), PLAY);
    as_("team.testnet", zero(), DEADLINE + 12 * HOUR);
    c.refund(SAFE_ID.into());
}

#[test]
fn seal_states_keep_their_place_on_chain() {
    let tag = |s: SealState| near_sdk::borsh::to_vec(&s).unwrap()[0];
    assert_eq!(
        [SealState::Sealed, SealState::Revealed, SealState::Confirmed, SealState::Refused].map(tag),
        [0, 1, 2, 3]
    );
}

#[test]
fn statuses_keep_their_place_on_chain() {
    // Bounties already on chain were written with these Borsh tags; a new status only ever goes last.
    let tag = |s: Status| near_sdk::borsh::to_vec(&s).unwrap()[0];
    assert_eq!(tag(Status::Open), 0);
    assert_eq!(tag(Status::Judging { claimant: acc(NOVA) }), 1);
    assert_eq!(tag(Status::Paid { winner: acc(NOVA), run_id: U64(1) }), 2);
    assert_eq!(tag(Status::Refunded), 3);
    assert_eq!(tag(Status::Drained { winner: acc(NOVA), tx_hash: TX.into() }), 4);
}

// ---- storage: every record is paid for ----

/// The longest account NEAR allows.
fn longest(name: &str) -> String {
    format!("{}.testnet", name.repeat(56 / name.len() + 1)[..56].to_string())
}

/// A plan of exactly 2048 bytes in 12 calls.
fn biggest_plan(mask: &str) -> String {
    let mut calls: Vec<Value> =
        (0..12).map(|_| json!({ "method": "set_owner", "args": { "new_owner": mask } })).collect();
    let len = |c: &Vec<Value>| serde_json::to_string(c).unwrap().len();
    calls[11] = json!({ "method": "sweep", "args": { "to": mask, "amount": "", "pad": "" } });
    let pad = MAX_PLAN_BYTES - len(&calls);
    calls[11]["args"]["pad"] = json!("x".repeat(pad));
    let text = serde_json::to_string(&calls).unwrap();
    assert_eq!(text.len(), MAX_PLAN_BYTES);
    text
}

/// A distinct 44-character transaction hash for call `j` of mask `i`.
fn tx_no(i: usize, j: usize) -> String {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    format!("{}{}{}", "9vZy5fJ3bQhW2nT8kR4mX1cLpA6sDgE7uYoHiNjKw", B58[i] as char, B58[j] as char)
}

#[test]
fn the_reserve_covers_the_biggest_mask() {
    let mask = longest("m");
    assert_eq!(mask.len(), 64);
    let mut c = contract();
    open_round(&mut c, vec![acc(&mask)], NearToken::from_near(1));
    let (reserve, prize_before) = (terms(&c, SAFE_ID).reserve.0, prize(&c));
    let plan = biggest_plan(&mask);
    let salt = "s".repeat(128);
    as_(&mask, zero(), OPEN_AT + MINUTE);
    c.commit(SAFE_ID.into(), seal_hash(SAFE_ID, &acc(&mask), &salt, &plan));
    let txs: Vec<String> = (0..12).map(|i| tx_no(0, i)).collect();
    as_(&mask, zero(), PLAY);
    c.reveal(SAFE_ID.into(), plan, salt, txs.clone());
    as_(&mask, zero(), PLAY);
    let no = next(&c);
    let _ = c.claim_drain(SAFE_ID.into(), txs[11].clone());
    let peak = reserve - terms(&c, SAFE_ID).reserve.0;
    let confirmed = json!({ "success": true, "output": { "bounty_id": SAFE_ID, "winner": mask, "tx_hash": txs[11] }, "error": null });
    let status =
        answer(&mut c, SAFE_ID, drain(&txs[11], &mask), no, reply_of(Some(&confirmed.to_string())), PLAY).unwrap();
    assert!(matches!(status, Status::Drained { .. }));
    let used = reserve - terms(&c, SAFE_ID).reserve.0;
    println!("one mask at most: {} bytes at the claim, {} once paid", peak / cost_of(1), used / cost_of(1));
    assert!(peak.max(used) <= cost_of(BOUNTY_GROWTH_BYTES + MASK_STORAGE_BYTES), "{peak} {used}");
    // The prize only paid the judge's fee of the free claim; not a yoctoNEAR of storage.
    assert_eq!(prize(&c), prize_before - MIN_JUDGE_FEE.as_yoctonear());
    assert!(!get_logs().iter().any(|l| l.contains("the contract did")), "{:?}", get_logs());
}

#[test]
fn sixteen_masks_cannot_spend_the_prize_on_storage() {
    // Every mask of a full round seals and reveals the biggest plan it may: the reserve pays, the prize stays.
    let mut c = contract();
    let all: Vec<String> = (0..16).map(|i| longest(&format!("m{i:x}"))).collect();
    open_round(&mut c, all.iter().map(|m| acc(m)).collect(), NearToken::from_near(2));
    let before = prize(&c);
    for (i, m) in all.iter().enumerate() {
        let plan = biggest_plan(m);
        as_(m, zero(), OPEN_AT + MINUTE);
        c.commit(SAFE_ID.into(), seal_hash(SAFE_ID, &acc(m), SALT, &plan));
        let txs: Vec<String> = (0..12).map(|j| tx_no(i, j)).collect();
        as_(m, zero(), PLAY);
        c.reveal(SAFE_ID.into(), plan, SALT.into(), txs);
    }
    assert_eq!(prize(&c), before);
}

// ---- who changes the rules ----

fn propose(c: &mut Bounties, change: Change, at: u64) -> Pending {
    as_(ADMIN, zero(), at);
    c.propose(change)
}

#[test]
fn every_bounty_keeps_the_judge_it_opened_with() {
    let mut c = opened();
    propose(&mut c, Change::Judge { version: VERSION_2.into() }, HOUR);
    as_("anyone.testnet", zero(), HOUR + CHANGE_NOTICE_HOURS * HOUR);
    c.apply();
    assert_eq!(c.judge()["version"], VERSION_2);
    assert_eq!(terms(&c, ID).judge_version, VERSION);
    // A claim on the old bounty still goes to the old judge.
    sandbox_claim(&mut c, NOVA, 42, 3 * HOUR);
    assert!(get_logs().iter().any(|l| l.ends_with(&format!("goes to judge {VERSION}"))), "{:?}", get_logs());
    let c2 = safe_opened_on(c);
    assert_eq!(terms(&c2, SAFE_ID).judge_version, VERSION_2);
}

fn safe_opened_on(mut c: Bounties) -> Bounties {
    open_round(&mut c, masks(), NearToken::from_near(1));
    c
}

#[test]
#[should_panic(expected = "only the admin proposes changes")]
fn nobody_else_proposes() {
    let mut c = contract();
    as_("team.testnet", zero(), 0);
    c.propose(Change::Judge { version: VERSION_2.into() });
}

#[test]
#[should_panic(expected = "only the admin proposes changes")]
fn not_even_the_contract_itself() {
    let mut c = contract();
    as_(CONTRACT, zero(), 0);
    c.propose(Change::Judge { version: VERSION_2.into() });
}

#[test]
#[should_panic(expected = "judge version: the wasm's sha256 in hex")]
fn a_judge_version_is_a_wasm_hash() {
    let mut c = contract();
    propose(&mut c, Change::Judge { version: "latest".into() }, 0);
}

#[test]
#[should_panic(expected = "the change is still waiting")]
fn a_judge_waits_for_its_notice() {
    let mut c = contract();
    propose(&mut c, Change::Judge { version: VERSION_2.into() }, 0);
    as_("anyone.testnet", zero(), CHANGE_NOTICE_HOURS * HOUR - 1);
    c.apply();
}

fn wasm() -> Vec<u8> {
    b"\0asm new code".to_vec()
}

fn wasm_sha() -> String {
    env::sha256(&wasm()).iter().map(|b| format!("{b:02x}")).collect()
}

fn upgrade_at(c: &mut Bounties, at: u64, code: Vec<u8>) {
    let mut context = ctx("anyone.testnet", zero(), at).build();
    context.input = code.into();
    testing_env!(context);
    let _ = c.upgrade();
}

#[test]
#[should_panic(expected = "the change is still waiting")]
fn new_code_waits_out_every_live_bounty() {
    let mut c = opened();
    as_(ADMIN, zero(), 0);
    let p = c.propose(Change::Code { sha256: wasm_sha() });
    assert_eq!(p.ready_ns.0, CHANGE_DELAY_HOURS * HOUR);
    assert!(CHANGE_DELAY_HOURS * HOUR >= MAX_HOURS * HOUR + CLAIM_GRACE_HOURS * HOUR);
    upgrade_at(&mut c, CHANGE_DELAY_HOURS * HOUR - 1, wasm());
}

#[test]
fn new_code_applies_after_the_delay_and_runs_migrate() {
    let mut c = opened();
    propose(&mut c, Change::Code { sha256: wasm_sha() }, 0);
    upgrade_at(&mut c, CHANGE_DELAY_HOURS * HOUR, wasm());
    assert!(c.pending().is_none());
    assert!(get_logs().iter().any(|l| l.starts_with("upgrading to code")));
}

#[test]
fn with_no_bounty_live_new_code_needs_only_the_notice() {
    let mut c = contract();
    propose(&mut c, Change::Code { sha256: wasm_sha() }, 0);
    upgrade_at(&mut c, CHANGE_NOTICE_HOURS * HOUR, wasm());
    assert!(c.pending().is_none());
}

#[test]
#[should_panic(expected = "this wasm is not the proposed code")]
fn only_the_proposed_code_is_deployed() {
    let mut c = contract();
    propose(&mut c, Change::Code { sha256: wasm_sha() }, 0);
    upgrade_at(&mut c, CHANGE_DELAY_HOURS * HOUR, b"\0asm other code".to_vec());
}

#[test]
#[should_panic(expected = "new code comes with upgrade, which takes the wasm")]
fn code_does_not_apply_without_its_wasm() {
    let mut c = contract();
    propose(&mut c, Change::Code { sha256: wasm_sha() }, 0);
    as_("anyone.testnet", zero(), CHANGE_DELAY_HOURS * HOUR);
    c.apply();
}

#[test]
#[should_panic(expected = "a change is already pending: cancel it first")]
fn one_change_at_a_time() {
    let mut c = contract();
    propose(&mut c, Change::Judge { version: VERSION_2.into() }, 0);
    propose(&mut c, Change::Admin { account: acc("dao.testnet") }, 0);
}

#[test]
fn the_admin_cancels_and_drops_a_safe_at_once() {
    let mut c = contract();
    propose(&mut c, Change::Admin { account: acc("dao.testnet") }, 0);
    as_(ADMIN, zero(), 0);
    assert!(c.cancel().is_some());
    assert!(c.pending().is_none());
    c.drop_safe_code(SAFE_CODE.into());
    assert_eq!(c.governance()["safe_codes"], json!([]));
}

#[test]
fn a_new_safe_code_applies_after_the_notice_even_with_bounties_live() {
    let mut c = opened();
    let code = "4Hq3rXbK9mP2vW5yZ8cD1fG4hJ6kL9nQ2sT5uV8wX1yA";
    propose(&mut c, Change::AllowSafe { code_hash: code.into() }, 0);
    as_("anyone.testnet", zero(), CHANGE_NOTICE_HOURS * HOUR);
    c.apply();
    assert_eq!(c.governance()["safe_codes"], json!([SAFE_CODE, code]));
}

#[test]
fn a_new_admin_waits_like_code() {
    let mut c = opened();
    propose(&mut c, Change::Admin { account: acc("dao.testnet") }, 0);
    as_("anyone.testnet", zero(), CHANGE_NOTICE_HOURS * HOUR);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.apply())).is_err());
    as_("anyone.testnet", zero(), CHANGE_DELAY_HOURS * HOUR);
    c.apply();
    assert_eq!(c.governance()["admin"], "dao.testnet");
}

// ---- the upgrade from the state on testnet ----

fn race_0002() -> Bounty {
    Bounty {
        owner: acc("team.testnet"),
        amount: U128(NearToken::from_millinear(100).as_yoctonear()),
        target: "open-admin".into(),
        deadline_ns: U64(9),
        status: Status::Paid { winner: acc("tinygif8324.testnet"), run_id: U64(42198804982) },
    }
}

fn race_0003() -> (Bounty, SafeRace) {
    let drained = Bounty {
        owner: acc("tinygif8324.testnet"),
        amount: U128(NearToken::from_millinear(86).as_yoctonear()),
        target: "safe-0001.tinygif8324.testnet".into(),
        deadline_ns: U64(9),
        status: Status::Drained { winner: acc("nova.tinygif8324.testnet"), tx_hash: TX.into() },
    };
    let race = SafeRace {
        safe: acc("safe-0001.tinygif8324.testnet"),
        masks: vec![acc("nova.tinygif8324.testnet")],
        min_loot: U128(MIN_LOOT.as_yoctonear()),
        opened_ns: U64(1),
    };
    (drained, race)
}

/// The state as it sits on testnet today, before sealed rounds: a paid sandbox race and the drained live race with
/// its claimed drain, the judge pinned.
fn v2_state() {
    as_(CONTRACT, zero(), 0);
    let mut old = BountiesV2 {
        outlayer: acc("outlayer.testnet"),
        judge_project: "maskwars.testnet/judge".into(),
        judge_version: Some(VERSION.into()),
        bounties: LookupMap::new(b"b"),
        safes: LookupMap::new(Key::Safes),
        drains: LookupMap::new(Key::Drains),
    };
    let (drained, race) = race_0003();
    old.bounties.insert("race-0002".into(), race_0002());
    old.bounties.insert("race-0003".into(), drained);
    old.safes.insert("race-0003".into(), race);
    old.drains.insert(TX.into(), "race-0003".into());
    old.bounties.flush();
    old.safes.flush();
    old.drains.flush();
    env::state_write(&old);
}

/// The state after sealed rounds, if the owner ran upgrade-sealed: race-0002, race-0003 and race-0004, a round still
/// open with NOVA's seal revealed and its claim with the old judge.
fn v3_state() {
    as_(CONTRACT, zero(), OPEN_AT);
    let mut old = BountiesV3 {
        outlayer: acc("outlayer.testnet"),
        judge_project: "maskwars.testnet/judge".into(),
        judge_version: Some(VERSION.into()),
        bounties: LookupMap::new(b"b"),
        safes: LookupMap::new(Key::Safes),
        drains: LookupMap::new(Key::Drains),
        rounds: LookupMap::new(Key::Rounds),
        seals: LookupMap::new(Key::Seals),
    };
    let (drained, race) = race_0003();
    old.bounties.insert("race-0002".into(), race_0002());
    old.bounties.insert("race-0003".into(), drained);
    old.safes.insert("race-0003".into(), race);
    old.bounties.insert(
        SAFE_ID.into(),
        Bounty {
            owner: acc("team.testnet"),
            amount: U128(NearToken::from_millinear(150).as_yoctonear()),
            target: SAFE.into(),
            deadline_ns: U64(DEADLINE),
            status: Status::Judging { claimant: acc(NOVA) },
        },
    );
    old.safes.insert(
        SAFE_ID.into(),
        SafeRace {
            safe: acc(SAFE),
            masks: masks(),
            min_loot: U128(NearToken::from_near(2).as_yoctonear()),
            opened_ns: U64(OPEN_AT),
        },
    );
    old.rounds.insert(SAFE_ID.into(), Round { opened_height: U64(0), commit_until: U64(COMMIT_END), sealed: 1 });
    old.seals.insert(
        seal_key(SAFE_ID, &acc(NOVA)),
        Seal {
            mask: acc(NOVA),
            hash: seal_hash(SAFE_ID, &acc(NOVA), SALT, &plan_of(NOVA)),
            seq: 0,
            at_ns: U64(OPEN_AT + MINUTE),
            state: SealState::Revealed,
            salt: Some(SALT.into()),
            plan: Some(plan_of(NOVA)),
            txs: txs_of(NOVA),
            drain_tx: None,
        },
    );
    old.drains.insert(TX.into(), SAFE_ID.into());
    old.bounties.flush();
    old.safes.flush();
    old.drains.flush();
    old.rounds.flush();
    old.seals.flush();
    env::state_write(&old);
}

fn migrated() -> Bounties {
    as_(CONTRACT, zero(), PLAY);
    Bounties::migrate(None, Some(VERSION_2.into()))
}

#[test]
fn the_upgrade_from_testnet_keeps_every_bounty_race_drain_and_the_old_judge_for_old_bounties() {
    v2_state();
    let mut c = migrated();
    assert_eq!(c.get("race-0002".into()).unwrap(), race_0002());
    assert_eq!(c.get("race-0003".into()).unwrap().status, race_0003().0.status);
    assert_eq!(c.get_safe("race-0003".into()).unwrap().safe, acc("safe-0001.tinygif8324.testnet"));
    assert_eq!(c.drain_claimed(TX.into()), Some("race-0003".into()));
    // Old bounties keep the judge the old contract had; new ones get the new judge.
    assert_eq!(terms(&c, "race-0002").judge_version, VERSION);
    assert_eq!(c.judge()["version"], VERSION_2);
    assert_eq!(c.governance()["admin"], CONTRACT);
    // A race from before sealed rounds has none.
    assert!(c.get_round("race-0003".into()).is_none());
    c.safe_codes = vec![SAFE_CODE.into()];
    let c = safe_opened_on(c);
    assert_eq!(terms(&c, SAFE_ID).judge_version, VERSION_2);
    assert!(c.get_round(SAFE_ID.into()).is_some());
}

#[test]
#[should_panic(expected = "this live race has no sealed round")]
fn a_live_race_from_before_sealed_rounds_takes_no_seal() {
    v2_state();
    let mut c = migrated();
    as_("nova.tinygif8324.testnet", zero(), 2);
    c.commit("race-0003".into(), VERSION.into());
}

#[test]
fn the_upgrade_after_sealed_rounds_keeps_an_open_round_and_its_claim() {
    v3_state();
    let mut c = migrated();
    assert_eq!(c.get("race-0002".into()).unwrap(), race_0002());
    let round = c.get_round(SAFE_ID.into()).unwrap();
    assert_eq!(round.seals.len(), 1);
    // The old rule for an old round: seals hold until the deadline.
    assert_eq!(round.reveal_until, U64(DEADLINE));
    assert_eq!(terms(&c, SAFE_ID).judge_version, VERSION);
    // The old claim's answer comes back with the old callback's arguments: it is read, not lost.
    testing_env!(
        ctx(CONTRACT, zero(), PLAY).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![reply_of(Some(&drained(SAFE_ID, NOVA, TX)))]
    );
    let paid = c.on_judged(SAFE_ID.into(), drain(TX, NOVA), None);
    assert_eq!(paid, Some(Status::Drained { winner: acc(NOVA), tx_hash: TX.into() }));
}

#[test]
fn a_bounty_left_judging_by_the_old_contract_reopens_after_the_timeout() {
    v3_state();
    let mut c = migrated();
    let later = PLAY + CLAIM_TIMEOUT_BLOCKS * 1_000_000_000;
    as_("anyone.testnet", zero(), later - 1_000_000_000);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.unstick(SAFE_ID.into(), None))).is_err());
    as_("anyone.testnet", zero(), later);
    assert_eq!(c.unstick(SAFE_ID.into(), None), Status::Open);
}

#[test]
fn migrate_on_the_current_state_changes_nothing() {
    let mut c = opened();
    c.pending = Some(Pending {
        change: Change::Judge { version: VERSION_2.into() },
        proposed_ns: U64(1),
        notice_ns: U64(2),
        ready_ns: U64(3),
        expires_ns: U64(u64::MAX),
    });
    c.flush();
    env::state_write(&c);
    let again = Bounties::migrate(Some(acc("other.testnet")), None);
    assert_eq!(again.admin, acc(ADMIN));
    assert_eq!(again.pending, c.pending);
    assert_eq!(again.get(ID.into()), c.get(ID.into()));
    assert_eq!(again.live, 1);
}

#[test]
#[should_panic(expected = "the old contract pinned no judge: pass judge_version")]
fn an_unpinned_old_contract_needs_a_judge() {
    as_(CONTRACT, zero(), 0);
    let old = BountiesV2 {
        outlayer: acc("outlayer.testnet"),
        judge_project: "maskwars.testnet/judge".into(),
        judge_version: None,
        bounties: LookupMap::new(b"b"),
        safes: LookupMap::new(Key::Safes),
        drains: LookupMap::new(Key::Drains),
    };
    env::state_write(&old);
    Bounties::migrate(None, None);
}

// ---- the second review of these fixes: each attack below went through before them ----

const EVIL: &str = "eeee000000000000000000000000000000000000000000000000000000000bad";

fn panics<F: FnOnce()>(f: F) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err()
}

#[test]
fn a_ready_code_change_lapses_and_never_lands_on_a_bounty_opened_long_after() {
    let mut c = contract();
    // The admin proposes new code while nothing is live and never applies it.
    propose(&mut c, Change::Code { sha256: wasm_sha() }, 0);
    // Weeks later the change has lapsed: a team opens a bounty, and the code can no longer go in.
    let later = 500 * HOUR;
    as_("team.testnet", NearToken::from_near(5), later);
    c.open(ID.into(), "open-admin".into(), 72, VERSION.into(), sandbox_masks());
    assert!(c.pending().is_none());
    let mut context = ctx("anyone.testnet", zero(), later + 1_000_000_000).build();
    context.input = wasm().into();
    testing_env!(context);
    assert!(panics(|| {
        let _ = c.upgrade();
    }));
    assert!(get_logs().is_empty() || !get_logs().iter().any(|l| l.starts_with("upgrading")));
}

#[test]
#[should_panic(expected = "new code or a new admin is pending: no new bounty until it applies, lapses or is cancelled")]
fn no_bounty_opens_while_new_code_is_pending() {
    let mut c = contract();
    propose(&mut c, Change::Code { sha256: wasm_sha() }, 0);
    as_("team.testnet", NearToken::from_near(5), 2 * HOUR);
    c.open(ID.into(), "open-admin".into(), 72, VERSION.into(), sandbox_masks());
}

#[test]
fn a_team_can_always_leave_before_new_code_lands() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(5), 0);
    c.open(ID.into(), "open-admin".into(), 72, VERSION.into(), sandbox_masks()); // the grace ends at 84 h
    propose(&mut c, Change::Code { sha256: wasm_sha() }, 1);
    // A second before the grace ends anyone sends a junk sandbox claim; it hangs with the judge.
    let no = sandbox_claim(&mut c, "attacker.testnet", 1, 84 * HOUR - 1_000_000_000);
    let dropped = 84 * HOUR + CLAIM_TIMEOUT_BLOCKS * 1_000_000_000;
    as_("anyone.testnet", zero(), dropped);
    c.unstick(ID.into(), Some(U64(no)));
    as_("team.testnet", zero(), dropped);
    assert_eq!(c.refund(ID.into()), Status::Refunded);
    // The team was out a day before the code could land.
    assert!(CHANGE_DELAY_HOURS * HOUR > dropped + 23 * HOUR);
}

#[test]
#[should_panic(expected = "the judge is not the one the team agreed to: see judge()")]
fn a_judge_applied_right_before_a_team_opens_is_refused_by_the_team() {
    let mut c = contract();
    propose(&mut c, Change::Judge { version: EVIL.into() }, 0);
    as_("anyone.testnet", zero(), CHANGE_NOTICE_HOURS * HOUR);
    c.apply();
    // The team was shown VERSION and opens with it: nothing opens under the evil judge.
    as_("team.testnet", NearToken::from_near(5), CHANGE_NOTICE_HOURS * HOUR);
    c.open(ID.into(), "open-admin".into(), 24, VERSION.into(), sandbox_masks());
}

#[test]
fn a_judge_change_lapses_too() {
    let mut c = contract();
    propose(&mut c, Change::Judge { version: EVIL.into() }, 0);
    as_("anyone.testnet", zero(), 500 * HOUR);
    assert!(panics(|| {
        c.apply();
    }));
    assert_eq!(judge_of(&c), VERSION);
}

#[test]
fn a_failed_judge_run_refuses_nothing_and_gives_the_free_claim_back() {
    let mut c = nova_revealed();
    let no = claim_as(&mut c, NOVA, zero(), PLAY); // the free claim, as a function-call key must
                                                   // OutLayer's run fails (yield timeout, worker down): no verdict on the plan.
    answer(&mut c, SAFE_ID, drain(TX, NOVA), no, PromiseResult::Failed, PLAY + MINUTE);
    assert_eq!(state_of(&c, NOVA), SealState::Revealed);
    // The mask claims again with nothing attached.
    let again = claim_as(&mut c, NOVA, zero(), PLAY + 2 * MINUTE);
    assert_eq!(terms(&c, SAFE_ID).judging, 1);
    // A judge that answers `no` does refuse, and the free claim stays spent.
    let held = json!({ "success": false, "output": null, "error": "a: RPC answered UNKNOWN_BLOCK" }).to_string();
    answer(&mut c, SAFE_ID, drain(TX, NOVA), again, reply_of(Some(&held)), PLAY + 3 * MINUTE);
    assert_eq!(state_of(&c, NOVA), SealState::Refused);
    as_(NOVA, zero(), PLAY + 4 * MINUTE);
    assert!(panics(|| {
        let _ = c.claim_drain(SAFE_ID.into(), TX.into());
    }));
}

#[test]
fn a_dropped_claim_gives_the_free_claim_back() {
    let mut c = nova_revealed();
    let no = claim_as(&mut c, NOVA, zero(), PLAY);
    as_("anyone.testnet", zero(), PLAY + CLAIM_TIMEOUT_BLOCKS * 1_000_000_000);
    c.unstick(SAFE_ID.into(), Some(U64(no)));
    claim_as(&mut c, NOVA, zero(), PLAY + (CLAIM_TIMEOUT_BLOCKS + 1) * 1_000_000_000);
    assert_eq!(state_of(&c, NOVA), SealState::Revealed);
}

#[test]
fn a_rival_cannot_squat_on_the_winners_drain() {
    let mut c = two_masks();
    sealed_and_revealed(&mut c, NOVA);
    // ONYX saw NOVA's sweep on chain and reveals its own plan with NOVA's sweep as one of "its" transactions.
    as_(ONYX, zero(), PLAY);
    c.reveal(SAFE_ID.into(), plan_of(ONYX), SALT.into(), vec![ONYX_OWNER_TX.into(), TX.into()]);
    as_(ONYX, zero(), PLAY);
    let squat = next(&c);
    let _ = c.claim_drain(SAFE_ID.into(), TX.into());
    // NOVA's claim on its own drain goes to the judge all the same.
    let nova = claim_as(&mut c, NOVA, zero(), PLAY);
    assert_eq!(terms(&c, SAFE_ID).judging, 2);
    let status = judge_says_drain_of(&mut c, NOVA, nova, &drained(SAFE_ID, NOVA, TX), PLAY);
    assert_eq!(status, Status::Drained { winner: acc(NOVA), tx_hash: TX.into() });
    // The squatter's answer (the judge refuses it: NOVA signed that sweep) changes nothing.
    let refused_squat = answer(&mut c, SAFE_ID, drain(TX, ONYX), squat, reply_of(Some(&refused())), PLAY).unwrap();
    assert_eq!(refused_squat, status);
    assert_eq!(c.drain_claimed(TX.into()), Some(SAFE_ID.into()));
}

#[test]
fn a_drain_confirmed_for_one_bounty_never_counts_for_another() {
    let mut c = drain_claimed();
    c.drains.insert(TX.into(), "race-9999".into());
    assert_eq!(judge_says_drain(&mut c, 0, &drained(SAFE_ID, NOVA, TX)), Status::Open);
    assert_eq!(state_of(&c, NOVA), SealState::Refused);
    assert_eq!(c.drain_claimed(TX.into()), Some("race-9999".into()));
}

// H1: a round runs only on a safe that locked itself to it.

/// Every function call the last call scheduled: receiver, method, JSON args.
fn scheduled_calls() -> Vec<(String, String, Value)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions.into_iter().map(move |a| (r.receiver_id.to_string(), a)))
        .filter_map(|(to, a)| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } => Some((
                to,
                String::from_utf8(method_name).unwrap(),
                serde_json::from_slice(&args).unwrap_or(Value::Null),
            )),
            _ => None,
        })
        .collect()
}

fn armed_says(c: &mut Bounties, ok: bool, at: u64) -> Option<Status> {
    let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    testing_env!(
        ctx(CONTRACT, zero(), at).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    c.on_armed(SAFE_ID.into())
}

#[test]
fn a_round_arms_its_safe_with_the_end_of_the_commit_window() {
    let _ = safe_opened();
    let calls = scheduled_calls();
    assert_eq!(
        calls[0],
        (
            SAFE.to_string(),
            "arm".to_string(),
            json!({ "bounty": SAFE_ID, "opens_ns": COMMIT_END.to_string(), "masks": [NOVA, ONYX],
                    "team": "team.testnet" })
        )
    );
    assert_eq!((calls[1].0.as_str(), calls[1].1.as_str()), (CONTRACT, "on_armed"));
    assert_eq!(calls[1].2, json!({ "id": SAFE_ID }));
}

#[test]
fn the_safe_hears_who_opened_the_round_so_only_its_own_team_arms_it() {
    // Review finding 1: `arm` only checked that the bounty contract called it, so anyone who opened a round on a fresh
    // safe first took it. The contract now names the caller of open_safe as the round's team, and the safe compares
    // it with the team it was deployed for. Whoever opens, the safe hears exactly that account.
    let mut c = contract();
    as_("intruder.testnet", NearToken::from_near(1), OPEN_AT);
    let loot = U128(NearToken::from_near(2).as_yoctonear());
    c.open_safe(SAFE_ID.into(), acc(SAFE), masks(), loot, 24, 30, None, SAFE_CODE.into(), judge_of(&c));
    let (to, method, args) = scheduled_calls().remove(0);
    assert_eq!((to.as_str(), method.as_str()), (SAFE, "arm"));
    assert_eq!(args["team"], "intruder.testnet");
    // The safe refuses it (another team), and the intruder gets its deposit back; the safe is still free.
    assert_eq!(armed_says(&mut c, false, OPEN_AT + 2_000_000_000), Some(Status::Refunded));
}

#[test]
fn every_seal_goes_to_the_safe_with_its_number_so_the_seals_play_in_order() {
    // Review finding 3: the first turn went to whoever played first. The safe now hears every seal and lets only the
    // sealed masks move it, seal #0 first.
    let mut c = safe_opened();
    seal(&mut c, ONYX, &plan_of(ONYX), OPEN_AT + MINUTE);
    assert_eq!(
        scheduled_calls(),
        vec![(SAFE.to_string(), "queue".to_string(), json!({ "bounty": SAFE_ID, "mask": ONYX, "seq": 0 }))]
    );
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + 2 * MINUTE);
    assert_eq!(scheduled_calls()[0].2, json!({ "bounty": SAFE_ID, "mask": NOVA, "seq": 1 }));
}

#[test]
fn a_round_on_an_armed_safe_goes_on() {
    let mut c = safe_opened();
    assert_eq!(armed_says(&mut c, true, OPEN_AT + 2_000_000_000), Some(Status::Open));
    assert!(get_logs().iter().any(|l| l.contains("is armed for race-0004")), "{:?}", get_logs());
    assert_eq!(c.governance()["live"], 1);
    // The round goes on as before: a seal in the window.
    seal(&mut c, NOVA, &plan_of(NOVA), OPEN_AT + MINUTE);
}

#[test]
fn a_safe_that_would_not_arm_takes_no_round_and_the_team_gets_everything_back() {
    // An old safe without the lock, a safe armed for another round, other masks, another owner: arm fails.
    let mut c = safe_opened();
    let prize = c.get(SAFE_ID.into()).unwrap().amount.0;
    let reserve = terms(&c, SAFE_ID).reserve.0;
    assert_eq!(armed_says(&mut c, false, OPEN_AT + 2_000_000_000), Some(Status::Refunded));
    assert_eq!(c.get(SAFE_ID.into()).unwrap().status, Status::Refunded);
    assert_eq!(c.governance()["live"], 0);
    let back: Vec<(String, u128)> = get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions.into_iter().map(move |a| (r.receiver_id.to_string(), a)))
        .filter_map(|(to, a)| match a {
            MockAction::Transfer { deposit, .. } => Some((to, deposit.as_yoctonear())),
            _ => None,
        })
        .collect();
    assert_eq!(back, vec![("team.testnet".to_string(), prize), ("team.testnet".to_string(), reserve)]);
    assert!(get_logs().iter().any(|l| l.contains("would not arm")), "{:?}", get_logs());
    // Nothing more happens on it: no seal, and a late answer changes nothing.
    as_(NOVA, zero(), OPEN_AT + MINUTE);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.commit(SAFE_ID.into(), seal_hash(SAFE_ID, &acc(NOVA), SALT, &plan_of(NOVA)));
    }))
    .is_err());
    assert_eq!(armed_says(&mut c, false, OPEN_AT + MINUTE), Some(Status::Refunded));
    assert_eq!(c.governance()["live"], 0);
}

// A8: a sandbox race pays only one of the masks it was opened for, and tells the judge when it opened.

#[test]
fn a_sandbox_race_pays_only_one_of_its_masks() {
    // The repository variable named another account as the winning mask: the judge's answer pays nobody.
    let mut c = claimed();
    assert_eq!(judge_says(&mut c, 0, Some(&yes(ID, "thief.testnet"))), Status::Open);
    assert!(get_logs().iter().any(|l| l.contains("thief.testnet is not a mask of this race")), "{:?}", get_logs());
    assert_eq!(c.get(ID.into()).unwrap().status, Status::Open);
    // A listed mask is paid.
    sandbox_claim(&mut c, "nova.maskwars.testnet", 43, HOUR);
    let paid = judge_says(&mut c, 1, Some(&yes(ID, "nova.maskwars.testnet")));
    assert_eq!(paid, Status::Paid { winner: acc("nova.maskwars.testnet"), run_id: U64(42) });
}

#[test]
fn the_judge_is_told_when_a_sandbox_race_opened_and_who_may_win() {
    let mut c = opened();
    assert_eq!(c.get_sandbox(ID.into()), Some(SandboxRace { masks: sandbox_masks(), opened_ns: U64(0) }));
    sandbox_claim(&mut c, "nova.maskwars.testnet", 42, HOUR);
    let (to, method, args) = scheduled_calls().into_iter().find(|(_, m, _)| m == "request_execution").unwrap();
    assert_eq!((to.as_str(), method.as_str()), ("outlayer.testnet", "request_execution"));
    let input: Value = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(
        input,
        json!({ "kind": "race", "bounty_id": ID, "target": "open-admin", "run_id": "42", "opened_ns": "0",
                "masks": ["nova.maskwars.testnet", "onyx.maskwars.testnet", "nobody-here.testnet"] })
    );
}

#[test]
fn a_sandbox_race_names_the_masks_that_may_win_it() {
    let mut c = contract();
    as_("team.testnet", NearToken::from_near(1), 0);
    assert!(panics(|| {
        c.open(ID.into(), "open-admin".into(), 24, VERSION.into(), vec![]);
    }));
    assert!(panics(|| {
        c.open(ID.into(), "open-admin".into(), 24, VERSION.into(), vec![acc("team.testnet")]);
    }));
    assert!(panics(|| {
        c.open(ID.into(), "open-admin".into(), 24, VERSION.into(), vec![acc("nova.testnet"), acc("nova.testnet")]);
    }));
    assert!(c.get(ID.into()).is_none());
}
