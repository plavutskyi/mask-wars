use super::*;
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const CONTRACT: &str = "crews.maskwars.testnet";
const ADMIN: &str = "maskwars.testnet";
const FACTORY: &str = "masks.maskwars.testnet";
const JOBS: &str = "jobs.maskwars.testnet";
/// ANN owns KIRA, a mask forged by the factory; NOVA is the arena's own mask with its own key.
const ANN: &str = "ann.testnet";
const KIRA: &str = "kira.masks.maskwars.testnet";
const NOVA: &str = "nova.maskwars.testnet";
const LENA: &str = "lena.masks.maskwars.testnet";
const ID: &str = "duo";
const ONE: u128 = 10u128.pow(24);
const HOUR: u64 = NS_PER_HOUR;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(who: &str, deposit: u128, now: u64) -> VMContextBuilder {
    let mut c = VMContextBuilder::new();
    c.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300));
    c
}

fn as_(who: &str, deposit: u128, now: u64) {
    testing_env!(ctx(who, deposit, now).build());
}

fn panics<R>(f: impl FnOnce() -> R) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).err().expect("it should have panicked");
    let msg =
        err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap();
    match msg.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.rsplit_once("\" }").map_or(rest, |(m, _)| m).to_string(),
        None => msg,
    }
}

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

