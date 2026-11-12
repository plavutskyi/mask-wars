//! A person forges a mask in a real local sandbox, and the mask lives its life: its own keyless account, race keys
//! that reach only the arena and the race's target, a race that pays for the mind out of the mask's own tank, a prize
//! on the mask's account, and the owner taking it out.

use masks_sandbox::{build, near, why, Wasm, World, MILLI, MIND_SEED, ONE_NEAR};
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;
use std::sync::OnceLock;

fn wasm() -> &'static Wasm {
    static WASM: OnceLock<Wasm> = OnceLock::new();
    WASM.get_or_init(|| build().expect("build wasm"))
}

fn u128_of(v: &serde_json::Value) -> u128 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or_else(|| panic!("not an amount: {v}"))
}

#[tokio::test]
async fn a_person_forges_a_mask_that_races_and_pays_for_its_own_mind() {
    let w = World::new(wasm(), 60).await.unwrap();
    let kira = w.mask_id("kira");

    // The factory itself has no key: nobody deploys to it or moves its NEAR by hand.
    assert!(w.keys(&w.factory).await.unwrap().is_empty(), "the factory holds no key");

    // ANN forges KIRA: a look, a TEE model, a style, a sealed line of strategy and 2 NEAR for its mind.
    let ann_before = w.balance(w.ann.id()).await.unwrap();
    let line = "Wait for the window. Then take it all.";
    let res = w.forge(&w.ann, "kira", 2 * ONE_NEAR, Some(line)).await.unwrap();
    assert!(res.is_success(), "forge: {}", why(&res));
    assert!(res.logs().iter().any(|l| l.contains(r#""event":"forge""#)), "{:?}", res.logs());
    let m = w.mask("kira").await.unwrap();
    assert_eq!(m["state"], "ready", "{m}");
    assert_eq!((m["owner"].as_str(), m["account"].as_str()), (Some(w.ann.id().as_str()), Some(kira.as_str())));
    assert_eq!(
        (m["look"].as_str(), m["model"].as_str(), m["style"].as_str()),
        (Some("porcelain"), Some("Qwen/Qwen3.8-27B"), Some("cunning"))
    );
    assert_eq!(m["strategy"], true);
    assert_eq!(u128_of(&m["fuel"]), 2 * ONE_NEAR);
    let brain = u128_of(&m["brain"]);
    assert!(
        brain > 1_680 * MILLI && brain < 1_700 * MILLI,
        "2 NEAR, less 0.3 for the mask's account and its record: {brain}"
    );
    let paid = ann_before - w.balance(w.ann.id()).await.unwrap();
    assert!(paid > 2 * ONE_NEAR && paid < 2 * ONE_NEAR + 150 * MILLI, "ANN paid the deposit and gas: {paid}");

    // The mask's own account: no key at all, the published mask code, 0.3 NEAR for its storage and gas.
    assert!(w.keys(&kira).await.unwrap().is_empty(), "no key of any kind on a new mask");
    let account = w.worker.view_account(&kira).await.unwrap();
    assert_eq!(
        format!("{:?}", account.contract_state),
        format!("GlobalHash({:?})", near_workspaces::CryptoHash(masks_sandbox_hash(&w.mask_code))),
        "the mask runs the global mask code"
    );
    let fund = account.balance.as_yoctonear();
    assert!(fund > 295 * MILLI && fund <= 300 * MILLI, "{fund}");

    // The strategy is on chain only as a sealed box; inside the TEE the mind opens it, for this mask only.
    let sealed = w.view("get_sealed_strategy", json!({ "name": "kira" })).await.unwrap();
    let mind = maskwars_brain::mind_secret(&MIND_SEED);
    let opened = maskwars_brain::open(&mind, kira.as_str(), sealed["sealed"].as_str().unwrap()).unwrap();
    assert_eq!(opened, line);
    assert!(!m.to_string().contains(line) && !sealed.to_string().contains("take it all"));

    // A name is one mask's; the arena keeps its own; one NEAR is the least. A refused forge costs only gas.
    let bob_before = w.balance(w.bob.id()).await.unwrap();
    for (name, deposit, reason) in [
        ("kira", 2 * ONE_NEAR, "this name is taken"),
        ("nova", 2 * ONE_NEAR, "this name belongs to the arena"),
        ("lena", ONE_NEAR / 2, "forging takes at least 1 NEAR"),
    ] {
        let res = w.forge(&w.bob, name, deposit, None).await.unwrap();
        assert!(why(&res).contains(reason), "{name}: {}", why(&res));
    }
    assert!(bob_before - w.balance(w.bob.id()).await.unwrap() < 10 * MILLI, "BOB got his deposits back");

    // Only the keeper arms a mask.
    let res = w
        .bob
        .call(&w.factory, "arm")
        .args_json(json!({ "name": "kira", "race": "race-0001", "arena_key": w.bob.secret_key().public_key(),
                           "target": w.safe.id(), "target_key": w.ann.secret_key().public_key(),
                           "target_methods": ["set_owner", "sweep"] }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await
        .unwrap();
    assert!(why(&res).contains("only the keeper"), "{}", why(&res));

    // The keeper arms KIRA for race-0001: it holds one race's worth of the tank and gives the mask two race keys.
    let (arena_key, target_key, res) = w.arm("kira", "race-0001").await.unwrap();
    assert!(res.is_success(), "arm: {}", why(&res));
    assert!(res.json::<bool>().unwrap(), "the keys are on the mask");
    let mut keys = w.keys(&kira).await.unwrap();
    keys.sort();
    let mut want = vec![
        (
            arena_key.public_key().to_string(),
            Some((
                w.arena.id().to_string(),
                vec!["commit".into(), "reveal".into(), "claim_drain".into(), "settle".into()],
                Some(400 * MILLI),
            )),
        ),
        (
            target_key.public_key().to_string(),
            Some((w.safe.id().to_string(), vec!["set_owner".into(), "sweep".into()], Some(100 * MILLI))),
        ),
    ];
    want.sort();
    assert_eq!(keys, want, "exactly two function-call keys, and no full-access key");
    let m = w.mask("kira").await.unwrap();
    assert_eq!((m["state"].as_str(), u128_of(&m["race"]["held"])), (Some("racing"), 50 * MILLI));
    assert_eq!(u128_of(&m["brain"]), brain - 50 * MILLI);

    // With its race keys KIRA plays the round: its own name on the arena and on the safe.
    let on_arena = w.as_mask("kira", &arena_key);
    let on_safe = w.as_mask("kira", &target_key);
    for method in ["commit", "reveal"] {
        let res = on_arena.call(w.arena.id(), method).transact().await.unwrap();
        assert!(res.is_success(), "{method}: {}", why(&res));
    }
    for method in ["set_owner", "sweep"] {
        let res = on_safe.call(w.safe.id(), method).transact().await.unwrap();
        assert!(res.is_success(), "{method}: {}", why(&res));
    }
    let k = kira.to_string();
    assert_eq!(
        w.calls(&w.arena).await.unwrap(),
        vec![("commit".into(), k.clone(), k.clone()), ("reveal".into(), k.clone(), k.clone())]
    );
    assert_eq!(w.calls(&w.safe).await.unwrap().len(), 2);

    // What the race keys cannot do: another method, another receiver, attach NEAR, move NEAR, touch the mask itself.
    let refused = [
        on_arena.call(w.arena.id(), "other").transact().await,
        on_arena.call(w.safe.id(), "sweep").transact().await,
        on_safe.call(w.arena.id(), "commit").transact().await,
        on_arena.call(w.arena.id(), "commit").deposit(NearToken::from_yoctonear(1)).transact().await,
        on_arena.call(&kira, "withdraw").transact().await,
    ];
    for (i, r) in refused.into_iter().enumerate() {
        assert!(r.is_err() || r.as_ref().unwrap().is_failure(), "race key call {i} went through");
    }
    assert!(on_arena.transfer_near(w.bob.id(), NearToken::from_near(1)).await.map_or(true, |r| r.is_failure()));
    assert!(on_safe.batch(&kira).delete_key(arena_key.public_key()).transact().await.map_or(true, |r| r.is_failure()));
    assert_eq!(w.calls(&w.arena).await.unwrap().len(), 2, "nothing more reached the arena");

    // KIRA wins: the arena pays the prize to the mask's own account.
    let paid = w
        .arena
        .call(w.arena.id(), "pay")
        .args_json(json!({ "to": kira }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await
        .unwrap();
    assert!(paid.is_success(), "{}", why(&paid));

    // The keeper settles: the mind spent 0.012 NEAR; that goes to the treasury, the rest of the hold back to the tank,
    // and the race keys are gone.
    let treasury_before = w.balance(w.treasury.id()).await.unwrap();
    let res = w
        .keeper
        .call(&w.factory, "settle")
        .args_json(json!({ "name": "kira", "race": "race-0001", "spent": (12 * MILLI).to_string() }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await
        .unwrap();
    assert!(res.is_success(), "settle: {}", why(&res));
    assert_eq!(w.balance(w.treasury.id()).await.unwrap() - treasury_before, 12 * MILLI);
    assert!(w.keys(&kira).await.unwrap().is_empty(), "the race keys are removed after the race");
    let m = w.mask("kira").await.unwrap();
    assert_eq!((m["state"].as_str(), m["races"].as_u64()), (Some("ready"), Some(1)));
    assert_eq!((u128_of(&m["brain"]), u128_of(&m["spent"])), (brain - 12 * MILLI, 12 * MILLI));

    // Only ANN takes the prize out; the gas fund stays so the mask can keep racing.
    let res = w.bob.call(&kira, "withdraw").transact().await.unwrap();
    assert!(why(&res).contains("only the mask's owner withdraws"), "{}", why(&res));
    let (ann_before, kira_before) = (w.balance(w.ann.id()).await.unwrap(), w.balance(&kira).await.unwrap());
    let res = w.ann.call(&kira, "withdraw").gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(res.is_success(), "withdraw: {}", why(&res));
    let line = res.logs().iter().find(|l| l.starts_with("withdraw ")).map(|l| l.to_string()).unwrap();
    let sent: u128 = line.split(' ').nth(1).unwrap().parse().unwrap();
    let left = w.balance(&kira).await.unwrap();
    assert_eq!(kira_before - left, sent, "{line}");
    assert!(sent > 990 * MILLI && sent < 1_050 * MILLI, "the prize and what the mask did not burn on gas: {line}");
    assert!((250 * MILLI..260 * MILLI).contains(&left), "the gas fund and the storage stay: {left}");
    let got = w.balance(w.ann.id()).await.unwrap() - ann_before;
    assert!(got + 50 * MILLI > sent && got <= sent, "ANN got it, less her gas: {got}");

    // A mask enters one race an hour: right after race-0001 the keeper cannot arm KIRA again.
    let (_, _, res) = w.arm("kira", "race-0002").await.unwrap();
    assert!(why(&res).contains("a mask enters one race an hour"), "{}", why(&res));

    // ANN's second mask LENA: she pauses it in the middle of its race. The race keys go at once, and no new race
    // until she resumes.
    let lena = w.mask_id("lena");
    assert!(w.forge(&w.ann, "lena", ONE_NEAR, None).await.unwrap().is_success());
    let (_, _, res) = w.arm("lena", "race-0002").await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
    assert_eq!(w.keys(&lena).await.unwrap().len(), 2);
    let res = w
        .ann
        .call(&w.factory, "pause")
        .args_json(json!({ "name": "lena" }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await
        .unwrap();
    assert!(res.is_success(), "pause: {}", why(&res));
    assert!(w.keys(&lena).await.unwrap().is_empty(), "pausing removes the race keys");
    let res = w.settle("lena", "race-0002", 0).await.unwrap();
    assert!(res.is_success(), "settle a paused race: {}", why(&res));
    let (_, _, res) = w.arm("lena", "race-0003").await.unwrap();
    assert!(why(&res).contains("the owner paused this mask"), "{}", why(&res));
    let res = w.ann.call(&w.factory, "resume").args_json(json!({ "name": "lena" })).transact().await.unwrap();
    assert!(res.is_success(), "{}", why(&res));

    // ANN takes back what is left in the tank; with an empty tank the mask races no more.
    let ann_before = w.balance(w.ann.id()).await.unwrap();
    let res = w.ann.call(&w.factory, "unfuel").args_json(json!({ "name": "kira" })).transact().await.unwrap();
    assert!(res.is_success(), "unfuel: {}", why(&res));
    let event = res.logs().iter().find(|l| l.contains(r#""event":"unfuel""#)).map(|l| l.to_string()).unwrap();
    assert!(event.contains(&format!(r#""amount":"{}""#, brain - 12 * MILLI)), "the whole tank, to the yocto: {event}");
    let back = w.balance(w.ann.id()).await.unwrap().abs_diff(ann_before);
    assert!(back.abs_diff(brain - 12 * MILLI) < 50 * MILLI, "ANN got it back, give or take her gas: {back}");
    assert_eq!(u128_of(&w.mask("kira").await.unwrap()["brain"]), 0);
    let (_, _, res) = w.arm("kira", "race-0003").await.unwrap();
    assert!(why(&res).contains("the mind is out of fuel"), "{}", why(&res));

    // The factory holds every mask's NEAR, and its own storage, at all times.
    let config = w.view("config", json!({})).await.unwrap();
    let owed = u128_of(&config["total_brain"]) + u128_of(&config["total_held"]);
    let account = w.worker.view_account(&w.factory).await.unwrap();
    let storage = u128::from(account.storage_usage) * 10u128.pow(19);
    assert!(account.balance.as_yoctonear() >= storage + owed, "the factory is short of what it owes");
}

#[tokio::test]
async fn a_mask_pays_for_its_own_mind_with_what_it_won() {
    let w = World::new(wasm(), 60).await.unwrap();
    let kira = w.mask_id("kira");
    let res = w.forge(&w.ann, "kira", ONE_NEAR, None).await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
    let before = w.mask("kira").await.unwrap();
    let (brain, fuel) = (u128_of(&before["brain"]), u128_of(&before["fuel"]));

    // KIRA wins: the arena pays 1 NEAR to the mask's own account.
    let paid = w
        .arena
        .call(w.arena.id(), "pay")
        .args_json(json!({ "to": kira }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await
        .unwrap();
    assert!(paid.is_success(), "{}", why(&paid));

    // Only ANN spends the prize, and only on KIRA's own tank.
    let res = w.bob.call(&kira, "fuel").gas(Gas::from_tgas(60)).transact().await.unwrap();
    assert!(why(&res).contains("only the mask's owner fuels its mind"), "{}", why(&res));
    let res =
        w.ann.call(&kira, "fuel").gas(Gas::from_tgas(60)).deposit(NearToken::from_near(1)).transact().await.unwrap();
    assert!(why(&res).contains("fuel takes no deposit"), "{}", why(&res));
    let res = w.ann.call(&kira, "fuel").gas(Gas::from_tgas(60)).transact().await.unwrap();
    assert!(res.is_success(), "fuel: {}", why(&res));
    let line = res.logs().iter().find(|l| l.starts_with("fuel ")).map(|l| l.to_string()).unwrap();
    let sent: u128 = line.split(' ').nth(1).unwrap().parse().unwrap();
    assert!(sent > 990 * MILLI && sent < 1_050 * MILLI, "the prize and what the mask did not burn on gas: {line}");
    assert!(
        res.logs().iter().any(|l| l.contains(r#""event":"refuel""#) && l.contains(kira.as_str())),
        "{:?}",
        res.logs()
    );

    // The tank holds the prize; what people put in stays what it was, so the × is not inflated by recycled winnings.
    let m = w.mask("kira").await.unwrap();
    assert_eq!((u128_of(&m["fuel"]), u128_of(&m["recycled"])), (fuel, sent), "recorded as the mask's own, not put in");
    let record = brain + sent - u128_of(&m["brain"]);
    assert!(record > 0 && record < MILLI, "only the record of `recycled` is paid from it: {record}");
    let left = w.balance(&kira).await.unwrap();
    assert!((250 * MILLI..260 * MILLI).contains(&left), "the gas fund and the storage stay: {left}");

    // Nothing above the gas fund is left to fuel.
    let res = w.ann.call(&kira, "fuel").gas(Gas::from_tgas(60)).transact().await.unwrap();
    assert!(why(&res).contains("less than 0.1 NEAR"), "{}", why(&res));
}

#[tokio::test]
async fn a_race_nobody_settles_is_released_and_costs_the_mind_nothing() {
    let w = World::new(wasm(), 1).await.unwrap();
    let kira = w.mask_id("kira");
    let res = w.forge(&w.ann, "kira", ONE_NEAR, None).await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
    let brain = u128_of(&w.mask("kira").await.unwrap()["brain"]);
    let (_, _, res) = w.arm("kira", "race-0001").await.unwrap();
    assert!(res.is_success(), "{}", why(&res));

    let release = || async {
        w.bob
            .call(&w.factory, "release")
            .args_json(json!({ "name": "kira" }))
            .gas(Gas::from_tgas(60))
            .transact()
            .await
            .unwrap()
    };
    let early = release().await;
    assert!(why(&early).contains("the keeper still has time to settle"), "{}", why(&early));

    // A minute of sandbox time later, anyone releases the hold: the tank is whole again and the keys are gone.
    let armed: u64 = w.mask("kira").await.unwrap()["race"]["armed_ns"].as_str().unwrap().parse().unwrap();
    for _ in 0..200 {
        if w.worker.view_block().await.unwrap().timestamp() >= armed + 60_000_000_000 {
            break;
        }
        w.worker.fast_forward(20).await.unwrap();
    }
    let res = release().await;
    assert!(res.is_success(), "release: {}", why(&res));
    let m = w.mask("kira").await.unwrap();
    assert_eq!((m["state"].as_str(), u128_of(&m["brain"]), u128_of(&m["spent"])), (Some("ready"), brain, 0));
    assert!(w.keys(&kira).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_mask_moves_only_to_code_that_can_migrate_it() {
    let w = World::new(wasm(), 60).await.unwrap();
    let kira = w.mask_id("kira");
    assert!(w.forge(&w.ann, "kira", ONE_NEAR, None).await.unwrap().is_success());

    // The admin proposes the stand-in as the new mask code: it has no `migrate`, so a mask must refuse to move to it.
    // With a mask forged the change waits 72 hours; the sandbox skips the wait (the wait is tested in review.rs).
    let stub = masks_sandbox::sha256_hex(&wasm().stub);
    let res = w
        .admin
        .call(&w.factory, "propose")
        .args_json(json!({ "change": { "kind": "mask_code", "sha256": stub } }))
        .transact()
        .await
        .unwrap();
    assert!(res.is_success(), "{}", why(&res));
    let res = w.bob.call(&w.factory, "apply").transact().await.unwrap();
    assert!(why(&res).contains("the change is still waiting"), "{}", why(&res));
    w.skip_wait().await.unwrap();
    let res = w.bob.call(&w.factory, "apply").transact().await.unwrap();
    assert!(res.is_success(), "apply: {}", why(&res));
    let res = w
        .bob
        .call(&w.factory, "publish_mask_code")
        .args(wasm().stub.clone())
        .gas(Gas::from_tgas(300))
        .transact()
        .await
        .unwrap();
    assert!(res.is_success(), "publish: {}", why(&res));

    let res = w
        .ann
        .call(&w.factory, "renew")
        .args_json(json!({ "name": "kira" }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await
        .unwrap();
    let logs: Vec<String> = res.logs().iter().map(|l| l.to_string()).collect();
    assert_eq!(res.json::<bool>().ok(), Some(false), "the move failed and the factory says so: {logs:?}");
    let account = w.worker.view_account(&kira).await.unwrap();
    assert_eq!(
        format!("{:?}", account.contract_state),
        format!("GlobalHash({:?})", near_workspaces::CryptoHash(masks_sandbox_hash(&w.mask_code))),
        "the mask keeps its code"
    );
    assert_eq!(w.mask("kira").await.unwrap()["code"].as_str(), Some(w.mask_code.as_str()));
    let _ = near(0);
}

fn masks_sandbox_hash(hex: &str) -> [u8; 32] {
    std::array::from_fn(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap())
}
