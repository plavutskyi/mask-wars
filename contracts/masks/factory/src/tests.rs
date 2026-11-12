use super::*;
use near_sdk::borsh::BorshDeserialize;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::json;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const ONE: u128 = 10u128.pow(24);
const MILLI: u128 = ONE / 1000;
const HOUR: u64 = 3_600_000_000_000;
const CODE: &str = "aa1fd9b4ad6a3cd5d0f6e4c4dd34e5c1bd5c9bce4f2af3b9a54d6b6cd8f5e301";
const KEY: &str = "x25519:0d58a54f7bb7a7f3d3c4f15e1c7b0f8ad2a43b5cd8c3c1d06f2c4f3a8f5b6e70";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn pk(n: u8) -> PublicKey {
    let mut bytes = vec![0u8; 33];
    bytes[1] = n;
    PublicKey::try_from(bytes).unwrap()
}

/// The longest key NEAR has: secp256k1, 64 bytes.
fn secp(n: u8) -> PublicKey {
    let mut bytes = vec![n; 65];
    bytes[0] = 1;
    PublicKey::try_from(bytes).unwrap()
}

const MINUTE: u64 = 60_000_000_000;

fn ctx(who: &str, deposit: u128, now: u64) {
    let mut c = VMContextBuilder::new();
    c.current_account_id(acc("masks.near"))
        .signer_account_id(acc(who))
        .predecessor_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(now);
    testing_env!(c.build());
}

fn as_(who: &str) {
    ctx(who, 0, 0);
}

/// A call whose input is raw bytes, as `publish_mask_code` and `upgrade` take a wasm.
fn with_input(who: &str, now: u64, input: &[u8]) {
    let mut c = VMContextBuilder::new();
    c.current_account_id(acc("masks.near"))
        .predecessor_account_id(acc(who))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(now);
    let mut context = c.build();
    context.input = input.into();
    testing_env!(context);
}

fn catalog() -> Catalog {
    Catalog {
        models: vec![
            "z-ai/glm-5.3-flash".into(),
            "deepseek-ai/DeepSeek-V4.1-Flash-1017".into(),
            "Qwen/Qwen3.8-27B".into(),
        ],
        looks: vec!["porcelain".into(), "crimson".into()],
        styles: vec!["patient".into(), "fast".into(), "cunning".into()],
    }
}

fn factory() -> Factory {
    as_("admin.near");
    let mut f = Factory::new(
        acc("admin.near"),
        acc("keeper.near"),
        acc("treasury.near"),
        acc("bounty.near"),
        CODE.into(),
        Some(KEY.into()),
        catalog(),
        60,
        vec![acc("team.near")],
    );
    f.mask_code.published = true;
    f
}

/// What a mask's key on the round's safe may call, as the keeper asks for it.
fn safe_methods() -> Vec<String> {
    vec!["set_owner".into(), "sweep".into()]
}

fn sealed() -> String {
    format!("v1.{}", "A".repeat(763))
}

fn forge_as(f: &mut Factory, who: &str, name: &str, deposit: u128, strategy: Option<String>) -> Promise {
    ctx(who, deposit, 0);
    f.forge(name.into(), "porcelain".into(), "z-ai/glm-5.3-flash".into(), "patient".into(), strategy, None, None, None)
}

/// A forged mask, its account made.
fn forged(f: &mut Factory, who: &str, name: &str, deposit: u128) -> MaskView {
    let _ = forge_as(f, who, name, deposit, None);
    as_("masks.near");
    f.on_forged(name.into(), Ok(())).unwrap()
}

/// The arena's three views of a round, as `arm` asks for them: the live race, its sealed round, the bounty, opened by
/// the factory's team.
fn views(safe: &str, masks: &[&str], state: &str, commit_until: u64) -> Vec<PromiseResult> {
    views_by("team.near", safe, masks, state, commit_until)
}

/// The same round, opened on the arena by `owner`.
fn views_by(owner: &str, safe: &str, masks: &[&str], state: &str, commit_until: u64) -> Vec<PromiseResult> {
    let race = json!({ "safe": safe, "masks": masks, "min_loot": "100000000000000000000000", "opened_ns": "0" });
    let round = json!({ "commit_until": commit_until.to_string(), "reveal_until": (commit_until + HOUR).to_string(),
                        "deadline_ns": (commit_until + 2 * HOUR).to_string(), "seals": [], "judging": [] });
    let bounty = json!({ "owner": owner, "amount": "1000000000000000000000000", "target": safe,
                         "deadline_ns": (commit_until + 2 * HOUR).to_string(), "status": { "state": state } });
    Vec::from([race, round, bounty].map(|v| PromiseResult::Successful(near_sdk::serde_json::to_vec(&v).unwrap())))
}

/// A round of the arena with KIRA and LENA on its list, on `safe-0009.near`, its commit window open until `until`.
fn open_round(until: u64) -> Vec<PromiseResult> {
    views("safe-0009.near", &["nova.near", "kira.masks.near", "lena.masks.near"], "open", until)
}

/// The arena's answer reaching `on_round` at `now`, called by the factory itself as NEAR delivers a callback.
fn on_round(
    f: &mut Factory,
    name: &str,
    race: &str,
    target: &str,
    results: Vec<PromiseResult>,
    now: u64,
) -> PromiseOrValue<bool> {
    let mut c = VMContextBuilder::new();
    c.current_account_id(acc("masks.near"))
        .predecessor_account_id(acc("masks.near"))
        .account_balance(NearToken::from_near(100))
        .block_timestamp(now);
    testing_env!(
        c.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
    f.on_round(name.into(), race.into(), acc(target), vec!["set_owner".into(), "sweep".into()])
}

/// The keeper arms a mask for an open round on `safe-0009.near`, and the arena confirms it.
fn arm(f: &mut Factory, name: &str, race: &str) -> PromiseOrValue<bool> {
    as_("keeper.near");
    let _ =
        f.arm(name.into(), race.into(), pk(1), acc("safe-0009.near"), pk(2), vec!["set_owner".into(), "sweep".into()]);
    on_round(f, name, race, "safe-0009.near", open_round(HOUR), 0)
}

fn refused(answer: PromiseOrValue<bool>) -> bool {
    matches!(answer, PromiseOrValue::Value(false))
}

fn actions() -> Vec<(AccountId, MockAction)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions.into_iter().map(move |a| (r.receiver_id.clone(), a)))
        .collect()
}

fn transfers() -> Vec<(AccountId, u128)> {
    actions()
        .into_iter()
        .filter_map(|(to, a)| match a {
            MockAction::Transfer { deposit, .. } => Some((to, deposit.as_yoctonear())),
            _ => None,
        })
        .collect()
}

fn calls() -> Vec<(AccountId, String, Vec<u8>)> {
    actions()
        .into_iter()
        .filter_map(|(to, a)| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } => {
                Some((to, String::from_utf8(method_name).unwrap(), args))
            }
            _ => None,
        })
        .collect()
}

fn events() -> Vec<String> {
    get_logs().into_iter().filter(|l| l.starts_with("EVENT_JSON:")).collect()
}

#[derive(BorshDeserialize, Debug, PartialEq)]
#[borsh(crate = "near_sdk::borsh")]
struct SentKey {
    public_key: PublicKey,
    receiver_id: AccountId,
    method_names: Vec<String>,
    allowance: u128,
}

// ---------------------------------------------------------------------------------------------------------------------
// Forging
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn forging_makes_a_keyless_account_with_the_mask_code() {
    let mut f = factory();
    let _ = forge_as(&mut f, "ann.near", "kira", 2 * ONE, None);
    let acts = actions();
    let on_mask: Vec<&MockAction> =
        acts.iter().filter(|(to, _)| *to == acc("kira.masks.near")).map(|(_, a)| a).collect();
    assert!(matches!(on_mask[0], MockAction::CreateAccount { .. }));
    assert!(
        matches!(on_mask[1], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == MASK_FUND.as_yoctonear())
    );
    assert!(matches!(on_mask[2], MockAction::UseGlobalContract { .. }));
    assert!(matches!(on_mask[3], MockAction::FunctionCallWeight { .. }));
    assert_eq!(on_mask.len(), 4, "no key of any kind: {on_mask:?}");
    let (_, method, args) = calls().into_iter().find(|(to, _, _)| *to == acc("kira.masks.near")).unwrap();
    let (owner, author) = <(AccountId, Option<(AccountId, u16)>)>::try_from_slice(&args).unwrap();
    assert_eq!((method.as_str(), owner, author), ("init", acc("ann.near"), None), "a plain mask has no author");
    assert!(calls().iter().any(|(to, m, _)| *to == acc("masks.near") && m == "on_forged"));

    let v = f.get_mask("kira".into()).unwrap();
    assert_eq!((v.state.as_str(), v.owner.as_str(), v.account.as_str()), ("forging", "ann.near", "kira.masks.near"));
    assert_eq!(v.fuel.0, 2 * ONE);
    let storage = 2 * ONE - MASK_FUND.as_yoctonear() - v.brain.0;
    assert!(storage > 0 && storage < 20 * MILLI, "the record's storage comes out of the deposit: {storage}");
    assert_eq!(f.total_brain, v.brain.0);
}