fn calls() -> Vec<(String, String, Value)> {
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

fn contract() -> Crews {
    as_(ADMIN, 0, 0);
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    as_(ADMIN, 0, 0);
    Crews::new(acc(ADMIN), vec![acc(FACTORY)])
}

/// What the end of a call does: every write goes to disk. Unit tests keep the contract in memory between calls, so
/// a test that measures storage across calls ends each one this way.
fn persist(c: Crews) -> Crews {
    let raw = near_sdk::borsh::to_vec(&c).unwrap();
    drop(c);
    near_sdk::borsh::from_slice(&raw).unwrap()
}

fn duo() -> Vec<Member> {
    vec![Member { mask: acc(KIRA), role: Role::Scout }, Member { mask: acc(NOVA), role: Role::Striker }]
}

const SPLIT: Split = Split { scout: 3000, striker: 7000, verifier: 0 };

/// ANN forms the duo with KIRA and NOVA.
fn formed() -> Crews {
    let mut c = contract();
    as_(ANN, ONE, 0);
    c.form(ID.into(), duo(), SPLIT);
    c
}

/// The factory's answer to `get_mask`, as the callback gets it.
fn owner_says(c: &mut Crews, version: Option<u32>, mask: &str, signer: &str, join: bool, owner: Option<Value>) -> bool {
    let result = PromiseResult::Successful(serde_json::to_vec(&owner).unwrap());
    testing_env!(
        ctx(CONTRACT, 0, 1).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    let view = owner.map(|o| serde_json::from_value::<MaskOwner>(o).unwrap());
    c.on_owner(ID.into(), version, acc(mask), acc(signer), join, Ok(view))
}

fn kira_view(owner: &str) -> Value {
    json!({ "name": "kira", "account": KIRA, "owner": owner, "look": "porcelain", "state": "ready" })
}

#[test]
fn a_captain_forms_a_crew_and_pays_only_its_storage() {
    let mut c = contract();
    as_(ANN, ONE, 0);
    let before = env::storage_usage();
    let v = c.form(ID.into(), duo(), SPLIT);
    let used = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage() - before);
    let seats = env::storage_byte_cost().as_yoctonear() * u128::from(2 * SEAT_BYTES);
    assert_eq!(transfers(), vec![(ANN.to_string(), ONE - used - seats)]);
    assert_eq!(v.version, 1);
    assert!(!v.ready);
    assert!(v.seats.iter().all(|s| !s.joined), "nothing binds a mask until it joins");
    assert!(c.crews_of(acc(NOVA)).is_empty(), "a mask is in a crew once it joins");
    as_(NOVA, 0, 1);
    c.join(ID.into(), 1);
    assert_eq!(c.crews_of(acc(NOVA))[0].id, ID);
    as_(ANN, 0, 0);
    assert!(panics(|| c.form("trio".into(), duo(), SPLIT)).contains("attach"));
}

#[test]
fn a_crew_is_two_to_eight_masks_with_a_split_that_pays_every_role_it_has() {
    let mut c = contract();
    as_(ANN, ONE, 0);
    let m = |s: &str, r: Role| Member { mask: acc(s), role: r };
    let cases: Vec<(&str, Vec<Member>, Split, &str)> = vec![
        ("Duo", duo(), SPLIT, "id: 3 to 32"),
        ("solo", vec![m(NOVA, Role::Striker)], Split { scout: 0, striker: 10_000, verifier: 0 }, "2 to 8 masks"),
        ("twins", vec![m(NOVA, Role::Striker), m(NOVA, Role::Scout)], SPLIT, "no repeats"),
        ("greedy", duo(), Split { scout: 0, striker: 10_000, verifier: 0 }, "none for an empty role"),
        ("ghost", duo(), Split { scout: 2000, striker: 7000, verifier: 1000 }, "none for an empty role"),
        ("short", duo(), Split { scout: 2000, striker: 7000, verifier: 0 }, "summing to 10000"),
        (
            "nostrike",
            vec![m(NOVA, Role::Scout), m(KIRA, Role::Verifier)],
            Split { scout: 5000, striker: 0, verifier: 5000 },
            "a striker",
        ),
    ];
    for (id, members, split, want) in cases {
        let got = panics(|| c.form(id.into(), members, split));
        assert!(got.contains(want), "{id}: want {want:?}, got {got:?}");
    }
    let nine: Vec<Member> = (0..9).map(|i| m(&format!("m{i}.testnet"), Role::Striker)).collect();
    let got = panics(|| c.form("nine".into(), nine, Split { scout: 0, striker: 10_000, verifier: 0 }));
    assert!(got.contains("2 to 8 masks"), "{got}");
    c.form(ID.into(), duo(), SPLIT);
    assert_eq!(panics(|| c.form(ID.into(), duo(), SPLIT)), "this crew id is taken");
}

#[test]
fn a_mask_joins_one_exact_version_of_its_crew() {
    let mut c = formed();
    as_("stranger.testnet", 0, 1);
    assert_eq!(panics(|| c.join(ID.into(), 1)), "no seat for this mask");
    as_(NOVA, 0, 1);
    assert_eq!(panics(|| c.join(ID.into(), 2)), "the crew changed: join its current version");
    let v = c.join(ID.into(), 1);
    assert!(v.seats.iter().find(|s| s.mask == acc(NOVA)).unwrap().joined);
    assert_eq!(panics(|| c.join(ID.into(), 1)), "already joined");
    // The captain changes the split: a new version, and NOVA's yes no longer counts.
    as_(ANN, ONE, 2);
    let v = c.reform(ID.into(), duo(), Split { scout: 1000, striker: 9000, verifier: 0 });
    assert_eq!(v.version, 2);
    assert!(v.seats.iter().all(|s| !s.joined));
    as_(NOVA, 0, 3);
    assert_eq!(panics(|| c.join(ID.into(), 1)), "the crew changed: join its current version");
    c.join(ID.into(), 2);
    // Leaving undoes it.
    let v = c.leave(ID.into());
    assert!(!v.seats.iter().find(|s| s.mask == acc(NOVA)).unwrap().joined);
    assert_eq!(panics(|| c.leave(ID.into())), "not joined");
}

#[test]
fn a_captain_who_is_a_member_has_joined_by_forming() {
    let mut c = contract();
    as_(NOVA, ONE, 0);
    let v = c.form(ID.into(), duo(), SPLIT);
    assert!(v.seats.iter().find(|s| s.mask == acc(NOVA)).unwrap().joined);
    assert!(!v.seats.iter().find(|s| s.mask == acc(KIRA)).unwrap().joined);
}

#[test]
fn the_owner_of_a_forged_mask_joins_for_it_on_the_factory_s_word() {
    let mut c = formed();
    // Only masks of a factory the contract knows, by their `<name>.<factory>`.
    as_(ANN, 0, 1);
    assert_eq!(
        panics(|| c.join_for(ID.into(), 1, acc("kira.fake.testnet"))),
        "no seat for this mask",
        "a mask with no seat"
    );
    assert_eq!(
        panics(|| c.join_for(ID.into(), 1, acc(NOVA))),
        "this mask's factory is not one the crews contract knows"
    );
    let _ = c.join_for(ID.into(), 1, acc(KIRA));
    let asked = calls();
    assert_eq!((asked[0].0.as_str(), asked[0].1.as_str()), (FACTORY, "get_mask"));
    assert_eq!(asked[0].2, json!({ "name": "kira" }));
    // Someone else says they own KIRA: the factory says ANN does.
    assert!(!owner_says(&mut c, Some(1), KIRA, "bob.testnet", true, Some(kira_view(ANN))));
    assert!(get_logs().iter().any(|l| l.contains("does not own")), "{:?}", get_logs());
    // The factory knows no such mask, or answers for another one.
    assert!(!owner_says(&mut c, Some(1), KIRA, ANN, true, None));
    let lena = json!({ "account": LENA, "owner": ANN });
    assert!(!owner_says(&mut c, Some(1), KIRA, ANN, true, Some(lena)));
    assert!(!c.get_crew(ID.into()).unwrap().seats[0].joined);
    // The crew changed while the factory answered.
    as_(ANN, ONE, 2);
    c.reform(ID.into(), duo(), Split { scout: 2000, striker: 8000, verifier: 0 });
    assert!(!owner_says(&mut c, Some(1), KIRA, ANN, true, Some(kira_view(ANN))));
    // The owner, on the current version.
    assert!(owner_says(&mut c, Some(2), KIRA, ANN, true, Some(kira_view(ANN))));
    assert!(c.get_crew(ID.into()).unwrap().seats[0].joined);
    // And leaves for it the same way.
    assert!(owner_says(&mut c, None, KIRA, ANN, false, Some(kira_view(ANN))));
    assert!(!c.get_crew(ID.into()).unwrap().seats[0].joined);
}

#[test]
fn only_the_captain_enlists_and_only_once_every_mask_joined() {
    let mut c = formed();
    as_(NOVA, 0, 1);
    c.join(ID.into(), 1);
    assert_eq!(panics(|| c.enlist(ID.into(), acc(JOBS), "job-1".into())), "only the crew's captain");
    as_(ANN, 0, 1);
    assert_eq!(
        panics(|| c.enlist(ID.into(), acc(JOBS), "job-1".into())),
        "every mask joins this version of the crew first"
    );
    owner_says(&mut c, Some(1), KIRA, ANN, true, Some(kira_view(ANN)));
    as_(ANN, 0, 2);
    let _ = c.enlist(ID.into(), acc(JOBS), "job-1".into());
    let sent = calls();
    assert_eq!((sent[0].0.as_str(), sent[0].1.as_str()), (JOBS, "enlist_crew"));
    assert_eq!(
        sent[0].2,
        json!({ "id": "job-1", "ticket": {
            "crew": ID, "version": 1,
            "members": [{ "mask": KIRA, "role": "scout" }, { "mask": NOVA, "role": "striker" }],
            "split": { "scout": 3000, "striker": 7000, "verifier": 0 },
        }})
    );
    // The job took it.
    testing_env!(
        ctx(CONTRACT, 0, 3).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(b"0".to_vec())]
    );
    assert_eq!(c.on_enlisted(ID.into(), 1, acc(JOBS), "job-1".into(), Ok(0)), Some(0));
    assert_eq!(c.get_crew(ID.into()).unwrap().jobs, 1);
    assert_eq!(c.on_enlisted(ID.into(), 1, acc(JOBS), "job-2".into(), Err(PromiseError::Failed)), None);
    assert_eq!(c.get_crew(ID.into()).unwrap().jobs, 1);
}

