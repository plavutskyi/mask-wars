//! Every training target in a real local sandbox: the right plan drains the vault, a wrong one
//! does not, and the vault never counts as breached unless the attacker kept the money.

use race_runner::{build_targets, run_attempt, wasm_dir, Challenge, Plan, Verdict};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Once;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn setup(id: &str) -> (Challenge, Vec<u8>) {
    setup_variant(id, None)
}

/// The target as one of its kinds: `challenge.<variant>.json` beside its `challenge.json`.
fn setup_variant(id: &str, variant: Option<&str>) -> (Challenge, Vec<u8>) {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| build_targets().expect("build wasm"));
    let challenge = Challenge::load_variant(root().join(id), variant).unwrap();
    let wasm = std::fs::read(wasm_dir().join(&challenge.manifest.wasm)).unwrap();
    (challenge, wasm)
}

fn plan(name: &str) -> Plan {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/plans").join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

async fn check(id: &str) {
    check_as(id, None).await;
}

/// The right plan drains the target of this kind, a wrong one takes nothing.
async fn check_as(id: &str, variant: Option<&str>) {
    let (challenge, wasm) = setup_variant(id, variant);
    let id = &variant.map_or(id.to_string(), |v| format!("{id}.{v}"));

    let win = run_attempt(&challenge, &wasm, &plan(&format!("{id}.breach.json"))).await;
    assert_eq!(win.verdict, Verdict::Breach, "{id} right plan: {win:#?}");
    let stolen: u128 = win.stolen.parse().unwrap();
    assert!(stolen >= 10u128.pow(24), "{id}: stolen {stolen}");
    let gain = win.attacker_after.parse::<u128>().unwrap() - win.attacker_before.parse::<u128>().unwrap();
    assert!(gain + 10u128.pow(23) >= stolen, "{id}: attacker kept the loot");

    let miss = run_attempt(&challenge, &wasm, &plan(&format!("{id}.miss.json"))).await;
    assert_eq!(miss.verdict, Verdict::Held, "{id} wrong plan: {miss:#?}");
    assert_eq!(miss.stolen, "0", "{id}: vault must not lose anything");
}

#[tokio::test]
async fn open_admin() {
    check("open-admin").await;
}

#[tokio::test]
async fn over_withdraw() {
    check("over-withdraw").await;
}

#[tokio::test]
async fn proof_replay() {
    check("proof-replay").await;
}

#[tokio::test]
async fn live_safe() {
    check("live-safe").await;
}

// Arena safes: each has the live-round interface of `live-safe` and one planted hole, from level 1 to level 5. The
// right plan takes the hole; an honest member without it takes nothing.

#[tokio::test]
async fn pause_bypass() {
    check("pause-bypass").await;
}

#[tokio::test]
async fn batch_overflow() {
    check("batch-overflow").await;
}

#[tokio::test]
async fn blind_callback() {
    check("blind-callback").await;
}

#[tokio::test]
async fn fake_oracle() {
    check("fake-oracle").await;
}

#[tokio::test]
async fn relay_trust() {
    check("relay-trust").await;
}

#[tokio::test]
async fn share_rounding() {
    check("share-rounding").await;
}

#[tokio::test]
async fn prefix_clash() {
    check("prefix-clash").await;
}

/// On testnet anyone can call the live safe; only the race's masks get through to the planted hole.
#[tokio::test]
async fn a_stranger_cannot_drain_the_live_safe() {
    let (mut challenge, wasm) = setup("live-safe");
    challenge.manifest.init.args["masks"] = json!(["alice.test.near"]);
    challenge.manifest.init.args["owner"] = json!("alice.test.near");
    let out = run_attempt(&challenge, &wasm, &plan("live-safe.breach.json")).await;
    assert_eq!(out.verdict, Verdict::Held, "{out:#?}");
    assert_eq!(out.stolen, "0");
}

// The live safe's other kinds (`variant` at `new`): the same code, another desk and another planted hole each.

#[tokio::test]
async fn live_safe_of_the_limit_kind() {
    check_as("live-safe", Some("limit")).await;
}

#[tokio::test]
async fn live_safe_of_the_pause_kind() {
    check_as("live-safe", Some("pause")).await;
}

/// The default kind named outright is the same world as `challenge.json`.
#[tokio::test]
async fn the_owner_kind_is_the_live_safe_as_it_was() {
    let (named, _) = setup_variant("live-safe", Some("owner"));
    let (plain, _) = setup("live-safe");
    assert_eq!(serde_json::to_value(&named.manifest).unwrap(), serde_json::to_value(&plain.manifest).unwrap());
    assert!(plain.manifest.init.args.get("variant").is_none(), "the daily round names no kind: {:?}", plain.manifest);
    assert!(Challenge::load_variant(root().join("live-safe"), Some("../x")).is_err());
    assert!(Challenge::load_variant(root().join("live-safe"), Some("vault")).is_err(), "no such kind");
}

/// Each kind's hole is that kind's alone: the plan that drains one takes nothing from a safe of another.
#[tokio::test]
async fn a_plan_for_one_kind_takes_nothing_from_another() {
    for (variant, others) in
        [(None, ["limit", "pause"]), (Some("limit"), ["owner", "pause"]), (Some("pause"), ["owner", "limit"])]
    {
        let (challenge, wasm) = setup_variant("live-safe", variant);
        for other in others {
            let name = if other == "owner" {
                "live-safe.breach.json".to_string()
            } else {
                format!("live-safe.{other}.breach.json")
            };
            let out = run_attempt(&challenge, &wasm, &plan(&name)).await;
            assert_eq!(out.verdict, Verdict::Held, "{variant:?} against the plan for {other}: {out:#?}");
            assert_eq!(out.stolen, "0");
            let refused = out.steps.iter().filter(|s| !s.ok).all(|s| {
                s.error.as_deref().is_some_and(|e| e.contains("this safe is of another kind: it has no such desk"))
            });
            assert!(refused, "{variant:?} against the plan for {other}: {out:#?}");
        }
    }
}

/// Whatever its kind, only the masks the safe lets in get to its hole.
#[tokio::test]
async fn a_stranger_cannot_drain_a_live_safe_of_any_kind() {
    for variant in ["limit", "pause"] {
        let (mut challenge, wasm) = setup_variant("live-safe", Some(variant));
        challenge.manifest.init.args["masks"] = json!(["alice.test.near"]);
        let out = run_attempt(&challenge, &wasm, &plan(&format!("live-safe.{variant}.breach.json"))).await;
        assert_eq!(out.verdict, Verdict::Held, "{variant}: {out:#?}");
        assert_eq!(out.stolen, "0");
        let calls: Vec<_> = out.steps.iter().filter(|s| s.error.is_some()).collect();
        assert!(!calls.is_empty(), "{variant}: {out:#?}");
        for s in calls {
            let why = s.error.as_deref().unwrap_or_default();
            assert!(why.contains("this safe is open to the round's masks only"), "{variant} {}: {why}", s.method);
        }
    }
}

/// Draining the vault into someone else's pocket is not the attacker's win.
#[tokio::test]
async fn loot_must_reach_the_attacker() {
    let (challenge, wasm) = setup("open-admin");
    let gift: Plan = serde_json::from_value(json!({ "steps": [
        { "kind": "call", "method": "set_owner", "args": { "new_owner": "attacker.test.near" }, "gas_tgas": 30 },
        { "kind": "call", "method": "sweep", "args": { "to": "bob.test.near", "amount": "50000000000000000000000000" }, "gas_tgas": 30 },
    ]}))
    .unwrap();
    let out = run_attempt(&challenge, &wasm, &gift).await;
    assert_eq!(out.verdict, Verdict::Held, "{out:#?}");
    assert_ne!(out.stolen, "0");
    assert!(out.reason.contains("did not receive"), "{}", out.reason);
}

/// A plan over the step limit never starts a sandbox.
#[tokio::test]
async fn over_limit_plan_is_invalid() {
    let (challenge, wasm) = setup("over-withdraw");
    let step = json!({ "kind": "view", "method": "total_deposits" });
    let long: Plan = serde_json::from_value(json!({ "steps": vec![step; 13] })).unwrap();
    let out = run_attempt(&challenge, &wasm, &long).await;
    assert_eq!(out.verdict, Verdict::Invalid);
    assert!(out.elapsed_ms < 1000);
}

/// The proof in the kit is a real signature by the key the bridge is initialised with.
#[test]
fn proof_kit_is_signed_by_the_bridge_key() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let m = Challenge::load(root().join("proof-replay")).unwrap().manifest;
    let key: [u8; 32] = STANDARD.decode(m.init.args["bridge_key"].as_str().unwrap()).unwrap().try_into().unwrap();
    let p = &m.kit["proof"];
    let sig: [u8; 64] = STANDARD.decode(p["signature"].as_str().unwrap()).unwrap().try_into().unwrap();
    let msg = format!("{}:{}:{}", p["receiver"].as_str().unwrap(), p["amount"].as_str().unwrap(), p["nonce"]);
    VerifyingKey::from_bytes(&key).unwrap().verify(msg.as_bytes(), &Signature::from_bytes(&sig)).unwrap();
}