#[test]
fn the_mask_is_ready_once_its_account_exists() {
    let mut f = factory();
    let v = forged(&mut f, "ann.near", "kira", 2 * ONE);
    assert_eq!(v.state, "ready");
    assert_eq!(f.budget("kira".into()).0, DEFAULT_RACE_LIMIT.as_yoctonear());
    let e = events();
    assert!(e[0].contains(r#""event":"forge""#) && e[0].contains(r#""name":"kira""#), "{e:?}");
    assert_eq!(f.masks_of(acc("ann.near")).len(), 1);
    assert_eq!(f.list_masks(None, None)[0].name, "kira");
}

#[test]
fn a_failed_forge_gives_the_whole_deposit_back() {
    let mut f = factory();
    let _ = forge_as(&mut f, "ann.near", "kira", 2 * ONE, None);
    as_("masks.near");
    assert_eq!(f.on_forged("kira".into(), Err(PromiseError::Failed)), None);
    assert_eq!(transfers(), vec![(acc("ann.near"), 2 * ONE)]);
    assert!(f.get_mask("kira".into()).is_none());
    assert!(f.masks_of(acc("ann.near")).is_empty());
    assert!(f.list_masks(None, None).is_empty());
    assert_eq!((f.total_brain, f.total_held), (0, 0));
    assert!(f.name_free("kira".into()));
}

#[test]
fn a_strategy_is_kept_sealed_with_the_key_it_was_sealed_for() {
    let mut f = factory();
    let _ = forge_as(&mut f, "ann.near", "kira", 2 * ONE, Some(sealed()));
    let s = f.get_sealed_strategy("kira".into()).unwrap();
    assert_eq!((s.key.as_str(), s.sealed.len()), (KEY, STRATEGY_BOX_LEN));
    assert!(f.get_mask("kira".into()).unwrap().strategy);
}

#[test]
fn the_view_never_shows_the_strategy() {
    let mut f = factory();
    let _ = forge_as(&mut f, "ann.near", "kira", 2 * ONE, Some(sealed()));
    let json = near_sdk::serde_json::to_string(&f.get_mask("kira".into()).unwrap()).unwrap();
    assert!(!json.contains("v1.AAA"), "{json}");
}

macro_rules! refused {
    ($name:ident, $why:literal, |$f:ident| $body:expr) => {
        #[test]
        #[should_panic(expected = $why)]
        fn $name() {
            let mut $f = factory();
            let _ = $body;
        }
    };
}

refused!(no_forge_before_the_mask_code_is_published, "the forge opens once the mask code is published", |f| {
    f.mask_code.published = false;
    forge_as(&mut f, "ann.near", "kira", 2 * ONE, None)
});
refused!(a_name_is_short_lowercase_and_plain, "name: 3 to 16", |f| forge_as(&mut f, "ann.near", "Kira", 2 * ONE, None));
refused!(a_name_starts_with_a_letter, "name: 3 to 16", |f| forge_as(&mut f, "ann.near", "9kira", 2 * ONE, None));
refused!(no_dots_in_a_name, "name: 3 to 16", |f| forge_as(&mut f, "ann.near", "ki.ra", 2 * ONE, None));
refused!(the_arena_keeps_its_names, "this name belongs to the arena", |f| forge_as(
    &mut f,
    "ann.near",
    "nova",
    2 * ONE,
    None
));
refused!(one_mask_per_name, "this name is taken", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    forge_as(&mut f, "bob.near", "kira", 2 * ONE, None)
});
refused!(a_mask_does_not_forge, "a mask does not forge masks", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    forge_as(&mut f, "kira.masks.near", "kiro", 2 * ONE, None)
});
refused!(only_listed_models, "pick a model from the catalog", |f| {
    ctx("ann.near", 2 * ONE, 0);
    f.forge("kira".into(), "porcelain".into(), "openai/gpt-5".into(), "patient".into(), None, None, None, None)
});
refused!(only_listed_looks, "pick a look from the catalog", |f| {
    ctx("ann.near", 2 * ONE, 0);
    f.forge("kira".into(), "gold".into(), "Qwen/Qwen3.8-27B".into(), "patient".into(), None, None, None, None)
});
refused!(only_listed_styles, "pick a style from the catalog", |f| {
    ctx("ann.near", 2 * ONE, 0);
    f.forge("kira".into(), "porcelain".into(), "Qwen/Qwen3.8-27B".into(), "lazy".into(), None, None, None, None)
});
refused!(forging_takes_one_near, "forging takes at least 1 NEAR", |f| forge_as(
    &mut f,
    "ann.near",
    "kira",
    ONE - 1,
    None
));
refused!(no_strategy_before_the_mind_has_a_key, "strategies open once the mind has a key", |f| {
    f.strategy_key = None;
    forge_as(&mut f, "ann.near", "kira", 2 * ONE, Some(sealed()))
});
refused!(a_strategy_is_a_sealed_box, "strategy: a sealed box", |f| {
    forge_as(&mut f, "ann.near", "kira", 2 * ONE, Some("buy the dip".into()))
});
refused!(every_box_has_one_size, "strategy: a sealed box", |f| {
    forge_as(&mut f, "ann.near", "kira", 2 * ONE, Some(format!("v1.{}", "A".repeat(762))))
});
refused!(a_race_limit_has_bounds, "race_limit: 0.01 to 1 NEAR", |f| {
    ctx("ann.near", 2 * ONE, 0);
    f.forge(
        "kira".into(),
        "porcelain".into(),
        "Qwen/Qwen3.8-27B".into(),
        "fast".into(),
        None,
        Some(U128(2 * ONE)),
        None,
        None,
    )
});
refused!(the_deposit_covers_one_race, "at least one race", |f| {
    ctx("ann.near", ONE, 0);
    f.forge(
        "kira".into(),
        "porcelain".into(),
        "Qwen/Qwen3.8-27B".into(),
        "fast".into(),
        None,
        Some(U128(800 * MILLI)),
        None,
        None,
    )
});
refused!(eight_masks_a_person, "one person forges at most 8 masks", |f| {
    for i in 0..8 {
        forged(&mut f, "ann.near", &format!("kira{i}"), ONE);
    }
    forge_as(&mut f, "ann.near", "kira8", ONE, None)
});

#[test]
fn names_free_and_taken() {
    let mut f = factory();
    assert!(f.name_free("kira".into()));
    assert!(!f.name_free("ki".into()) && !f.name_free("onyx".into()) && !f.name_free("Kira".into()));
    forged(&mut f, "ann.near", "kira", ONE);
    assert!(!f.name_free("kira".into()));
}

// ---------------------------------------------------------------------------------------------------------------------
// The tank
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn anyone_refuels_and_the_owner_takes_the_rest_back() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", 2 * ONE).brain.0;
    ctx("fan.near", ONE, 0);
    let v = f.refuel("kira".into());
    assert_eq!((v.brain.0, v.fuel.0), (brain + ONE, 3 * ONE));
    as_("ann.near");
    let _ = f.unfuel("kira".into(), Some(U128(ONE / 2)));
    assert_eq!(transfers(), vec![(acc("ann.near"), ONE / 2)]);
    as_("ann.near");
    let _ = f.unfuel("kira".into(), None);
    assert_eq!(transfers(), vec![(acc("ann.near"), brain + ONE / 2)]);
    let v = f.get_mask("kira".into()).unwrap();
    assert_eq!((v.brain.0, v.fuel.0), (0, 3 * ONE), "the × keeps counting everything put in");
    assert_eq!(f.total_brain, 0);
}

#[test]
fn a_mask_fuels_its_own_mind_without_raising_what_was_put_in() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", 2 * ONE).brain.0;
    // The mask's own account: what it won, sent by its code's `fuel`. Its first `recycled` record is paid from it.
    ctx("kira.masks.near", ONE / 2, 0);
    let before = env::storage_usage();
    let v = f.refuel("kira".into());
    let record = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage() - before);
    assert!(record > 0 && record < ONE / 1000, "{record}");
    assert_eq!(
        (v.brain.0, v.fuel.0, v.recycled.0),
        (brain + ONE / 2 - record, 2 * ONE, ONE / 2),
        "the tank grows, the × base does not"
    );
    assert_eq!(f.total_brain, brain + ONE / 2 - record);
    // A second time the record is there: all of it goes into the tank, and `recycled` adds up.
    ctx("kira.masks.near", ONE / 2, 0);
    let v = f.refuel("kira".into());
    assert_eq!((v.brain.0, v.recycled.0), (brain + ONE - record, ONE));
    // Another mask's account is a fan like any other: its NEAR is put in.
    forged(&mut f, "bob.near", "zed", 2 * ONE);
    ctx("zed.masks.near", ONE / 2, 0);
    let v = f.refuel("kira".into());
    assert_eq!((v.brain.0, v.fuel.0, v.recycled.0), (brain + 3 * ONE / 2 - record, 2 * ONE + ONE / 2, ONE));
}

