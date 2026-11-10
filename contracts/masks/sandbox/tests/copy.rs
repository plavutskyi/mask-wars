//! Confidential copying on a real local node. Everything on chain is the real code: the factory, the mask code
//! as a global contract, the author's and the copy's own keyless accounts. ANN forges KIRA with a sealed strategy and
//! opens it to copying for 30%. BOB forges NINA as a copy of KIRA: NINA carries no strategy of its own, and its account
//! is told its author so its own code counts and pays the author's share. NINA wins (a prize lands on its account, as
//! a won round's payout does); BOB's withdraw pays KIRA's account its 30% in the same transaction and BOB the rest.
//!
//! Every finding of the security review of this work is replayed here as an attack, and each is refused:
//! 1, 2. nobody reads the author's strategy: there is no view grant to ask for, on the copy or on the author;
//! 3. race gas after the owner's withdraw never burns the author's share;
//! 4. the share the copier agreed to is the share fixed for the copy, or nothing is forged;
//! 6. the forging fund and the owner's top-ups are never shared;
//! 7. a mask forged with the first mask code moves to this code (`an_early_mask_moves_to_this_code`);
//! 8. an author's copies are read from its own list.

use masks_sandbox::{build, why, Wasm, World, MILLI, ONE_NEAR};
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;
use std::sync::OnceLock;

fn wasm() -> &'static Wasm {
    static WASM: OnceLock<Wasm> = OnceLock::new();
    WASM.get_or_init(|| build().expect("build wasm"))
}