#[test]
fn a_reform_unjoins_every_seat_and_a_disband_gives_everything_back() {
    let mut c = contract();
    as_(ANN, ONE, 0);
    c.form(ID.into(), duo(), SPLIT);
    let paid = ONE - transfers()[0].1;
    let mut c = persist(c);
    as_(NOVA, 0, 1);
    c.join(ID.into(), 1);
    let mut c = persist(c);
    assert_eq!(c.crews_of(acc(NOVA))[0].id, ID);
    // A crew of three with LENA instead of KIRA: one more seat to set aside for.
    as_(ANN, ONE, 1);
    let m = |s: &str, r: Role| Member { mask: acc(s), role: r };
    let trio = vec![m(LENA, Role::Scout), m(NOVA, Role::Striker), m(KIRA, Role::Verifier)];
    c.reform(ID.into(), trio, Split { scout: 2000, striker: 7000, verifier: 1000 });
    let paid = paid + ONE - transfers()[0].1;
    let mut c = persist(c);
    assert!(c.crews_of(acc(NOVA)).is_empty(), "NOVA's yes was for the old version");
    as_(NOVA, 0, 2);
    assert_eq!(panics(|| c.disband(ID.into())), "only the crew's captain");
    c.join(ID.into(), 2);
    let mut c = persist(c);
    as_(ANN, 0, 2);
    c.disband(ID.into());
    // Everything ANN paid comes back: the record, the seats' reserve.
    assert_eq!(transfers(), vec![(ANN.to_string(), paid)]);
    assert!(c.get_crew(ID.into()).is_none());
    assert!(c.crews_of(acc(NOVA)).is_empty());
    assert!(c.list_crews(None, None).is_empty());
}

