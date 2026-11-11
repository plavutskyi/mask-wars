//! View keys on a real local node: a mask's race history, open only to the accounts its owner chose
//! (`factory/src/view.rs`). ANN forges KIRA. BOB registers a view key, the treasury (here: a reader with no view)
//! registers one too. ANN grants BOB a view; the keeper notes a race, sealing its key for BOB, and the factory refuses a
//! key for anyone ANN did not grant or who registered none. ANN takes BOB's view back and gets the storage back; the
//! keeper can seal BOB no race after that. Nothing of it is stored: a note is an event of the keeper's transaction.

use masks_sandbox::{build, why, Wasm, World, MILLI, ONE_NEAR};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};
use std::sync::OnceLock;

fn wasm() -> &'static Wasm {
    static WASM: OnceLock<Wasm> = OnceLock::new();
    WASM.get_or_init(|| build().expect("build wasm"))
}

const BOB_KEY: &str = "x25519:68e394150cea5abe8f973fd2f4805aa66d017449a9b1adeaed404f294532d509";
const OTHER_KEY: &str = "x25519:9118e4a7739b3b2e5a3c35d3b1e5c4d7a1f0e2d3c4b5a69788796a5b4c3d2e1f";

fn sealed(n: usize) -> String {
    format!("v1.{}", "A".repeat(n))
}

/// The `EVENT_JSON` events of a transaction's receipts.
fn events(logs: &[&str]) -> Vec<Value> {
    logs.iter().filter_map(|l| l.strip_prefix("EVENT_JSON:")).map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[tokio::test]
async fn a_mask_s_history_opens_only_for_the_readers_its_owner_chose() {
    let w = World::new(wasm(), 60).await.unwrap();
    let kira = w.mask_id("kira");
    assert!(w.forge(&w.ann, "kira", 2 * ONE_NEAR, None).await.unwrap().is_success());

    // Readers register the keys that sealed histories reach them under: once, for every mask.
    for (who, key) in [(&w.bob, BOB_KEY), (&w.treasury, OTHER_KEY)] {
        let set = who
            .call(&w.factory, "set_view_key")
            .args_json(json!({ "key": key }))
            .deposit(NearToken::from_millinear(10));
        let set = set.transact().await.unwrap();
        assert!(set.is_success(), "set_view_key: {}", why(&set));
    }
    let bad = w.bob.call(&w.factory, "set_view_key").args_json(json!({ "key": "ed25519:nope" }));
    assert!(why(&bad.deposit(NearToken::from_millinear(10)).transact().await.unwrap()).contains("x25519"));
    assert_eq!(w.view("view_key_of", json!({ "account_id": w.bob.id() })).await.ok(), None, "the view takes `account`");
    assert_eq!(w.view("view_key_of", json!({ "account": w.bob.id() })).await.unwrap(), json!(BOB_KEY));

    // Only ANN grants a view of KIRA, and a grant pays its own storage: the rest of the deposit comes back.
    let stranger = w.bob.call(&w.factory, "grant_view").args_json(json!({ "name": "kira", "viewer": w.bob.id() }));
    assert!(why(&stranger.deposit(NearToken::from_millinear(10)).transact().await.unwrap())
        .contains("only the mask's owner"));
    let ann_before = w.balance(w.ann.id()).await.unwrap();
    let grant = w.ann.call(&w.factory, "grant_view").args_json(json!({ "name": "kira", "viewer": w.bob.id() }));
    let grant = grant.deposit(NearToken::from_near(1)).transact().await.unwrap();
    assert!(grant.is_success(), "grant_view: {}", why(&grant));
    assert!(ann_before - w.balance(w.ann.id()).await.unwrap() < 5 * MILLI, "the deposit came back but the storage");
    assert_eq!(
        w.view("viewers", json!({ "name": "kira" })).await.unwrap(),
        json!([{ "account": w.bob.id(), "key": BOB_KEY }])
    );

    // The keeper notes a race: the key of that race goes to BOB. Not to the treasury, which has a key and no view; not
    // to an account with no key; and only the keeper notes.
    let note = |keys: Value| json!({ "name": "kira", "race": "human-0001", "note": sealed(400), "keys": keys });
    let wrap = |to: &str| json!({ "to": to, "key": sealed(100) });
    let by_ann = w.ann.call(&w.factory, "note").args_json(note(json!([]))).transact().await.unwrap();
    assert!(why(&by_ann).contains("only the keeper"), "{}", why(&by_ann));
    let to_reader_without_view =
        w.keeper.call(&w.factory, "note").args_json(note(json!([wrap(w.treasury.id().as_str())])));
    let refused = to_reader_without_view.transact().await.unwrap();
    assert!(why(&refused).contains("only to an account the owner granted"), "{}", why(&refused));
    let storage = w.worker.view_account(&w.factory).await.unwrap().storage_usage;
    let noted =
        w.keeper.call(&w.factory, "note").args_json(note(json!([wrap(w.bob.id().as_str())]))).transact().await.unwrap();
    assert!(noted.is_success(), "note: {}", why(&noted));
    assert_eq!(w.worker.view_account(&w.factory).await.unwrap().storage_usage, storage, "a note stores nothing");
    let logs = noted.logs();
    let e = events(&logs).into_iter().find(|e| e["event"] == "note").expect("a note event");
    assert_eq!(
        e["data"],
        json!({ "name": "kira", "account": kira, "race": "human-0001", "note": sealed(400),
                "keys": [{ "to": w.bob.id(), "key": sealed(100) }] })
    );

    // A share hands BOB the keys of earlier races, again only while he holds a view.
    let share =
        w.keeper.call(&w.factory, "share").args_json(json!({ "name": "kira", "to": w.bob.id(), "keys": sealed(300) }));
    assert!(share.transact().await.unwrap().is_success());

    // ANN takes BOB's view back: the storage comes back to ANN, and the keeper can seal BOB no race after it.
    let ann_before = w.balance(w.ann.id()).await.unwrap();
    let revoke = w.ann.call(&w.factory, "revoke_view").args_json(json!({ "name": "kira", "viewer": w.bob.id() }));
    let no_yocto = w.ann.call(&w.factory, "revoke_view").args_json(json!({ "name": "kira", "viewer": w.bob.id() }));
    assert!(why(&no_yocto.transact().await.unwrap()).contains("attach exactly 1 yoctoNEAR"));
    let revoke = revoke.deposit(NearToken::from_yoctonear(1)).transact().await.unwrap();
    assert!(revoke.is_success(), "revoke_view: {}", why(&revoke));
    assert!(w.balance(w.ann.id()).await.unwrap() + 3 * MILLI > ann_before, "the storage came back, less the gas");
    assert_eq!(w.view("viewers", json!({ "name": "kira" })).await.unwrap(), json!([]));
    let after =
        w.keeper.call(&w.factory, "note").args_json(json!({ "name": "kira", "race": "human-0002", "note": sealed(400),
        "keys": [wrap(w.bob.id().as_str())] }));
    let after = after.transact().await.unwrap();
    assert!(why(&after).contains("only to an account the owner granted"), "{}", why(&after));
    let late =
        w.keeper.call(&w.factory, "share").args_json(json!({ "name": "kira", "to": w.bob.id(), "keys": sealed(300) }));
    assert!(why(&late.transact().await.unwrap()).contains("only to an account the owner granted"));
}