refused!(only_the_owner_unfuels, "only the mask's owner", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("bob.near");
    f.unfuel("kira".into(), None)
});
refused!(no_more_than_the_tank, "the tank does not hold that much", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("ann.near");
    f.unfuel("kira".into(), Some(U128(2 * ONE)))
});
refused!(a_refuel_is_worth_it, "refuel with at least 0.1 NEAR", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    ctx("fan.near", MILLI, 0);
    f.refuel("kira".into())
});

// ---------------------------------------------------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn arming_holds_one_race_and_adds_two_narrow_keys() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", 2 * ONE).brain.0;
    let _ = arm(&mut f, "kira", "race-0009");
    let (to, method, args) = calls().into_iter().find(|(_, m, _)| m == "add_keys").unwrap();
    assert_eq!(to, acc("kira.masks.near"));
    let keys = Vec::<SentKey>::try_from_slice(&args).unwrap();
    assert_eq!(
        keys,
        vec![
            SentKey {
                public_key: pk(1),
                receiver_id: acc("bounty.near"),
                method_names: ARENA_METHODS.iter().map(|m| m.to_string()).collect(),
                allowance: ARENA_KEY_ALLOWANCE.as_yoctonear(),
            },
            SentKey {
                public_key: pk(2),
                receiver_id: acc("safe-0009.near"),
                method_names: vec!["set_owner".into(), "sweep".into()],
                allowance: TARGET_KEY_ALLOWANCE.as_yoctonear(),
            },
        ],
        "{method}"
    );
    let v = f.get_mask("kira".into()).unwrap();
    let held = DEFAULT_RACE_LIMIT.as_yoctonear();
    assert_eq!((v.state.as_str(), v.brain.0, v.race.unwrap().held.0), ("racing", brain - held, held));
    assert_eq!((f.total_brain, f.total_held), (brain - held, held));
    assert_eq!(f.budget("kira".into()).0, 0, "one race at a time");
}

#[test]
fn a_race_never_holds_more_than_the_tank() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", ONE).brain.0;
    as_("ann.near");
    let _ = f.unfuel("kira".into(), Some(U128(brain - 7 * MILLI)));
    let _ = arm(&mut f, "kira", "race-0009");
    assert_eq!(f.get_mask("kira".into()).unwrap().race.unwrap().held.0, 7 * MILLI);
}

#[test]
fn a_failed_arming_gives_the_hold_back() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", 2 * ONE).brain.0;
    let _ = arm(&mut f, "kira", "race-0009");
    as_("masks.near");
    assert!(!f.on_armed("kira".into(), "race-0009".into(), acc("safe-0009.near"), Err(PromiseError::Failed)));
    let v = f.get_mask("kira".into()).unwrap();
    assert_eq!((v.state.as_str(), v.brain.0), ("ready", brain));
    assert_eq!((f.total_brain, f.total_held), (brain, 0));
}

// ---------------------------------------------------------------------------------------------------------------------
// The round check (F4): a race key only for the safe of a real round the mask may race in
// ---------------------------------------------------------------------------------------------------------------------

/// The keeper arms KIRA, and the arena answers `results` at `now`: the arming must be refused, the hold back in the
/// tank, no key sent, and the hour still counted.
fn assert_refused(results: Vec<PromiseResult>, target: &str, now: u64, why: &str) {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", 2 * ONE).brain.0;
    ctx("keeper.near", 0, now);
    let _ =
        f.arm("kira".into(), "race-0009".into(), pk(1), acc(target), pk(2), vec!["set_owner".into(), "sweep".into()]);
    assert_eq!(f.get_mask("kira".into()).unwrap().state, "racing", "the hold is taken while the arena answers");
    assert!(refused(on_round(&mut f, "kira", "race-0009", target, results, now)), "{why}");
    assert!(calls().iter().all(|(_, m, _)| m != "add_keys"), "{why}: no key goes on");
    assert!(get_logs().iter().any(|l| l.contains(why)), "{why}: {:?}", get_logs());
    let v = f.get_mask("kira".into()).unwrap();
    assert_eq!((v.state.as_str(), v.brain.0, v.race), ("ready", brain, None), "{why}");
    assert_eq!((f.total_brain, f.total_held), (brain, 0), "{why}");
    ctx("keeper.near", 0, now + MINUTE);
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = f.arm("kira".into(), "race-0010".into(), pk(3), acc(target), pk(4), safe_methods());
    }));
    assert!(again.is_err(), "{why}: a refused arming still counts for the hour");
}

#[test]
fn a_round_the_arena_does_not_have_gets_no_key() {
    let null = || PromiseResult::Successful(b"null".to_vec());
    assert_refused(vec![null(), null(), null()], "safe-0009.near", 0, "the arena has no live race by that id");
}

#[test]
fn a_mask_off_the_round_s_list_gets_no_key() {
    let other = views("safe-0009.near", &["nova.near", "lena.masks.near"], "open", HOUR);
    assert_refused(other, "safe-0009.near", 0, "the mask is not on the round's list");
}

#[test]
fn a_key_for_another_contract_than_the_round_s_safe_is_refused() {
    // The keeper names a contract of its own as the target: the mask's gas would burn there.
    assert_refused(open_round(HOUR), "gas-sink.near", 0, "the target is not the round's safe");
}

#[test]
fn a_round_past_its_commit_window_gets_no_key() {
    assert_refused(open_round(HOUR), "safe-0009.near", HOUR, "the round's commit window is closed");
}

#[test]
fn a_refunded_round_gets_no_key() {
    let refunded = views("safe-0009.near", &["kira.masks.near"], "refunded", HOUR);
    assert_refused(refunded, "safe-0009.near", 0, "the round is not open");
}

#[test]
fn a_drained_round_gets_no_key() {
    let drained = views("safe-0009.near", &["kira.masks.near"], "drained", HOUR);
    assert_refused(drained, "safe-0009.near", 0, "the round is not open");
}

#[test]
fn a_failed_view_gets_no_key() {
    let mut failed = open_round(HOUR);
    failed[1] = PromiseResult::Failed;
    assert_refused(failed, "safe-0009.near", 0, "the race has no sealed round");
}

#[test]
fn a_view_that_does_not_parse_gets_no_key() {
    let mut junk = open_round(HOUR);
    junk[0] = PromiseResult::Successful(b"[1,".to_vec());
    assert_refused(junk, "safe-0009.near", 0, "the arena has no live race by that id");
}

#[test]
fn a_missing_view_gets_no_key() {
    // Two answers instead of three: nothing is read.
    let mut short = open_round(HOUR);
    short.pop();
    assert_refused(short, "safe-0009.near", 0, "the arena has no live race by that id");
}

#[test]
fn an_answer_too_long_to_be_a_round_in_its_commit_window_gets_no_key() {
    let mut long = open_round(HOUR);
    let masks: Vec<String> = (0..2000).map(|i| format!("mask{i:04}.near")).collect();
    let race = json!({ "safe": "safe-0009.near", "masks": masks, "min_loot": "1", "opened_ns": "0" });
    long[0] = PromiseResult::Successful(near_sdk::serde_json::to_vec(&race).unwrap());
    assert_refused(long, "safe-0009.near", 0, "the arena has no live race by that id");
}

#[test]
fn the_round_check_reads_the_arena_s_views() {
    let ok = |r: &PromiseResult| match r {
        PromiseResult::Successful(b) => near_sdk::serde_json::from_slice(b).ok(),
        _ => None,
    };
    let [race, round, bounty] = <[PromiseResult; 3]>::try_from(open_round(HOUR)).unwrap();
    let kira = acc("kira.masks.near");
    let safe = acc("safe-0009.near");
    let teams = [acc("team.near")];
    assert_eq!(round_check(&kira, &safe, &teams, HOUR - 1, ok(&race), ok(&round), ok(&bounty)), Ok(()));
    assert!(round_check(&kira, &safe, &teams, HOUR, ok(&race), ok(&round), ok(&bounty)).is_err());
    assert!(
        round_check(&acc("kira.near"), &safe, &teams, 0, ok(&race), ok(&round), ok(&bounty)).is_err(),
        "the whole account"
    );
    assert!(round_check(&kira, &safe, &teams, 0, ok(&race), None, ok(&bounty)).is_err());
    assert!(round_check(&kira, &safe, &teams, 0, ok(&race), ok(&round), None).is_err());
    // The review's F4 again: the same round, opened by anyone else, is no round of ours.
    assert_eq!(
        round_check(&kira, &safe, &[acc("thief.near")], 0, ok(&race), ok(&round), ok(&bounty)),
        Err("the round was not opened by one of the factory's teams")
    );
    let mut no_owner = ok(&bounty).unwrap();
    no_owner["owner"] = Value::Null;
    assert!(round_check(&kira, &safe, &teams, 0, ok(&race), ok(&round), Some(no_owner)).is_err());
}