#[tokio::test]
async fn a_copy_plays_an_author_s_mask_and_its_own_code_pays_the_author() {
    let w = World::new(wasm(), 60).await.unwrap();
    let kira = w.mask_id("kira");
    let nina = w.mask_id("nina");
    let strategy = "Wait for the window to close, then take the safe in one sweep.";

    // ANN forges KIRA with a sealed strategy and opens it to copying for 10%.
    assert!(w.forge(&w.ann, "kira", 2 * ONE_NEAR, Some(strategy)).await.unwrap().is_success());
    let opened = w.allow_copy(&w.ann, "kira", 1000).await.unwrap();
    assert!(opened.is_success(), "allow_copy: {}", why(&opened));
    let shown = w.mask("kira").await.unwrap();
    assert_eq!((shown["copyable"].as_bool(), shown["author_bps"].as_u64()), (Some(true), Some(1000)));

    // A share above 30% is refused.
    let greedy = w.allow_copy(&w.ann, "kira", 3001).await.unwrap();
    assert!(why(&greedy).contains("at most 30%"), "{}", why(&greedy));

    // Finding 4, the attack: BOB saw 10% and signs; before his forge lands ANN raises the share to 30%. The forge
    // carries the 10% BOB agreed to, so it forges nothing, and BOB keeps his NEAR (less the gas).
    let bob_before = w.balance(w.bob.id()).await.unwrap();
    assert!(w.allow_copy(&w.ann, "kira", 3000).await.unwrap().is_success());
    let switched = w.forge_copy(&w.bob, "nina", "kira", 1000, 2 * ONE_NEAR).await.unwrap();
    assert!(
        why(&switched).contains("the author's share changed: you agreed to 1000 bps, it is now 3000 bps"),
        "{}",
        why(&switched)
    );
    assert!(w.mask("nina").await.unwrap().is_null(), "no copy on terms BOB never saw");
    assert!(bob_before - w.balance(w.bob.id()).await.unwrap() < 5 * MILLI, "BOB's 2 NEAR came back");

    // BOB looks again, sees 30% and forges NINA as a copy of KIRA on those terms.
    let made = w.forge_copy(&w.bob, "nina", "kira", 3000, 2 * ONE_NEAR).await.unwrap();
    assert!(made.is_success(), "forge the copy: {}", why(&made));
    let copy = w.mask("nina").await.unwrap();
    assert_eq!(
        (copy["copy_of"].as_str(), copy["copy_bps"].as_u64(), copy["strategy"].as_bool(), copy["owner"].as_str()),
        (Some("kira"), Some(3000), Some(false), Some(w.bob.id().as_str()))
    );
    assert_eq!(w.mask("kira").await.unwrap()["copies"].as_u64(), Some(1), "KIRA counts its copy");

    // Finding 8: KIRA's copies come from KIRA's own list, page by page.
    let kids = w.view("copies_of", json!({ "name": "kira" })).await.unwrap();
    assert_eq!((kids[0]["name"].as_str(), kids[0]["bps"].as_u64()), (Some("nina"), Some(3000)));
    assert_eq!(w.view("copies_of", json!({ "name": "kira", "from_index": 1 })).await.unwrap(), json!([]));

    // Findings 1 and 2, the attack: BOB grants a view of his copy to an account of his own, to have the mind seal
    // KIRA's line for it. There is no such call: not on the copy, not on the author, for nobody.
    for (who, name) in [(&w.bob, "nina"), (&w.ann, "kira")] {
        let grant = who
            .call(&w.factory, "grant_view")
            .args_json(json!({ "name": name, "viewer": w.bob.id(), "key": format!("x25519:{}", "0".repeat(64)) }))
            .deposit(NearToken::from_millinear(100))
            .transact()
            .await
            .unwrap();
        assert!(why(&grant).contains("MethodNotFound"), "{name}: {}", why(&grant));
    }
    // And nothing on chain holds the line for NINA's owner to read: NINA has no box, the factory's state never holds
    // the line in the clear, and KIRA's box opens only inside the mind's TEE (the mind's tests).
    assert!(w.view("get_sealed_strategy", json!({ "name": "nina" })).await.unwrap().is_null(), "a copy keeps no box");
    let state = w.worker.view_state(&w.factory).await.unwrap();
    assert!(
        state.values().all(|v| !String::from_utf8_lossy(v).contains("take the safe")),
        "the factory's state never holds the author's line in the clear"
    );

    // Finding 6, the attack: NINA was forged with 0.3 NEAR, above its keep. In the code under review 30% of what
    // stood above the keep was the author's at once (about 0.014 NEAR of BOB's own forging money). Now none of the
    // fund is winnings: the author is due only the copy's share of NEAR's own gas reward for running NINA's code
    // (30% of the gas burnt on a contract goes to it), a few millionths. BOB's top-up is his own too.
    let fresh = w.copy_terms(&nina).await.unwrap().expect("NINA is a copy");
    assert_eq!((fresh.author.as_str(), fresh.bps, fresh.paid, fresh.owed), (kira.as_str(), 3000, 0, 0));
    let above_keep = fresh.owner + fresh.due;
    println!("NINA forged: {above_keep} above its keep, the author due {} (was 30% of it)", fresh.due);
    assert!(above_keep > 10 * MILLI && fresh.due < MILLI / 10, "the fund is not shared: {fresh:?}");
    let topped =
        w.bob.call(&nina, "top_up").deposit(NearToken::from_near(1)).gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(topped.is_success(), "top_up: {}", why(&topped));
    let topped = w.copy_terms(&nina).await.unwrap().unwrap();
    assert!(topped.due < MILLI / 10 && topped.owner > ONE_NEAR, "a top-up is not winnings: {topped:?}");

    // NINA wins: the race's safe pays 1 NEAR onto its account, as a won round does.
    let prize = ONE_NEAR;
    let paid = w.safe.call(w.safe.id(), "pay").args_json(json!({ "to": nina })).deposit(NearToken::from_near(1));
    assert!(paid.transact().await.unwrap().is_success());
    let won = w.copy_terms(&nina).await.unwrap().unwrap();
    assert!(won.due.abs_diff(prize * 3 / 10) < MILLI, "the author is due 30% of the prize: {won:?}");

    // BOB withdraws: one call pays KIRA's account its 30% and BOB the rest (the prize's 70%, his top-up, the fund).
    let kira_before = w.balance(&kira).await.unwrap();
    let bob_before = w.balance(w.bob.id()).await.unwrap();
    let out = w.bob.call(&nina, "withdraw").gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(out.is_success(), "withdraw: {}", why(&out));
    let to_kira = w.balance(&kira).await.unwrap() - kira_before;
    let to_bob = w.balance(w.bob.id()).await.unwrap() + 3 * MILLI - bob_before;
    assert!(to_kira.abs_diff(prize * 3 / 10) < MILLI, "KIRA's account got 30% of the prize, at once: {to_kira}");
    assert!(to_bob > prize * 7 / 10 + ONE_NEAR, "BOB got the prize's 70% and his top-up back: {to_bob}");
    let after = w.copy_terms(&nina).await.unwrap().unwrap();
    assert_eq!((after.paid, after.owed), (to_kira, 0), "KIRA earned its share: {after:?}");
    assert!(after.due < MILLI / 10, "nothing waits but gas reward dust: {after:?}");

    // Finding 3, the attack: NINA keeps racing after BOB's withdraw and its race keys burn gas from its account. The
    // author's share was already paid, so the gas has nothing of the author's to burn, and what KIRA earned stays.
    let (arena_key, _, armed) = w.arm("nina", "race-0001").await.unwrap();
    assert!(armed.is_success(), "arm: {}", why(&armed));
    let on_arena = w.as_mask("nina", &arena_key);
    for method in ["commit", "reveal", "claim_drain"] {
        let res = on_arena.call(w.arena.id(), method).gas(Gas::from_tgas(200)).transact().await.unwrap();
        assert!(res.is_success(), "{method}: {}", why(&res));
    }
    assert!(w.settle("nina", "race-0001", 0).await.unwrap().is_success());
    let raced = w.copy_terms(&nina).await.unwrap().unwrap();
    assert!(raced.paid + raced.owed >= after.paid, "the gas did not take a yocto of what KIRA earned: {raced:?}");
    assert!(raced.due < MILLI / 10, "and nothing new is due: race gas is never winnings: {raced:?}");

    // BOB cannot withdraw again (the race gas came out of the gas fund), and a stranger cannot withdraw at all.
    let twice = w.bob.call(&nina, "withdraw").gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(why(&twice).contains("nothing above the gas fund"), "{}", why(&twice));
    let stranger = w.ann.call(&nina, "withdraw").gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(why(&stranger).contains("only the mask's owner"), "{}", why(&stranger));

    // A second prize, and this time anyone pays the author first: only KIRA's account, never the caller.
    let paid = w.safe.call(w.safe.id(), "pay").args_json(json!({ "to": nina })).deposit(NearToken::from_near(1));
    assert!(paid.transact().await.unwrap().is_success());
    let kira_before = w.balance(&kira).await.unwrap();
    let ann_before = w.balance(w.ann.id()).await.unwrap();
    let paid = w.ann.call(&nina, "pay_author").gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(paid.is_success(), "pay_author: {}", why(&paid));
    let second = w.balance(&kira).await.unwrap() - kira_before;
    assert!(second.abs_diff(prize * 3 / 10) < MILLI, "KIRA's account got its share: {second}");
    assert!(w.balance(w.ann.id()).await.unwrap() < ann_before, "the caller got nothing, only paid the gas");

    // ANN takes her copy earnings out of her own mask, whenever she likes.
    let ann_before = w.balance(w.ann.id()).await.unwrap();
    let home = w.ann.call(&kira, "withdraw").gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(home.is_success(), "ANN withdraws her mask: {}", why(&home));
    let ann_took = w.balance(w.ann.id()).await.unwrap() + 3 * MILLI - ann_before;
    assert!(ann_took > to_kira + second - 5 * MILLI, "ANN took both shares home: {ann_took}");
    println!("NINA (copy of KIRA): two prizes of {prize}; BOB took {to_bob} on the first, KIRA {to_kira} + {second}");
}

