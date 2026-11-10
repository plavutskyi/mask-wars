//! The security review of the mask factory, as attacks in a real local sandbox. On the first code each attack goes
//! through; on this code each one is refused. The last test upgrades a factory with a mask in it from the first code
//! to this one.

use masks_sandbox::{build, sha256_hex, why, Wasm, World, MILLI, MIND_SEED, ONE_NEAR};
use near_workspaces::operations::Function;
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

/// What NEAR burns to publish the mask code as a global contract: 0.0001 NEAR a byte.
fn publish_price() -> u128 {
    wasm().mask.len() as u128 * 100_000_000_000_000_000_000
}

/// The same contract with one more custom section: valid wasm that behaves the same, under another hash.
fn new_code(code: &[u8]) -> Vec<u8> {
    let mut c = code.to_vec();
    c.extend_from_slice(&[0x00, 0x07, 0x04, b'n', b'e', b'x', b't', b'v', b'2']);
    c
}

/// R1. Anyone could publish the mask code again before the first publish came back, and every publish burns about
/// 5 NEAR of the factory's balance, which holds the masks' tanks. One transaction with three publishes burned three
/// times. Now one publish is on its way at a time, and only while the factory's own NEAR covers it.
#[tokio::test]
async fn a_stranger_cannot_burn_the_factory_publishing_the_mask_code_again_and_again() {
    let w = World::deploy(wasm(), &wasm().factory, 60, false).await.unwrap();
    let before = w.balance(&w.factory).await.unwrap();
    let publish = || Function::new("publish_mask_code").args(wasm().mask.clone()).gas(Gas::from_tgas(100));
    let res = w.bob.batch(&w.factory).call(publish()).call(publish()).call(publish()).transact().await.unwrap();
    println!("three publishes in one transaction: {}", if res.is_success() { "went through" } else { "refused" });
    // The honest publish, one call.
    let res = w.bob.call(&w.factory, "publish_mask_code").args(wasm().mask.clone()).gas(Gas::from_tgas(300));
    let res = res.transact().await.unwrap();
    println!("one more publish: {}", if res.is_success() { "went through" } else { "refused" });
    let config = w.view("config", json!({})).await.unwrap();
    assert_eq!(config["mask_code"]["published"], true, "the mask code is published: {config}");

    let burned = before.saturating_sub(w.balance(&w.factory).await.unwrap());
    let price = publish_price();
    println!("the factory burned {burned} yocto, one publish is {price}");
    assert!(burned >= price, "the mask code was published once: {burned}");
    assert!(burned < price + 100 * MILLI, "the factory burned more than one publish: {burned} for a price of {price}");
}

/// R2. With every tank empty the first code let any change apply after one hour, new factory code included, while a
/// prize sat on a mask's account where the factory cannot count it. New factory code can move every mask to code of
/// its choosing (`use_code`), so one hour was all an owner had. Now, once a mask exists, every change waits 72 hours.
#[tokio::test]
async fn new_factory_code_waits_three_days_while_a_prize_sits_on_a_mask() {
    let w = World::new(wasm(), 60).await.unwrap();
    let kira = w.mask_id("kira");
    assert!(w.forge(&w.ann, "kira", ONE_NEAR, None).await.unwrap().is_success());
    let res = w.ann.call(&w.factory, "unfuel").args_json(json!({ "name": "kira" })).transact().await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
    let paid = w.arena.call(w.arena.id(), "pay").args_json(json!({ "to": kira })).deposit(NearToken::from_near(5));
    assert!(paid.transact().await.unwrap().is_success());
    let config = w.view("config", json!({})).await.unwrap();
    assert_eq!((u128_of(&config["total_brain"]), u128_of(&config["total_held"])), (0, 0), "every tank is empty");
    assert!(w.balance(&kira).await.unwrap() > 5 * ONE_NEAR, "KIRA holds ANN's prize");

    let code = new_code(&wasm().factory);
    let res = w
        .admin
        .call(&w.factory, "propose")
        .args_json(json!({ "change": { "kind": "code", "sha256": sha256_hex(&code) } }))
        .transact()
        .await
        .unwrap();
    assert!(res.is_success(), "{}", why(&res));
    let notice: u64 = w.view("pending", json!({})).await.unwrap()["notice_ns"].as_str().unwrap().parse().unwrap();
    w.wait_until(notice).await.unwrap();

    let res = w.bob.call(&w.factory, "upgrade").args(code).gas(Gas::from_tgas(300)).transact().await.unwrap();
    assert!(
        why(&res).contains("the change is still waiting"),
        "new factory code an hour after it was proposed, with ANN's prize on KIRA: {}",
        if res.is_success() { "deployed".to_string() } else { why(&res) }
    );
    let on_chain = w.worker.view_code(&w.factory).await.unwrap();
    assert_eq!(sha256_hex(&on_chain), sha256_hex(&wasm().factory), "the factory keeps its code");
}