/// The review's F4: anyone may open a round on the bounty contract, with any contract as its "safe" and any mask on
/// its list. Someone holding the keeper's key opens one with KIRA on their own contract: KIRA gets no key, its hold
/// goes back, and it burns no gas there. Before the team check, the round passed and the keys went on.
#[test]
fn a_round_a_stranger_opened_gets_no_key() {
    let results = views_by("thief.near", "thief-safe.near", &["kira.masks.near"], "open", HOUR);
    assert_refused(results, "thief-safe.near", 0, "the round was not opened by one of the factory's teams");
}

#[test]
fn the_keeper_asks_only_for_set_owner_and_sweep_on_the_safe() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    for methods in [
        vec![],
        vec!["sweep"],
        vec!["sweep", "set_owner"],
        vec!["set_owner", "sweep", "reclaim"],
        vec!["set_owner", "withdraw"],
        vec!["new", "arm"],
    ] {
        as_("keeper.near");
        let methods: Vec<String> = methods.iter().map(|m| m.to_string()).collect();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = f.arm("kira".into(), "race-0009".into(), pk(1), acc("safe-0009.near"), pk(2), methods.clone());
        }));
        assert!(r.is_err(), "{methods:?}");
        assert_eq!(f.get_mask("kira".into()).unwrap().state, "ready", "{methods:?}: nothing held");
    }
    assert_eq!(f.config().target_methods, ["set_owner", "sweep"]);
}

#[test]
fn a_race_settled_while_the_arena_answers_gets_no_key() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", 2 * ONE).brain.0;
    as_("keeper.near");
    let _ = f.arm("kira".into(), "race-0009".into(), pk(1), acc("safe-0009.near"), pk(2), safe_methods());
    let _ = f.settle("kira".into(), "race-0009".into(), U128(0));
    assert!(refused(on_round(&mut f, "kira", "race-0009", "safe-0009.near", open_round(HOUR), 0)));
    assert!(calls().iter().all(|(_, m, _)| m != "add_keys"), "no key outlives its race");
    assert_eq!((f.get_mask("kira".into()).unwrap().brain.0, f.total_held), (brain, 0));
}

#[test]
fn a_mask_paused_while_the_arena_answers_gets_no_key() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    let _ = f.arm("kira".into(), "race-0009".into(), pk(1), acc("safe-0009.near"), pk(2), safe_methods());
    as_("ann.near");
    f.pause("kira".into());
    assert!(refused(on_round(&mut f, "kira", "race-0009", "safe-0009.near", open_round(HOUR), 0)));
    assert!(calls().iter().all(|(_, m, _)| m != "add_keys"), "the owner's pause wins");
    // The race still holds until the keeper settles it for what the mind spent.
    assert_eq!(f.get_mask("kira".into()).unwrap().state, "paused");
    assert_eq!(f.total_held, DEFAULT_RACE_LIMIT.as_yoctonear());
}

#[test]
fn arming_asks_the_arena_about_the_round_before_any_key() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    let _ = f.arm("kira".into(), "race-0009".into(), pk(1), acc("safe-0009.near"), pk(2), safe_methods());
    let asked: Vec<(AccountId, String)> = calls().into_iter().map(|(to, m, _)| (to, m)).collect();
    assert_eq!(
        asked,
        vec![
            (acc("bounty.near"), "get_safe".to_string()),
            (acc("bounty.near"), "get_round".to_string()),
            (acc("bounty.near"), "get".to_string()),
            (acc("masks.near"), "on_round".to_string()),
        ],
        "no add_keys before the arena answers"
    );
}

#[test]
fn settling_pays_what_the_mind_spent_and_removes_the_keys() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", 2 * ONE).brain.0;
    let _ = arm(&mut f, "kira", "race-0009");
    as_("keeper.near");
    let v = f.settle("kira".into(), "race-0009".into(), U128(12 * MILLI));
    assert_eq!(transfers(), vec![(acc("treasury.near"), 12 * MILLI)]);
    let (to, _, args) = calls().into_iter().find(|(_, m, _)| m == "remove_keys").unwrap();
    assert_eq!((to, Vec::<PublicKey>::try_from_slice(&args).unwrap()), (acc("kira.masks.near"), vec![pk(1), pk(2)]));
    assert_eq!((v.state.as_str(), v.brain.0, v.spent.0, v.races), ("ready", brain - 12 * MILLI, 12 * MILLI, 1));
    assert_eq!((f.total_brain, f.total_held), (brain - 12 * MILLI, 0));
    assert!(events().iter().any(|e| e.contains(r#""event":"settle""#)));
}

#[test]
fn a_race_that_cost_nothing_sends_nothing() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm(&mut f, "kira", "race-0009");
    as_("keeper.near");
    f.settle("kira".into(), "race-0009".into(), U128(0));
    assert!(transfers().is_empty());
}

refused!(only_the_keeper_arms, "only the keeper arms and settles races", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("ann.near");
    f.arm("kira".into(), "race-0009".into(), pk(1), acc("safe-0009.near"), pk(2), safe_methods())
});
refused!(only_the_keeper_settles, "only the keeper arms and settles races", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm(&mut f, "kira", "race-0009");
    as_("ann.near");
    f.settle("kira".into(), "race-0009".into(), U128(0))
});
refused!(the_mind_spends_no_more_than_the_race_held, "the mind cannot spend more than the race held", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm(&mut f, "kira", "race-0009");
    as_("keeper.near");
    f.settle("kira".into(), "race-0009".into(), U128(DEFAULT_RACE_LIMIT.as_yoctonear() + 1))
});
refused!(settle_the_race_it_is_in, "the mask is armed for another race", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm(&mut f, "kira", "race-0009");
    as_("keeper.near");
    f.settle("kira".into(), "race-0010".into(), U128(0))
});
refused!(one_race_at_a_time, "the mask is already in a race", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm(&mut f, "kira", "race-0009");
    arm(&mut f, "kira", "race-0010")
});
refused!(no_race_on_an_empty_tank, "the mind is out of fuel", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("ann.near");
    let _ = f.unfuel("kira".into(), None);
    arm(&mut f, "kira", "race-0009")
});
refused!(no_race_while_forging, "the mask is still being forged", |f| {
    let _ = forge_as(&mut f, "ann.near", "kira", 2 * ONE, None);
    arm(&mut f, "kira", "race-0009")
});
refused!(one_key_per_receiver, "one key per receiver", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    f.arm("kira".into(), "race-0009".into(), pk(1), acc("safe-0009.near"), pk(1), safe_methods())
});
refused!(the_target_is_not_the_arena, "the target is neither the arena", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    f.arm("kira".into(), "race-0009".into(), pk(1), acc("bounty.near"), pk(2), safe_methods())
});
refused!(the_target_is_not_a_mask, "the target is neither the arena", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    f.arm("kira".into(), "race-0009".into(), pk(1), acc("lena.masks.near"), pk(2), safe_methods())
});
refused!(the_target_is_not_the_factory, "the target is neither the arena", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    f.arm("kira".into(), "race-0009".into(), pk(1), acc("masks.near"), pk(2), safe_methods())
});
refused!(target_methods_are_set_owner_and_sweep, "target_methods: set_owner and sweep", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    f.arm("kira".into(), "race-0009".into(), pk(1), acc("safe-0009.near"), pk(2), vec!["sweep".into()])
});
refused!(a_race_id_is_plain, "race: 1 to 64", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    f.arm("kira".into(), "race 9".into(), pk(1), acc("safe-0009.near"), pk(2), safe_methods())
});

#[test]
fn a_race_nobody_settles_is_released_for_free() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", 2 * ONE).brain.0;
    let _ = arm(&mut f, "kira", "race-0009");
    ctx("anyone.near", 0, 60 * 60_000_000_000);
    let v = f.release("kira".into());
    assert_eq!((v.state.as_str(), v.brain.0, v.spent.0, v.races), ("ready", brain, 0, 0));
    assert!(transfers().is_empty(), "the mind pays nothing for that race");
    assert!(calls().iter().any(|(_, m, _)| m == "remove_keys"));
    assert_eq!((f.total_brain, f.total_held), (brain, 0));
}

refused!(the_keeper_has_time_to_settle, "the keeper still has time to settle", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm(&mut f, "kira", "race-0009");
    ctx("anyone.near", 0, 59 * 60_000_000_000);
    f.release("kira".into())
});

#[test]
fn pausing_removes_the_race_keys_at_once_and_stops_new_races() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm(&mut f, "kira", "race-0009");
    as_("ann.near");
    let v = f.pause("kira".into());
    assert_eq!(v.state, "paused");
    assert!(v.race.as_ref().unwrap().keys.is_empty());
    assert!(calls().iter().any(|(to, m, _)| *to == acc("kira.masks.near") && m == "remove_keys"));
    // The race is still settled for what the mind spent, and no key is removed twice.
    as_("keeper.near");
    f.settle("kira".into(), "race-0009".into(), U128(MILLI));
    assert!(!calls().iter().any(|(_, m, _)| m == "remove_keys"));
    assert_eq!(f.budget("kira".into()).0, 0);
    as_("ann.near");
    assert_eq!(f.resume("kira".into()).state, "ready");
}