/// Finding 7, the attack: a mask forged on `main` (the first factory and the first mask code: its state holds just the
/// factory and the owner) asks to move to this mask code. In the code under review `migrate` read the state with
/// near-sdk's `state_read`, which panics on the old bytes before the second reading is tried, so the move always failed
/// and the mask stayed on the old code. Now it moves, keeps its owner and its winnings, and runs this code.
#[tokio::test]
async fn an_early_mask_moves_to_this_code() {
    let w = World::deploy_with(wasm(), &wasm().factory_v1, &wasm().mask_v1, 60, true).await.unwrap();
    let kira = w.mask_id("kira");
    assert!(w.forge(&w.ann, "kira", ONE_NEAR, None).await.unwrap().is_success());
    // The first code knows no copies.
    assert!(w.worker.view(&kira, "copy_terms").args(vec![]).await.is_err(), "the first code has no copy_terms");

    // The admin proposes this mask code, the wait passes (skipped in the sandbox; tested in review.rs), it is applied
    // and published, and ANN asks KIRA to move.
    let code = masks_sandbox::sha256_hex(&wasm().mask);
    let res = w
        .admin
        .call(&w.factory, "propose")
        .args_json(json!({ "change": { "kind": "mask_code", "sha256": code } }))
        .transact()
        .await
        .unwrap();
    assert!(res.is_success(), "{}", why(&res));
    w.skip_wait().await.unwrap();
    let applied = w.bob.call(&w.factory, "apply").transact().await.unwrap();
    assert!(applied.is_success(), "apply: {}", why(&applied));
    let res = w
        .bob
        .call(&w.factory, "publish_mask_code")
        .args(wasm().mask.clone())
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
    let failures = why(&res);
    assert_eq!(res.json::<bool>().ok(), Some(true), "the move went through: {failures}");
    assert_eq!(w.mask("kira").await.unwrap()["code"].as_str(), Some(code.as_str()));

    // KIRA runs this code with its state kept: no author, its owner still the only one who withdraws.
    assert_eq!(w.copy_terms(&kira).await.unwrap(), None, "a mask with no author");
    let paid = w.safe.call(w.safe.id(), "pay").args_json(json!({ "to": kira })).deposit(NearToken::from_near(1));
    assert!(paid.transact().await.unwrap().is_success());
    let stranger = w.bob.call(&kira, "withdraw").gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(why(&stranger).contains("only the mask's owner"), "{}", why(&stranger));
    let before = w.balance(w.ann.id()).await.unwrap();
    let out = w.ann.call(&kira, "withdraw").gas(Gas::from_tgas(30)).transact().await.unwrap();
    assert!(out.is_success(), "withdraw: {}", why(&out));
    assert!(w.balance(w.ann.id()).await.unwrap() > before + ONE_NEAR - 5 * MILLI, "ANN took KIRA's prize");
}