/// R3. The keeper armed a mask, settled the race as if the mind had spent everything it held, and armed it again,
/// with nothing in between: a stolen keeper key (on testnet the same account as the treasury) emptied every tank in a
/// minute. Now a mask enters one race an hour, and the owner's pause stops the rest.
#[tokio::test]
async fn a_stolen_keeper_key_moves_one_race_an_hour_not_the_whole_tank() {
    let w = World::new(wasm(), 60).await.unwrap();
    assert!(w.forge(&w.ann, "kira", 2 * ONE_NEAR, None).await.unwrap().is_success());
    let held = u128_of(&w.mask("kira").await.unwrap()["race_limit"]);
    let treasury = w.balance(w.treasury.id()).await.unwrap();

    let mut raced = 0;
    for i in 1..=5 {
        let race = format!("race-000{i}");
        let (_, _, res) = w.arm("kira", &race).await.unwrap();
        if !res.is_success() {
            assert!(why(&res).contains("a mask enters one race an hour"), "{}", why(&res));
            continue;
        }
        let res = w.settle("kira", &race, held).await.unwrap();
        assert!(res.is_success(), "{}", why(&res));
        raced += 1;
    }
    let taken = w.balance(w.treasury.id()).await.unwrap() - treasury;
    println!("races in a minute: {raced}, the treasury took {taken}");
    assert_eq!(raced, 1, "the keeper raced KIRA {raced} times in a minute and took {taken} from the tank");
    assert_eq!(taken, held);

    // ANN pauses KIRA: no more races at all, and she takes the rest of the tank.
    let res = w
        .ann
        .call(&w.factory, "pause")
        .args_json(json!({ "name": "kira" }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await
        .unwrap();
    assert!(res.is_success(), "{}", why(&res));
    let (_, _, res) = w.arm("kira", "race-0009").await.unwrap();
    assert!(why(&res).contains("the owner paused this mask"), "{}", why(&res));
    let res = w.ann.call(&w.factory, "unfuel").args_json(json!({ "name": "kira" })).transact().await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
}

/// R4 (F4). The keeper chose the target of a mask's race key: any contract but the arena, the factory and the masks.
/// The key's gas comes out of the mask's own balance, its prize included, and a share of burned gas goes to the
/// contract it calls. Now the factory asks the arena first: a key goes on only for the safe of an open round in its
/// commit window, with the mask on the round's list, opened by one of the factory's teams. Every other arming gives the
/// hold back and adds no key.
#[tokio::test]
async fn the_keeper_cannot_point_a_mask_s_key_anywhere_but_a_real_round() {
    let w = World::new(wasm(), 60).await.unwrap();
    for name in ["kira", "lena", "mira", "nora", "tara", "vera"] {
        assert!(w.forge(&w.ann, name, 2 * ONE_NEAR, None).await.unwrap().is_success(), "forge {name}");
    }
    w.open_round("race-0001", "kira").await.unwrap();
    let refused = |name: &'static str, why_: &'static str| {
        let w = &w;
        async move {
            let m = w.mask(name).await.unwrap();
            assert_eq!(m["state"], "ready", "{name}: {why_}: {m}");
            assert!(m["race"].is_null(), "{name}: the hold went back: {m}");
            assert!(w.keys(&w.mask_id(name)).await.unwrap().is_empty(), "{name}: {why_}: no key on the mask");
            println!("{name}: refused, {why_}");
        }
    };

    // A contract of the keeper's choosing as the target, on a real round KIRA is in.
    let balance = w.balance(&w.mask_id("kira")).await.unwrap();
    let (_, _, res) = w.arm_on("kira", "race-0001", w.bob.id()).await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
    assert!(format!("{:?}", res.logs()).contains("the target is not the round's safe"), "{:?}", res.logs());
    refused("kira", "the target is not the round's safe").await;
    assert_eq!(w.balance(&w.mask_id("kira")).await.unwrap(), balance, "KIRA burned nothing");

    // A real round on the right safe, but LENA is not on its list.
    let (_, _, res) = w.arm_on("lena", "race-0001", w.safe.id()).await.unwrap();
    assert!(format!("{:?}", res.logs()).contains("the mask is not on the round's list"), "{:?}", res.logs());
    refused("lena", "the mask is not on the round's list").await;

    // A round the arena does not have at all.
    let (_, _, res) = w.arm_on("mira", "race-0404", w.safe.id()).await.unwrap();
    assert!(format!("{:?}", res.logs()).contains("no live race by that id"), "{:?}", res.logs());
    refused("mira", "the arena has no such round").await;

    // The review's F4: anyone may open a round on the arena, with any contract as its safe and any mask on its list.
    // Bob, who holds no part of the arena, opens one with TARA on a "safe" of his own: no team of the factory opened
    // it, so TARA gets no key there and burns none of its gas, and Bob cannot keep it busy outside our rounds.
    w.open_round_as(&w.bob, "race-0666", w.bob.id(), "tara").await.unwrap();
    let balance = w.balance(&w.mask_id("tara")).await.unwrap();
    let (_, _, res) = w.arm_on("tara", "race-0666", w.bob.id()).await.unwrap();
    assert!(
        format!("{:?}", res.logs()).contains("the round was not opened by one of the factory's teams"),
        "{:?}",
        res.logs()
    );
    refused("tara", "the round was not opened by one of the factory's teams").await;
    assert_eq!(w.balance(&w.mask_id("tara")).await.unwrap(), balance, "TARA burned nothing");

    // A round whose commit window closed: a mask armed now could not seal a plan.
    w.admin
        .call(w.arena.id(), "open_round")
        .args_json(json!({ "id": "race-0002", "safe": w.safe.id(), "masks": [w.mask_id("nora")], "commit_minutes": 1 }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let until: u64 = w
        .worker
        .view(w.arena.id(), "get_round")
        .args_json(json!({ "id": "race-0002" }))
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .unwrap()["commit_until"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    w.wait_until(until).await.unwrap();
    let (_, _, res) = w.arm_on("nora", "race-0002", w.safe.id()).await.unwrap();
    assert!(format!("{:?}", res.logs()).contains("the round's commit window is closed"), "{:?}", res.logs());
    refused("nora", "the round's commit window is closed").await;

    // The honest arming: VERA is on the open round's list, the target is its safe. Two keys, exactly these.
    w.open_round("race-0001", "vera").await.unwrap();
    let (arena_key, target_key, res) = w.arm_on("vera", "race-0001", w.safe.id()).await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
    let mut keys: Vec<String> = w.keys(&w.mask_id("vera")).await.unwrap().into_iter().map(|(k, _)| k).collect();
    keys.sort();
    let mut want = vec![arena_key.public_key().to_string(), target_key.public_key().to_string()];
    want.sort();
    assert_eq!(keys, want, "VERA has exactly its two race keys");
    assert_eq!(w.mask("vera").await.unwrap()["state"], "racing");
}

/// The factory as first merged, with a mask that raced, upgrades to this code the only way it can: the admin
/// proposes, the wait passes, anyone calls `upgrade` with the wasm, `migrate` runs in the same batch. Every mask is
/// kept, its sealed strategy still opens for its mind, and the new rules hold from then on.
#[tokio::test]
async fn the_first_factory_upgrades_to_this_code_and_keeps_its_masks() {
    let w = World::deploy(wasm(), &wasm().factory_v1, 60, true).await.unwrap();
    let kira = w.mask_id("kira");
    let line = "Patience first, then the whole safe.";
    assert!(w.forge(&w.ann, "kira", 2 * ONE_NEAR, Some(line)).await.unwrap().is_success());
    let (_, _, res) = w.arm("kira", "race-0001").await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
    assert!(w.settle("kira", "race-0001", 12 * MILLI).await.unwrap().is_success());
    let before = w.mask("kira").await.unwrap();
    // Under the first code an empty tank lets the change apply after the hour's notice.
    let res = w.ann.call(&w.factory, "unfuel").args_json(json!({ "name": "kira" })).transact().await.unwrap();
    assert!(res.is_success(), "{}", why(&res));

    let res = w
        .admin
        .call(&w.factory, "propose")
        .args_json(json!({ "change": { "kind": "code", "sha256": sha256_hex(&wasm().factory) } }))
        .transact()
        .await
        .unwrap();
    assert!(res.is_success(), "{}", why(&res));
    let notice: u64 = w.view("pending", json!({})).await.unwrap()["notice_ns"].as_str().unwrap().parse().unwrap();
    w.wait_until(notice).await.unwrap();
    let res = w.bob.call(&w.factory, "upgrade").args(wasm().factory.clone()).gas(Gas::from_tgas(300));
    let res = res.transact().await.unwrap();
    assert!(res.is_success(), "upgrade: {}", why(&res));
    assert!(res.logs().iter().any(|l| l.contains(r#""event":"migrate""#)), "{:?}", res.logs());
    assert_eq!(sha256_hex(&w.worker.view_code(&w.factory).await.unwrap()), sha256_hex(&wasm().factory));
    assert!(w.keys(&w.factory).await.unwrap().is_empty(), "the factory still holds no key");

    // KIRA is the same mask: owner, races, what its mind spent, its strategy for its mind alone.
    let after = w.mask("kira").await.unwrap();
    for field in ["owner", "account", "look", "model", "style", "strategy", "fuel", "spent", "races", "code"] {
        assert_eq!(after[field], before[field], "{field}");
    }
    assert_eq!(after["state"], "ready");
    let sealed = w.view("get_sealed_strategy", json!({ "name": "kira" })).await.unwrap();
    let mind = maskwars_brain::mind_secret(&MIND_SEED);
    assert_eq!(maskwars_brain::open(&mind, kira.as_str(), sealed["sealed"].as_str().unwrap()).unwrap(), line);
    let config = w.view("config", json!({})).await.unwrap();
    assert_eq!(config["race_gap_minutes"], 60, "{config}");
    assert_eq!(config["masks"], 1);

    // The new rules from here on: ANN refuels, KIRA races once, and not again within the hour.
    let res = w.ann.call(&w.factory, "refuel").args_json(json!({ "name": "kira" })).deposit(NearToken::from_near(1));
    assert!(res.transact().await.unwrap().is_success());
    let (_, _, res) = w.arm("kira", "race-0002").await.unwrap();
    assert!(res.is_success(), "{}", why(&res));
    assert_eq!(w.keys(&kira).await.unwrap().len(), 2);
    assert!(w.settle("kira", "race-0002", 0).await.unwrap().is_success());
    assert!(w.keys(&kira).await.unwrap().is_empty());
    let (_, _, res) = w.arm("kira", "race-0003").await.unwrap();
    assert!(why(&res).contains("a mask enters one race an hour"), "{}", why(&res));
}