refused!(a_paused_mask_is_not_armed, "the owner paused this mask", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("ann.near");
    f.pause("kira".into());
    arm(&mut f, "kira", "race-0009")
});
refused!(only_the_owner_pauses, "only the mask's owner", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("keeper.near");
    f.pause("kira".into())
});

// ---------------------------------------------------------------------------------------------------------------------
// The mask code and the admin
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_mask_code_is_published_once_by_its_hash() {
    let mut f = factory();
    f.mask_code = MaskCode { sha256: admin::sha256_hex(b"mask wasm"), published: false };
    with_input("anyone.near", 0, b"mask wasm");
    let _ = f.publish_mask_code();
    assert!(actions()
        .iter()
        .any(|(to, a)| *to == acc("masks.near") && matches!(a, MockAction::DeployGlobalContract { .. })));
    let sha = f.mask_code.sha256.clone();
    assert!(f.on_published(sha, Ok(())));
    assert!(f.mask_code.published);
}

refused!(only_the_factory_mask_code_is_published, "this wasm is not the factory's mask code", |f| {
    f.mask_code.published = false;
    with_input("anyone.near", 0, b"other wasm");
    f.publish_mask_code()
});

#[test]
fn renewing_moves_the_mask_to_the_current_code() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let new = "b".repeat(64);
    f.mask_code = MaskCode { sha256: new.clone(), published: true };
    as_("ann.near");
    let _ = f.renew("kira".into());
    let (to, _, args) = calls().into_iter().find(|(_, m, _)| m == "use_code").unwrap();
    assert_eq!((to, args), (acc("kira.masks.near"), hex32(&new).to_vec()));
    as_("masks.near");
    assert!(f.on_renewed("kira".into(), new.clone(), Ok(())));
    assert_eq!(f.get_mask("kira".into()).unwrap().code, new);
}

refused!(only_the_owner_renews, "only the mask's owner", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    f.mask_code = MaskCode { sha256: "b".repeat(64), published: true };
    as_("keeper.near");
    f.renew("kira".into())
});

#[test]
fn before_the_first_mask_a_change_waits_an_hour() {
    let mut f = factory();
    as_("admin.near");
    f.propose(Change::Keeper { account: acc("keeper2.near") });
    ctx("anyone.near", 0, HOUR);
    assert_eq!(f.apply().keeper, acc("keeper2.near"));
    assert!(f.pending().is_none());
}

#[test]
#[should_panic(expected = "the change is still waiting")]
fn once_a_mask_exists_a_change_waits_three_days() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("admin.near");
    f.propose(Change::Treasury { account: acc("thief.near") });
    ctx("anyone.near", 0, 71 * HOUR);
    f.apply();
}

#[test]
fn after_three_days_the_change_applies() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("admin.near");
    f.propose(Change::StrategyKey { key: format!("x25519:{}", "c".repeat(64)) });
    ctx("anyone.near", 0, CHANGE_DELAY_HOURS * HOUR);
    assert_eq!(f.apply().strategy_key, Some(format!("x25519:{}", "c".repeat(64))));
}

/// A new team could send masks into rounds of its own: it waits the three days like the keeper or the arena.
#[test]
fn the_teams_change_only_after_the_wait() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    assert_eq!(f.config().teams, [acc("team.near")]);
    as_("admin.near");
    let teams = vec![acc("team.near"), acc("season.team.near")];
    f.propose(Change::Teams { accounts: teams.clone() });
    ctx("anyone.near", 0, 71 * HOUR);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.apply()));
    assert!(early.is_err(), "still waiting");
    ctx("anyone.near", 0, CHANGE_DELAY_HOURS * HOUR);
    assert_eq!(f.apply().teams, teams);
}

#[test]
fn teams_are_real_teams() {
    as_("admin.near");
    let ok = |t: &[&str]| teams_ok(&t.iter().map(|a| acc(a)).collect::<Vec<_>>(), &acc("bounty.near"));
    assert!(ok(&["team.near"]) && ok(&["team.near", "season.near"]));
    assert!(!ok(&[]), "at least one");
    assert!(!ok(&["a.near", "b.near", "c.near", "d.near", "e.near", "f.near", "g.near", "h.near", "i.near"]));
    assert!(!ok(&["team.near", "team.near"]), "none twice");
    assert!(!ok(&["bounty.near"]), "not the arena");
    assert!(!ok(&["masks.near"]), "not the factory");
    assert!(!ok(&["kira.masks.near"]), "not a mask");
}

refused!(a_team_list_is_checked_when_proposed, "teams: 1 to 8 accounts", |f| {
    as_("admin.near");
    f.propose(Change::Teams { accounts: vec![acc("kira.masks.near")] })
});

#[test]
#[should_panic(expected = "teams: 1 to 8 accounts")]
fn a_factory_starts_with_a_team() {
    as_("admin.near");
    let _ = Factory::new(
        acc("admin.near"),
        acc("keeper.near"),
        acc("treasury.near"),
        acc("bounty.near"),
        CODE.into(),
        None,
        catalog(),
        60,
        vec![],
    );
}

#[test]
fn a_new_mask_code_closes_the_forge_until_it_is_published() {
    let mut f = factory();
    as_("admin.near");
    f.propose(Change::MaskCode { sha256: "d".repeat(64) });
    ctx("anyone.near", 0, HOUR);
    let c = f.apply();
    assert_eq!(c.mask_code, MaskCode { sha256: "d".repeat(64), published: false });
}

refused!(only_the_admin_proposes, "only the admin proposes changes", |f| {
    as_("keeper.near");
    f.propose(Change::Admin { account: acc("keeper.near") })
});
refused!(one_change_at_a_time, "a change is already pending", |f| {
    as_("admin.near");
    f.propose(Change::Keeper { account: acc("k2.near") });
    f.propose(Change::Keeper { account: acc("k3.near") })
});
refused!(a_strategy_key_is_x25519_hex, "strategy key: x25519:<64 hex>", |f| {
    as_("admin.near");
    f.propose(Change::StrategyKey { key: "ed25519:abc".into() })
});
refused!(new_code_comes_with_upgrade, "new code comes with upgrade", |f| {
    as_("admin.near");
    f.propose(Change::Code { sha256: "e".repeat(64) });
    ctx("anyone.near", 0, HOUR);
    f.apply()
});

#[test]
fn an_upgrade_takes_exactly_the_proposed_wasm_and_migrates() {
    let mut f = factory();
    as_("admin.near");
    f.propose(Change::Code { sha256: admin::sha256_hex(b"factory v2") });
    with_input("anyone.near", HOUR, b"factory v2");
    let _ = f.upgrade();
    let acts = actions();
    assert!(acts.iter().any(|(_, a)| matches!(a, MockAction::DeployContract { .. })));
    assert!(calls().iter().any(|(to, m, _)| *to == acc("masks.near") && m == "migrate"));
    assert!(f.pending.is_none());
}

#[test]
fn the_admin_keeps_the_catalog() {
    let mut f = factory();
    as_("admin.near");
    let mut c = catalog();
    c.looks.push("graphite".into());
    assert_eq!(f.set_catalog(c.clone()), c);
    assert_eq!(f.config().catalog, c);
}

refused!(a_catalog_lists_no_twice, "catalog: 1 to 16 ids", |f| {
    as_("admin.near");
    let mut c = catalog();
    c.looks = vec!["porcelain".into(), "porcelain".into()];
    f.set_catalog(c)
});

#[test]
fn config_tells_the_site_what_it_needs() {
    let f = factory();
    let c = f.config();
    assert_eq!(c.strategy_key.as_deref(), Some(KEY));
    assert_eq!(c.min_fuel.0, ONE);
    assert_eq!(c.arena_methods, vec!["commit", "reveal", "claim_drain", "settle"]);
    assert_eq!(c.race_limit.default.0, DEFAULT_RACE_LIMIT.as_yoctonear());
}