/// The captain, a member itself, reforms the same crew again and again, every mask joined between: each round
/// costs it the same, and a disband gives back exactly what it paid. The masks' lists never pay out twice.
#[test]
fn reforming_and_disbanding_never_pays_the_masks_lists_back_twice() {
    let mut c = contract();
    let m = |s: &str, r: Role| Member { mask: acc(s), role: r };
    let crew: Vec<Member> = (0..8)
        .map(|i| m(&format!("{}{i}.testnet", "m".repeat(64 - 9)), if i == 0 { Role::Striker } else { Role::Scout }))
        .collect();
    let captain = crew[0].mask.to_string();
    let split = Split { scout: 3000, striker: 7000, verifier: 0 };
    as_(&captain, ONE, 0);
    c.form(ID.into(), crew.clone(), split);
    let mut paid = ONE - transfers()[0].1;
    let mut c = persist(c);
    for round in 1..=3 {
        for s in &crew[1..] {
            as_(s.mask.as_str(), 0, 1);
            c.join(ID.into(), round);
        }
        c = persist(c);
        as_(&captain, ONE, 2);
        c.reform(ID.into(), crew.clone(), split);
        let back = transfers()[0].1;
        assert_eq!(back, ONE, "round {round}: a reform of the same crew costs nothing and pays nothing");
        paid += ONE - back;
        c = persist(c);
    }
    for s in &crew[1..] {
        as_(s.mask.as_str(), 0, 3);
        c.join(ID.into(), 4);
    }
    let mut c = persist(c);
    as_(&captain, 0, 4);
    c.disband(ID.into());
    assert_eq!(transfers(), vec![(captain.clone(), paid)], "the captain gets back exactly what it paid");
}

/// Listing a mask binds it to nothing: a stranger who lists NOVA in twenty crews takes none of its sixteen.
#[test]
fn nobody_fills_another_mask_s_crews() {
    let mut c = contract();
    let m = |s: &str, r: Role| Member { mask: acc(s), role: r };
    for i in 0..20 {
        as_("bob.testnet", ONE, 0);
        c.form(format!("bob-{i}"), vec![m(&format!("x{i}.testnet"), Role::Scout), m(NOVA, Role::Striker)], SPLIT);
    }
    assert!(c.crews_of(acc(NOVA)).is_empty());
    as_(ANN, ONE, 0);
    c.form(ID.into(), duo(), SPLIT);
    as_(NOVA, 0, 1);
    c.join(ID.into(), 1);
    assert_eq!(c.crews_of(acc(NOVA)).len(), 1);
    // NOVA itself joins at most sixteen at once.
    for i in 0..15 {
        c.join(format!("bob-{i}"), 1);
    }
    assert_eq!(panics(|| c.join("bob-15".into(), 1)), "a mask joins at most 16 crews at once");
    c.leave("bob-0".into());
    c.join("bob-15".into(), 1);
}

#[test]
fn new_code_waits_as_long_as_on_the_jobs_contract_and_no_crew_enlists_meanwhile() {
    let mut c = contract();
    as_(ADMIN, 0, 0);
    let p = c.propose(Change::Code { sha256: "a".repeat(64) });
    assert_eq!(p.ready_ns.0, CHANGE_NOTICE_HOURS * HOUR);
    c.cancel_change();
    as_(ANN, ONE, 0);
    c.form(ID.into(), duo(), SPLIT);
    as_(ADMIN, 0, 0);
    let p = c.propose(Change::Code { sha256: "a".repeat(64) });
    assert_eq!(p.ready_ns.0, CHANGE_DELAY_HOURS * HOUR);
    assert_eq!(CHANGE_DELAY_HOURS, 168, "as long as new code waits on the jobs contract");
    // No crew enlists while new code waits.
    as_(NOVA, 0, 0);
    c.join(ID.into(), 1);
    owner_says(&mut c, Some(1), KIRA, ANN, true, Some(kira_view(ANN)));
    as_(ANN, 0, 0);
    assert_eq!(
        panics(|| c.enlist(ID.into(), acc(JOBS), "job-1".into())),
        "new code is waiting to apply: no crew enlists until it has"
    );
    as_(ADMIN, 0, 0);
    assert_eq!(
        panics(|| c.propose(Change::Factories { accounts: vec![] })),
        "a change is already pending: cancel it first"
    );
    as_("anyone.testnet", 0, CHANGE_DELAY_HOURS * HOUR - 1);
    assert_eq!(panics(|| c.upgrade()), "the change is still waiting");
    as_("anyone.testnet", 0, (CHANGE_DELAY_HOURS + CHANGE_LAPSE_HOURS) * HOUR);
    assert_eq!(panics(|| c.upgrade()), "the change lapsed: the admin proposes it again");
    // Factories wait an hour.
    as_(ADMIN, 0, (CHANGE_DELAY_HOURS + CHANGE_LAPSE_HOURS) * HOUR);
    c.propose(Change::Factories { accounts: vec![acc(FACTORY), acc("masks2.maskwars.testnet")] });
    as_("anyone.testnet", 0, (CHANGE_DELAY_HOURS + CHANGE_LAPSE_HOURS + 1) * HOUR);
    assert_eq!(c.apply().factories.len(), 2);
    as_(ANN, 0, 0);
    assert_eq!(panics(|| c.propose(Change::Admin { account: acc(ANN) })), "only the admin proposes changes");
}