#[test]
fn checks() {
    assert!(sealed_ok(&sealed()));
    assert!(!sealed_ok(&format!("v2.{}", "A".repeat(763))));
    assert!(!sealed_ok(&format!("v1.{}=", "A".repeat(762))));
    assert!(strategy_key_ok(KEY) && !strategy_key_ok(&KEY.to_uppercase()));
    assert!(id_ok("deepseek-ai/DeepSeek-V4.1-Flash-1017") && !id_ok("a b"));
    assert_eq!(hex32(&"0f".repeat(32)), [15u8; 32]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Review 11.2026: one race an hour, the wait that protects prizes, one publish at a time, lapsing changes, migrate
// ---------------------------------------------------------------------------------------------------------------------

fn arm_at(f: &mut Factory, name: &str, race: &str, now: u64) -> PromiseOrValue<bool> {
    ctx("keeper.near", 0, now);
    let _ = f.arm(name.into(), race.into(), pk(1), acc("safe-0009.near"), pk(2), safe_methods());
    on_round(f, name, race, "safe-0009.near", open_round(now + HOUR), now)
}

fn settle_at(f: &mut Factory, name: &str, race: &str, spent: u128, now: u64) -> MaskView {
    ctx("keeper.near", 0, now);
    f.settle(name.into(), race.into(), U128(spent))
}

refused!(a_keeper_cannot_loop_races_to_empty_a_tank, "a mask enters one race an hour", |f| {
    forged(&mut f, "ann.near", "kira", 5 * ONE);
    let held = DEFAULT_RACE_LIMIT.as_yoctonear();
    let _ = arm_at(&mut f, "kira", "race-0001", 0);
    settle_at(&mut f, "kira", "race-0001", held, MINUTE);
    arm_at(&mut f, "kira", "race-0002", 2 * MINUTE)
});

#[test]
fn an_hour_after_the_last_race_the_next_one_arms() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm_at(&mut f, "kira", "race-0001", 0);
    settle_at(&mut f, "kira", "race-0001", MILLI, 10 * MINUTE);
    let _ = arm_at(&mut f, "kira", "race-0002", RACE_GAP_MINUTES * MINUTE);
    assert_eq!(f.get_mask("kira".into()).unwrap().race.unwrap().race, "race-0002");
    assert_eq!(f.config().race_gap_minutes, 60);
}

refused!(a_failed_arming_counts_for_the_hour, "a mask enters one race an hour", |f| {
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm_at(&mut f, "kira", "race-0001", 0);
    as_("masks.near");
    assert!(!f.on_armed("kira".into(), "race-0001".into(), acc("safe-0009.near"), Err(PromiseError::Failed)));
    arm_at(&mut f, "kira", "race-0001", MINUTE)
});

#[test]
fn an_empty_tank_says_so_before_the_hour() {
    let mut f = factory();
    let brain = forged(&mut f, "ann.near", "kira", ONE).brain.0;
    let _ = arm_at(&mut f, "kira", "race-0001", 0);
    settle_at(&mut f, "kira", "race-0001", 0, MINUTE);
    as_("ann.near");
    let _ = f.unfuel("kira".into(), Some(U128(brain)));
    ctx("keeper.near", 0, 2 * MINUTE);
    let why = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = f.arm("kira".into(), "race-0002".into(), pk(1), acc("safe-0009.near"), pk(2), safe_methods());
    }))
    .unwrap_err();
    assert_eq!(why.downcast_ref::<String>().map(String::as_str), Some("the mind is out of fuel"));
}

#[test]
fn the_forge_deposit_pays_for_the_largest_race_record() {
    let mut f = factory();
    let v = forged(&mut f, "ann.near", "kira", 2 * ONE);
    let reserved = 2 * ONE - MASK_FUND.as_yoctonear() - v.brain.0;
    let before = env::storage_usage();
    ctx("keeper.near", 0, 0);
    let _ = f.arm("kira".into(), "r".repeat(64), secp(1), acc("safe-0009.near"), secp(2), safe_methods());
    f.masks.flush();
    f.armed.flush();
    let grew = env::storage_usage() - before;
    println!("the largest race record: {grew} bytes");
    assert!(grew <= RACE_BYTES, "a race record takes {grew} bytes, the forge keeps {RACE_BYTES}");
    assert!(reserved >= env::storage_byte_cost().as_yoctonear() * u128::from(RACE_BYTES));
}

/// ANN's tank is empty, her prize sits on KIRA's account: the factory cannot see it, so the full wait still holds.
#[test]
#[should_panic(expected = "the change is still waiting")]
fn an_empty_tank_does_not_shorten_the_wait() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    as_("ann.near");
    let _ = f.unfuel("kira".into(), None);
    assert_eq!((f.total_brain, f.total_held), (0, 0));
    as_("admin.near");
    f.propose(Change::Code { sha256: admin::sha256_hex(b"factory v2") });
    with_input("anyone.near", HOUR, b"factory v2");
    let _ = f.upgrade();
}

#[test]
fn a_change_lapses_a_day_after_it_is_ready() {
    let mut f = factory();
    as_("admin.near");
    f.propose(Change::Keeper { account: acc("keeper2.near") });
    ctx("anyone.near", 0, HOUR + CHANGE_LAPSE_HOURS * HOUR);
    let late = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.apply())).unwrap_err();
    assert_eq!(
        late.downcast_ref::<String>().map(String::as_str),
        Some("the change lapsed: the admin proposes it again")
    );
    // A lapsed change makes way for the next proposal.
    ctx("admin.near", 0, HOUR + CHANGE_LAPSE_HOURS * HOUR);
    f.propose(Change::Keeper { account: acc("keeper3.near") });
    ctx("anyone.near", 0, 3 * HOUR + CHANGE_LAPSE_HOURS * HOUR);
    assert_eq!(f.apply().keeper, acc("keeper3.near"));
}

#[test]
fn a_change_that_lapsed_before_the_first_mask_stays_dead() {
    let mut f = factory();
    as_("admin.near");
    f.propose(Change::Keeper { account: acc("keeper2.near") });
    // No mask yet: ready an hour later, lapsed a day after that. The first mask comes an hour later still.
    ctx("ann.near", 2 * ONE, 2 * HOUR + CHANGE_LAPSE_HOURS * HOUR);
    let _ = f.forge(
        "kira".into(),
        "porcelain".into(),
        "z-ai/glm-5.3-flash".into(),
        "patient".into(),
        None,
        None,
        None,
        None,
    );
    assert!(f.pending().is_none());
    // Without that, the long wait would make the dead change ready again three days after it was proposed.
    ctx("anyone.near", 0, CHANGE_DELAY_HOURS * HOUR + HOUR);
    let dead = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.apply())).unwrap_err();
    let said = dead.downcast_ref::<String>().cloned().unwrap_or_default();
    assert!(said.contains("no change is pending"), "{said}");
}

#[test]
fn the_race_storage_each_mask_prepaid_is_not_the_factorys_own() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    forged(&mut f, "bob.near", "zeta", 2 * ONE);
    as_("anyone.near");
    let cost = env::storage_byte_cost().as_yoctonear();
    let written = cost * u128::from(env::storage_usage());
    let prepaid = cost * 2 * u128::from(RACE_BYTES);
    let own = env::account_balance().as_yoctonear() - written - prepaid - f.total_brain - f.total_held;
    assert_eq!(f.own_near(), own);
}

#[test]
fn one_publish_at_a_time() {
    let mut f = factory();
    f.mask_code = MaskCode { sha256: admin::sha256_hex(b"mask wasm"), published: false };
    with_input("anyone.near", 0, b"mask wasm");
    let _ = f.publish_mask_code();
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = f.publish_mask_code();
    }))
    .unwrap_err();
    assert_eq!(again.downcast_ref::<String>().map(String::as_str), Some("the mask code is already on its way"));
    // A publish that failed frees the way for the next one.
    as_("masks.near");
    assert!(!f.on_published(f.mask_code.sha256.clone(), Err(PromiseError::Failed)));
    with_input("anyone.near", 0, b"mask wasm");
    let _ = f.publish_mask_code();
    assert!(f.publishing);
}

#[test]
fn the_masks_never_pay_for_publishing() {
    let mut f = factory();
    let wasm = vec![7u8; 50_000];
    f.mask_code = MaskCode { sha256: admin::sha256_hex(&wasm), published: false };
    with_input("anyone.near", 0, &wasm);
    let price = GLOBAL_CODE_BYTE_COST * wasm.len() as u128;
    // The tanks take all of the factory's NEAR but a yocto less than the price.
    f.total_brain = f.own_near() - price + 1;
    let short = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = f.publish_mask_code();
    }))
    .unwrap_err();
    assert_eq!(
        short.downcast_ref::<String>().map(String::as_str),
        Some("the factory's own NEAR does not cover publishing: top it up first")
    );
    f.total_brain -= 1;
    let _ = f.publish_mask_code();
    assert!(actions().iter().any(|(_, a)| matches!(a, MockAction::DeployGlobalContract { .. })));
}

#[test]
fn migrate_reads_the_first_layout_and_keeps_every_mask() {
    let mut f = factory();
    let kira = forged(&mut f, "ann.near", "kira", 2 * ONE);
    forged(&mut f, "bob.near", "lena", ONE);
    let _ = arm_at(&mut f, "kira", "race-0001", 0);
    f.masks.flush();
    f.names.flush();
    f.owners.flush();
    let before = f.config();
    let Factory {
        admin,
        keeper,
        treasury,
        arena,
        mask_code,
        strategy_key,
        catalog,
        release_minutes,
        masks,
        names,
        owners,
        total_brain,
        total_held,
        pending,
        ..
    } = f;
    let v1 = FactoryV1 {
        admin,
        keeper,
        treasury,
        arena,
        mask_code,
        strategy_key,
        catalog,
        release_minutes,
        masks,
        names,
        owners,
        total_brain,
        total_held,
        pending,
    };
    env::state_write(&v1);
    drop(v1);

    as_("masks.near");
    let mut f = Factory::migrate();
    // The first factory had no team list: its admin is its one team.
    assert_eq!(f.config().teams, [acc("admin.near")]);
    assert_eq!(Config { teams: before.teams.clone(), ..f.config() }, before);
    assert!(!f.publishing);
    // Here the rounds are the team's: the list as a change would leave it after the wait.
    f.teams = before.teams.clone();
    assert!(events().iter().any(|e| e.contains(r#""event":"migrate""#)));
    let k = f.get_mask("kira".into()).unwrap();
    assert_eq!((k.owner.as_str(), k.state.as_str(), k.fuel.0), ("ann.near", "racing", kira.fuel.0));
    assert_eq!(f.masks_of(acc("bob.near"))[0].name, "lena");
    assert_eq!(f.list_masks(None, None).len(), 2);
    // The race armed under the first code settles under the new one; the hour counts from the new code's first arming.
    settle_at(&mut f, "kira", "race-0001", MILLI, MINUTE);
    let _ = arm_at(&mut f, "kira", "race-0002", 2 * MINUTE);
    let _ = arm_at(&mut f, "lena", "race-0002", 2 * MINUTE);
    settle_at(&mut f, "kira", "race-0002", 0, 3 * MINUTE);
    let soon = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = arm_at(&mut f, "kira", "race-0003", 4 * MINUTE);
    }));
    assert!(soon.is_err(), "one race an hour from then on");
}

#[test]
fn migrate_on_the_current_state_changes_nothing() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    let _ = arm_at(&mut f, "kira", "race-0001", 0);
    f.masks.flush();
    f.names.flush();
    f.owners.flush();
    f.armed.flush();
    let before = f.config();
    env::state_write(&f);
    as_("masks.near");
    let mut f = Factory::migrate();
    assert_eq!(f.config(), before);
    assert!(!events().iter().any(|e| e.contains(r#""event":"migrate""#)));
    settle_at(&mut f, "kira", "race-0001", 0, MINUTE);
    let late = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = arm_at(&mut f, "kira", "race-0002", 2 * MINUTE);
    }));
    assert!(late.is_err(), "the hour since race-0001 survives the migration");
}

// ---------------------------------------------------------------------------------------------------------------------
// Confidential copying
// ---------------------------------------------------------------------------------------------------------------------

/// A forged mask with a sealed strategy, its account made.
fn forged_with_strategy(f: &mut Factory, who: &str, name: &str, deposit: u128) -> MaskView {
    let _ = forge_as(f, who, name, deposit, Some(sealed()));
    as_("masks.near");
    f.on_forged(name.into(), Ok(())).unwrap()
}

/// `who` starts forging `name` as a copy of `author`, agreeing to the share `bps`.
fn forge_copy_as(f: &mut Factory, who: &str, name: &str, author: &str, bps: u16, deposit: u128) -> Promise {
    ctx(who, deposit, 0);
    f.forge(
        name.into(),
        "porcelain".into(),
        "z-ai/glm-5.3-flash".into(),
        "patient".into(),
        None,
        None,
        Some(author.into()),
        Some(bps),
    )
}

/// `who` forges `name` as a copy of `author` at the share `bps`, and the account is made.
fn forge_copy(f: &mut Factory, who: &str, name: &str, author: &str, bps: u16, deposit: u128) -> MaskView {
    let _ = forge_copy_as(f, who, name, author, bps, deposit);
    as_("masks.near");
    f.on_forged(name.into(), Ok(())).unwrap()
}

/// ANN forges KIRA with a strategy and opens it to copying for `bps`.
fn author(f: &mut Factory, bps: u16) {
    forged_with_strategy(f, "ann.near", "kira", 2 * ONE);
    ctx("ann.near", ONE, 0);
    let _ = f.allow_copy("kira".into(), bps);
}

#[test]
fn an_author_opens_a_mask_to_copying_and_a_copy_plays_it() {
    let mut f = factory();
    forged_with_strategy(&mut f, "ann.near", "kira", 2 * ONE);
    ctx("ann.near", ONE, 0);
    let author = f.allow_copy("kira".into(), 2000);
    assert!(author.copyable && author.author_bps == 2000 && author.copies == 0);

    // BOB forges NINA as a copy of KIRA: the copy's account is told its author (KIRA's own account) and share, so its
    // own code splits the winnings. Read the init call before the forge callback.
    let _ = forge_copy_as(&mut f, "bob.near", "nina", "kira", 2000, 2 * ONE);
    let (_, _, args) = calls().into_iter().find(|(to, m, _)| *to == acc("nina.masks.near") && m == "init").unwrap();
    let (owner, author_init) = <(AccountId, Option<(AccountId, u16)>)>::try_from_slice(&args).unwrap();
    assert_eq!((owner, author_init), (acc("bob.near"), Some((acc("kira.masks.near"), 2000))));
    as_("masks.near");
    let nina = f.on_forged("nina".into(), Ok(())).unwrap();
    assert_eq!((nina.copy_of.as_deref(), nina.copy_bps, nina.strategy), (Some("kira"), 2000, false));

    // KIRA now counts one copy, and lists it.
    assert_eq!(f.get_mask("kira".into()).unwrap().copies, 1);
    let kids = f.copies_of("kira".into(), None, None);
    assert_eq!(kids.len(), 1);
    assert_eq!((kids[0].name.as_str(), kids[0].account.as_str(), kids[0].bps), ("nina", "nina.masks.near", 2000));
    assert!(events().iter().any(|e| e.contains(r#""event":"copy""#) && e.contains("nina")));
    // A copy has no box of its own: nothing on the factory holds a strategy for it.
    assert!(f.get_sealed_strategy("nina".into()).is_none());
}

#[test]
#[should_panic(expected = "at most 30%")]
fn the_author_share_is_capped_at_thirty_percent() {
    let mut f = factory();
    forged_with_strategy(&mut f, "ann.near", "kira", 2 * ONE);
    ctx("ann.near", ONE, 0);
    let _ = f.allow_copy("kira".into(), MAX_AUTHOR_BPS + 1);
}

#[test]
#[should_panic(expected = "has nothing to copy")]
fn a_mask_with_no_strategy_cannot_be_copied() {
    let mut f = factory();
    forged(&mut f, "ann.near", "kira", 2 * ONE);
    ctx("ann.near", ONE, 0);
    let _ = f.allow_copy("kira".into(), 2000);
}

#[test]
#[should_panic(expected = "only the mask's owner")]
fn only_the_owner_opens_a_mask_to_copying() {
    let mut f = factory();
    forged_with_strategy(&mut f, "ann.near", "kira", 2 * ONE);
    ctx("bob.near", ONE, 0);
    let _ = f.allow_copy("kira".into(), 2000);
}

#[test]
#[should_panic(expected = "only the mask's owner")]
fn only_the_owner_stops_copying() {
    let mut f = factory();
    author(&mut f, 2000);
    as_("bob.near");
    let _ = f.stop_copy("kira".into());
}

#[test]
#[should_panic(expected = "not open to copying")]
fn a_copy_of_a_mask_not_open_is_refused() {
    let mut f = factory();
    forged_with_strategy(&mut f, "ann.near", "kira", 2 * ONE);
    // KIRA was never opened to copying.
    let _ = forge_copy(&mut f, "bob.near", "nina", "kira", 2000, 2 * ONE);
}

#[test]
#[should_panic(expected = "plays its author's strategy, not one of its own")]
fn a_copy_carries_no_strategy_of_its_own() {
    let mut f = factory();
    author(&mut f, 2000);
    ctx("bob.near", 2 * ONE, 0);
    let _ = f.forge(
        "nina".into(),
        "porcelain".into(),
        "z-ai/glm-5.3-flash".into(),
        "patient".into(),
        Some(sealed()),
        None,
        Some("kira".into()),
        Some(2000),
    );
}

#[test]
#[should_panic(expected = "none to lend")]
fn a_copy_cannot_itself_be_copied() {
    let mut f = factory();
    author(&mut f, 2000);
    forge_copy(&mut f, "bob.near", "nina", "kira", 2000, 2 * ONE);
    // NINA is a copy; it cannot be opened to copying.
    ctx("bob.near", ONE, 0);
    let _ = f.allow_copy("nina".into(), 1000);
}

#[test]
fn stopping_copy_touches_only_new_copies() {
    let mut f = factory();
    author(&mut f, 2000);
    forge_copy(&mut f, "bob.near", "nina", "kira", 2000, 2 * ONE);
    // ANN stops copying: the open copy keeps its terms and still shows as a copy.
    as_("ann.near");
    let kira = f.stop_copy("kira".into());
    assert!(!kira.copyable && kira.copies == 1, "the one made before still counts");
    assert_eq!(f.get_mask("nina".into()).unwrap().copy_of.as_deref(), Some("kira"));
    // A new copy is refused now.
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        forge_copy(&mut f, "bob.near", "mira", "kira", 2000, 2 * ONE)
    }));
    assert!(again.is_err(), "no new copy after stop_copy");
}

/// A copy whose forge is on its way when the author stops copying still lands, and still counts on the author's list.
#[test]
fn a_copy_on_its_way_when_copying_stops_still_counts() {
    let mut f = factory();
    author(&mut f, 2000);
    let _ = forge_copy_as(&mut f, "bob.near", "nina", "kira", 2000, 2 * ONE);
    as_("ann.near");
    let _ = f.stop_copy("kira".into());
    as_("masks.near");
    f.on_forged("nina".into(), Ok(())).unwrap();
    assert_eq!(f.get_mask("kira".into()).unwrap().copies, 1);
    assert_eq!(f.copies_of("kira".into(), None, None)[0].name, "nina");
}

#[test]
fn a_failed_copy_forge_raises_no_count() {
    let mut f = factory();
    author(&mut f, 2000);
    let _ = forge_copy_as(&mut f, "bob.near", "nina", "kira", 2000, 2 * ONE);
    // The account's batch fails: the copy record is removed and KIRA gains no copy.
    as_("masks.near");
    assert!(f.on_forged("nina".into(), Err(near_sdk::PromiseError::Failed)).is_none());
    assert_eq!(f.get_mask("kira".into()).unwrap().copies, 0);
    assert!(f.copies_of("kira".into(), None, None).is_empty());
    assert!(f.get_mask("nina".into()).is_none());
}

// ---- review finding 1: nobody reads a strategy -----------------------------------------------------------------

/// Review finding 1, the attack: BOB, the owner of a copy, granted a view of his copy to an account of his choosing,
/// and the mind sealed KIRA's strategy for it. That method is gone: the factory keeps no viewers, and nothing it holds
/// or answers opens a strategy for anyone. The ABI the site and the mind read lists no such call.
#[test]
fn the_factory_has_no_call_that_opens_a_strategy_to_anyone() {
    let abi = include_str!("lib.rs");
    for gone in ["fn grant_view", "fn revoke_view", "fn views_of", "ViewGrant"] {
        assert!(!abi.contains(gone), "{gone} is back: a view of a strategy is never granted");
    }
    let mut f = factory();
    author(&mut f, 3000);
    let nina = forge_copy(&mut f, "bob.near", "nina", "kira", 3000, 2 * ONE);
    let shown = near_sdk::serde_json::to_string(&nina).unwrap();
    assert!(!shown.contains("views") && !shown.contains("sealed"), "a copy's record shows no strategy: {shown}");
    assert!(f.get_sealed_strategy("nina".into()).is_none(), "a copy has no box of its own to hand out");
}

// ---- review finding 4: the share the person saw is the share they get ----------------------------------------

/// Review finding 4, the attack: BOB looks at KIRA, open to copying for 10%, and signs a copy. Before his forge lands
/// ANN raises KIRA's share to 30% (`allow_copy` may be called again). In the code under review the copy was forged at
/// 30%, terms BOB never saw. Now the forge carries the share BOB agreed to, and a changed share forges nothing.
#[test]
#[should_panic(expected = "the author's share changed: you agreed to 1000 bps, it is now 3000 bps")]
fn a_share_raised_between_the_look_and_the_forge_forges_nothing() {
    let mut f = factory();
    author(&mut f, 1000);
    // BOB saw 10%. ANN raises the share.
    ctx("ann.near", ONE, 0);
    let _ = f.allow_copy("kira".into(), 3000);
    let _ = forge_copy_as(&mut f, "bob.near", "nina", "kira", 1000, 2 * ONE);
}

#[test]
#[should_panic(expected = "copy_bps: the author's share you agreed to")]
fn a_copy_names_the_share_it_agreed_to() {
    let mut f = factory();
    author(&mut f, 1000);
    ctx("bob.near", 2 * ONE, 0);
    let _ = f.forge(
        "nina".into(),
        "porcelain".into(),
        "z-ai/glm-5.3-flash".into(),
        "patient".into(),
        None,
        None,
        Some("kira".into()),
        None,
    );
}

#[test]
#[should_panic(expected = "copy_bps goes with copy_of")]
fn a_share_without_an_author_is_refused() {
    let mut f = factory();
    ctx("bob.near", 2 * ONE, 0);
    let _ = f.forge(
        "nina".into(),
        "porcelain".into(),
        "z-ai/glm-5.3-flash".into(),
        "patient".into(),
        None,
        None,
        None,
        Some(1000),
    );
}

/// The share BOB agreed to is the one fixed for his copy, and an author who lowers the share later does not change it.
#[test]
fn the_agreed_share_is_fixed_for_the_copy() {
    let mut f = factory();
    author(&mut f, 1000);
    let nina = forge_copy(&mut f, "bob.near", "nina", "kira", 1000, 2 * ONE);
    assert_eq!(nina.copy_bps, 1000);
    ctx("ann.near", ONE, 0);
    let _ = f.allow_copy("kira".into(), 500);
    assert_eq!(f.get_mask("nina".into()).unwrap().copy_bps, 1000);
    assert_eq!(f.copies_of("kira".into(), None, None)[0].bps, 1000);
}

// ---- review finding 8: an author's copies without walking every mask ---------------------------------------------

/// Review finding 8, the attack: in the code under review `copies_of` walked every mask the factory ever forged, so
/// with a thousand or two masks the view ran out of gas and the author's page quietly showed no copies (there, these 301
/// masks cost 38.7 TGas, and a view's 200 TGas ran out at about 1,550). Now each author keeps its own list: here 300
/// other masks stand between KIRA's copies, and the view reads KIRA's list alone, page by page, its reads bounded by
/// the page and not by the factory (0.7 TGas).
#[test]
fn an_author_s_copies_are_read_from_its_own_list() {
    let mut f = factory();
    author(&mut f, 2000);
    let names: Vec<String> = (0..300).map(|i| format!("m{i:03}")).collect();
    for (i, name) in names.iter().enumerate() {
        // Every hundredth mask is a copy of KIRA; the rest are plain masks of many people.
        let who = format!("p{}.near", i / 8);
        if i % 100 == 50 {
            forge_copy(&mut f, &who, name, "kira", 2000, 2 * ONE);
        } else {
            forged(&mut f, &who, name, 2 * ONE);
        }
    }
    assert_eq!(f.get_mask("kira".into()).unwrap().copies, 3);
    // Read the factory back from storage, as a view call finds it: nothing cached in memory, every read paid for.
    f.masks.flush();
    f.names.flush();
    f.owners.flush();
    f.copy.flush();
    f.links.flush();
    env::state_write(&f);
    let f: Factory = env::state_read().unwrap();
    let reads = |from, limit| {
        let before = env::used_gas();
        let page = f.copies_of("kira".into(), from, limit);
        (page, env::used_gas().as_gas() - before.as_gas())
    };
    let (all, gas_all) = reads(None, None);
    let got: Vec<&str> = all.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(got, ["m050", "m150", "m250"], "in forging order");
    let (page, _) = reads(Some(1), Some(1));
    assert_eq!(page.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["m150"]);
    assert!(reads(Some(3), None).0.is_empty());
    // Three copies among 301 masks cost what three copies cost: under 3 TGas, far from a view's 200, however many masks.
    println!("copies_of: 3 copies among 301 masks, {gas_all} gas");
    assert!(gas_all < 3_000_000_000_000, "copies_of burned {gas_all} gas");
}

/// A copy's forge pays for its entry in its author's list: the longest names fit in what it keeps.
#[test]
fn a_copy_s_forge_pays_for_its_entry_in_the_author_s_list() {
    let mut f = factory();
    ctx("ann.near", 2 * ONE, 0);
    let _ = f.forge(
        "k".repeat(16),
        "porcelain".into(),
        "z-ai/glm-5.3-flash".into(),
        "patient".into(),
        Some(sealed()),
        None,
        None,
        None,
    );
    as_("masks.near");
    f.on_forged("k".repeat(16), Ok(())).unwrap();
    ctx("ann.near", ONE, 0);
    let _ = f.allow_copy("k".repeat(16), 2000);
    let _ = forge_copy_as(&mut f, "bob.near", &"n".repeat(16), &"k".repeat(16), 2000, 2 * ONE);
    as_("masks.near");
    let before = env::storage_usage();
    f.on_forged("n".repeat(16), Ok(())).unwrap();
    f.links.flush();
    f.copy.flush();
    f.masks.flush();
    let grew = env::storage_usage() - before;
    println!("the longest list entry: {grew} bytes");
    assert!(grew <= LINK_BYTES, "a list entry takes {grew} bytes, the forge keeps {LINK_BYTES}");
    // And the copy's deposit kept it: its tank is that much smaller than a plain mask's forged with the same NEAR.
    let copy = f.get_mask("n".repeat(16)).unwrap().brain.0;
    let plain = forged(&mut f, "bob.near", &"p".repeat(16), 2 * ONE).brain.0;
    assert!(plain - copy >= env::storage_byte_cost().as_yoctonear() * u128::from(LINK_BYTES));
}
