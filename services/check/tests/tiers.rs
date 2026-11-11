// What a call gets for what it attached: a preview for nothing, the whole answer signed for the price, the preview
// with a note when the payment is short, and the whole answer unsigned when the deployment holds no key. A call that
// attached anything is never refused. The chain is one of the shared vectors: mainnet as it was recorded.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use maskwars_check::{answer, Execution, Output, Run, PRICE_USD_MICRO, RULES, VERSION};
use serde_json::{json, Value};
use std::collections::HashMap;

mod common;
use common::{vector, Replay};

/// RFC 8032's first test seed, standing for the seed OutLayer generates inside the TEE.
const SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const KEY: &str = "ed25519:FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z";

/// A run over HTTPS that attached `attached` for the project.
fn https(attached: u64, seed: Option<&str>, now_ms: i64) -> Run {
    Run { execution: Execution::Https, attached_usd_micro: attached, seed: seed.map(String::from), now_ms }
}

/// A run as OutLayer's worker sets it up: nothing but environment variables.
fn run_of(env: &[(&str, &str)], now_ms: i64) -> Run {
    let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    Run::from_env(|name| env.get(name).cloned(), now_ms)
}

fn ask_as(vector_name: &str, input: Value, run: impl Fn(i64) -> Run) -> (Output, Value) {
    let v = vector(vector_name);
    let replay = Replay::of(&v);
    let out = answer(Some(input), &run(v["now_ms"].as_i64().unwrap()), &replay);
    assert_eq!(replay.unexpected.into_inner(), Vec::<String>::new());
    (out, v)
}

fn ask(vector_name: &str, input: Value, attached: u64, seed: Option<&str>) -> (Output, Value) {
    ask_as(vector_name, input, |now_ms| https(attached, seed, now_ms))
}

/// A call that must be answered without one request to the chain: the replay holds nothing.
fn unread(input: Value, run: &Run) -> Output {
    let v = json!({ "exchanges": [] });
    let replay = Replay::of(&v);
    let out = answer(Some(input), run, &replay);
    assert_eq!(replay.unexpected.into_inner(), Vec::<String>::new(), "the chain was read");
    out
}

const INTENTS: &str = "mainnet, as recorded: intents.near";
const LOOKALIKE: &str = "mainnet, as recorded: treasury.intents.near";
const DRAINED: &str = "testnet, as recorded: safe-0001.tinygif8324.testnet";

fn price() -> Value {
    json!({ "usd": "0.01", "usd_micro": 10_000, "header": "X-Attached-Deposit: 10000", "attached_usd": "10000" })
}

fn module() -> Value {
    json!({ "version": VERSION, "rules": RULES })
}

fn b64(s: &str) -> Vec<u8> {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = vec![];
    for chunk in s.trim_end_matches('=').as_bytes().chunks(4) {
        let n = chunk.iter().fold(0u32, |n, c| n << 6 | A.iter().position(|a| a == c).unwrap() as u32) << (6 * (4 - chunk.len()));
        out.extend(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

fn b58(s: &str) -> Vec<u8> {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out = vec![0u8; 32];
    for c in s.bytes() {
        let mut carry = A.iter().position(|a| *a == c).unwrap() as u32;
        for byte in out.iter_mut().rev() {
            carry += u32::from(*byte) * 58;
            *byte = carry as u8;
            carry >>= 8;
        }
    }
    out
}

#[test]
fn nothing_attached_is_a_preview_the_verdict_without_reasons_or_a_signature() {
    let (out, v) = ask(LOOKALIKE, json!({ "account": "treasury.intents.near" }), 0, Some(SEED));
    assert!(out.success && out.error.is_none());
    assert_eq!(
        out.output,
        json!({
            "tier": "preview",
            "check": { "account": "treasury.intents.near", "network": "mainnet", "verdict": "block", "block": v["expect"]["block"], "checked_at": v["expect"]["checked_at"] },
            "signed": null,
            "module": module(),
            "price": price(),
        })
    );
    let text = out.output.to_string();
    assert!(!text.contains("reasons") && !text.contains("summary") && !text.contains("a payment cannot arrive") && !text.contains("payment"));
}

#[test]
fn a_preview_needs_no_signing_key() {
    let (out, _) = ask(INTENTS, json!({ "account": "intents.near", "network": "mainnet", "signed": false }), 0, None);
    assert_eq!(out.output["check"]["verdict"], "allow");
    assert_eq!(out.output["tier"], "preview");
}

#[test]
fn the_price_buys_the_whole_answer_signed_with_the_projects_key() {
    for (name, account) in [(INTENTS, "intents.near"), (LOOKALIKE, "treasury.intents.near"), (DRAINED, "safe-0001.tinygif8324.testnet")] {
        let (out, v) = ask(name, json!({ "account": account }), PRICE_USD_MICRO, Some(SEED));
        assert!(out.success, "{:?}", out.error);
        assert_eq!(out.output["tier"], "signed");
        // The same answer the TypeScript check gives, field for field.
        assert_eq!(out.output["check"], v["expect"]);
        assert_eq!(out.output["price"], price());
        assert_eq!(out.output["module"], module());
        assert_eq!(out.output["attached_usd_micro"], 10_000);

        let signed = &out.output["signed"];
        assert_eq!((signed["alg"].as_str(), signed["key"].as_str()), (Some("ed25519"), Some(KEY)));
        let message = signed["message"].as_str().unwrap();
        // The message is the answer itself under two fields of its own: the mark, and which rules made it.
        let mut said: Value = serde_json::from_str(message).unwrap();
        assert!(
            message.starts_with(&format!(r#"{{"maskwars_check":2,"module":{{"version":"{VERSION}","rules":"{RULES}"}},"account":""#)),
            "{message}"
        );
        assert_eq!(said.as_object_mut().unwrap().shift_remove("maskwars_check"), Some(json!(2)));
        assert_eq!(said.as_object_mut().unwrap().shift_remove("module"), Some(module()));
        assert_eq!(said, out.output["check"]);

        let key = VerifyingKey::from_bytes(&b58(&KEY["ed25519:".len()..]).try_into().unwrap()).unwrap();
        let signature = Signature::from_slice(&b64(signed["signature"].as_str().unwrap())).unwrap();
        assert!(key.verify(message.as_bytes(), &signature).is_ok());
        assert!(key.verify(message.replace(r#""verdict":"#, r#""Verdict":"#).as_bytes(), &signature).is_err());
        // A signature is for the rules that made it: the same answer under other rules is another message.
        assert!(key.verify(message.replace(RULES, &"0".repeat(64)).as_bytes(), &signature).is_err());
    }
}

#[test]
fn more_than_the_price_buys_the_same() {
    let (out, _) = ask(INTENTS, json!({ "account": "intents.near" }), 25_000, Some(SEED));
    assert_eq!((out.output["tier"].as_str(), out.output["attached_usd_micro"].as_u64()), (Some("signed"), Some(25_000)));
}

#[test]
fn a_signed_verdict_asked_with_nothing_attached_is_refused_before_anything_is_read() {
    let input = || json!({ "account": "intents.near", "signed": true });
    let out = unread(input(), &https(0, Some(SEED), 0));
    assert!(!out.success);
    assert_eq!(
        out.error.as_deref(),
        Some("payment required: a signed verdict costs $0.01, this call attached $0. Set the header X-Attached-Deposit: 10000")
    );
    assert_eq!(
        out.output,
        json!({ "payment": { "required_usd_micro": 10_000, "attached_usd_micro": 0, "header": "X-Attached-Deposit: 10000", "attached_usd": "10000" } })
    );

    // A contract cannot set a header: it is told what it can do.
    let from_chain = unread(input(), &run_of(&[("OUTLAYER_EXECUTION_TYPE", "NEAR"), ("ATTACHED_USD", "0"), ("USD_PAYMENT", "0")], 0));
    let said = from_chain.error.unwrap();
    assert_eq!(
        said,
        r#"payment required: a signed verdict costs $0.01, this call attached $0. From a contract, attach it in request_execution: params.attached_usd "10000""#
    );
    assert!(!said.contains("header") && !said.contains("X-Attached-Deposit"));

    // Outside OutLayer nothing can be attached; the refusal names both ways.
    let nowhere = unread(input(), &run_of(&[], 0));
    assert!(nowhere.error.unwrap().ends_with(
        r#"Over HTTPS set the header X-Attached-Deposit: 10000; from a contract, attach it in request_execution: params.attached_usd "10000""#
    ));
}

#[test]
fn a_short_payment_is_answered_with_the_preview_and_a_note_never_refused() {
    for (attached, said, wants_signed) in [(1, "$0.000001", false), (5_000, "$0.005", true), (9_999, "$0.009999", false), (9_999, "$0.009999", true)]
    {
        let mut input = json!({ "account": "treasury.intents.near" });
        if wants_signed {
            input["signed"] = json!(true);
        }
        let (out, v) = ask(LOOKALIKE, input, attached, Some(SEED));
        assert!(out.success && out.error.is_none(), "{attached}: a call that attached money is answered");
        assert_eq!(
            out.output,
            json!({
                "tier": "preview",
                "check": { "account": "treasury.intents.near", "network": "mainnet", "verdict": "block", "block": v["expect"]["block"], "checked_at": v["expect"]["checked_at"] },
                "signed": null,
                "module": module(),
                "price": price(),
                "payment": {
                    "required_usd_micro": 10_000,
                    "attached_usd_micro": attached,
                    "note": format!("A signed verdict costs $0.01; this call attached {said}, so it is answered as a preview. OutLayer keeps what a call attached; it does not come back. Set the header X-Attached-Deposit: 10000"),
                },
            })
        );
    }
}

#[test]
fn a_paid_call_on_a_deployment_without_a_key_gets_the_whole_answer_unsigned() {
    for seed in [None, Some("not a seed"), Some("")] {
        let (out, v) = ask(INTENTS, json!({ "account": "intents.near" }), PRICE_USD_MICRO, seed);
        assert!(out.success && out.error.is_none(), "{seed:?}");
        assert_eq!(out.output["tier"], "unsigned");
        // Everything that was bought except the signature: every reason with its evidence.
        assert_eq!(out.output["check"], v["expect"]);
        assert_eq!(out.output["signed"], Value::Null);
        assert_eq!(out.output["attached_usd_micro"], 10_000);
        assert_eq!(
            out.output["note"],
            "Paid in full: this is the whole answer. It is not signed, because this deployment holds no signing key (PROTECTED_CHECK_SEED). Ask {\"action\":\"about\"} first: it names the key once there is one."
        );
    }
}

/// What a run is told by OutLayer decides the tier, and only the variable of the run's own kind is a payment.
#[test]
fn the_payment_is_read_from_the_runs_own_kind_of_call_and_from_nowhere_else() {
    let tier = |env: &[(&str, &str)]| {
        let mut env = env.to_vec();
        env.push(("PROTECTED_CHECK_SEED", SEED));
        let (out, _) = ask_as(INTENTS, json!({ "account": "intents.near" }), |now_ms| run_of(&env, now_ms));
        assert!(out.success, "{:?}", out.error);
        out.output["tier"].as_str().unwrap().to_string()
    };
    // Over HTTPS: `X-Attached-Deposit`, which reaches the module as USD_PAYMENT.
    assert_eq!(tier(&[("OUTLAYER_EXECUTION_TYPE", "HTTPS"), ("USD_PAYMENT", "10000"), ("ATTACHED_USD", "0")]), "signed");
    // From a contract: `attached_usd`, which reaches it as ATTACHED_USD.
    assert_eq!(tier(&[("OUTLAYER_EXECUTION_TYPE", "NEAR"), ("ATTACHED_USD", "10000"), ("USD_PAYMENT", "0")]), "signed");
    // USD_PAYMENT with no word that the call is HTTPS is not a payment: a variable alone buys nothing.
    assert_eq!(tier(&[("USD_PAYMENT", "10000")]), "preview");
    assert_eq!(tier(&[("OUTLAYER_EXECUTION_TYPE", "NEAR"), ("USD_PAYMENT", "10000"), ("ATTACHED_USD", "0")]), "preview");
    assert_eq!(tier(&[("OUTLAYER_EXECUTION_TYPE", "HTTPS"), ("ATTACHED_USD", "10000"), ("USD_PAYMENT", "0")]), "preview");
    // NEAR attached for the run itself pays OutLayer, not the project.
    assert_eq!(tier(&[("OUTLAYER_EXECUTION_TYPE", "NEAR"), ("NEAR_PAYMENT_YOCTO", "1000000000000000000000000"), ("ATTACHED_USD", "0")]), "preview");
}

#[test]
fn a_short_payment_from_a_contract_is_told_how_a_contract_pays() {
    let env = [("OUTLAYER_EXECUTION_TYPE", "NEAR"), ("ATTACHED_USD", "2500"), ("USD_PAYMENT", "0")];
    let (out, _) = ask_as(LOOKALIKE, json!({ "account": "treasury.intents.near" }), |now_ms| run_of(&env, now_ms));
    assert_eq!((out.success, out.output["tier"].as_str()), (true, Some("preview")));
    let note = out.output["payment"]["note"].as_str().unwrap();
    assert!(note.ends_with(r#"From a contract, attach it in request_execution: params.attached_usd "10000""#), "{note}");
    assert!(!note.contains("header"));
}

#[test]
fn about_names_the_price_the_key_the_rules_and_where_each_network_is_read() {
    let out = unread(json!({ "action": "about" }), &https(0, Some(SEED), 0));
    assert!(out.success);
    assert_eq!(out.output["key"], KEY);
    assert_eq!(out.output["module"], module());
    assert_eq!(
        out.output["tiers"]["signed"],
        json!({ "usd": "0.01", "header": "X-Attached-Deposit: 10000", "attached_usd": "10000", "gives": "every reason with its evidence, signed with the key below" })
    );
    assert_eq!(
        out.output["networks"]["mainnet"],
        json!({ "rpc": ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"], "cross_check": true })
    );
    assert_eq!(out.output["networks"]["testnet"]["rpc"], json!(["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"]));
    assert_eq!(unread(json!({ "action": "about" }), &https(0, None, 0)).output["key"], Value::Null);
}

#[test]
fn the_account_names_the_network_unless_the_call_does() {
    let (out, _) = ask(DRAINED, json!({ "account": "safe-0001.tinygif8324.testnet" }), 0, None);
    assert_eq!((out.output["check"]["network"].as_str(), out.output["check"]["verdict"].as_str()), (Some("testnet"), Some("block")));
    let refused = |input: Value| unread(input, &https(0, None, 0)).error.unwrap();
    assert_eq!(refused(json!({ "account": "alice.near", "network": "testnet" })), "alice.near is a mainnet name; this check reads testnet");
    assert_eq!(refused(json!({ "account": "alice.testnet", "network": "mainnet" })), "alice.testnet is a testnet name; this check reads mainnet");
    assert_eq!(refused(json!({ "account": "Not An Account" })), "not a NEAR account id: Not An Account");
}

#[test]
fn input_the_module_cannot_read_is_refused_and_says_what_it_takes() {
    let v = json!({ "exchanges": [] });
    let run = https(0, None, 0);
    let refused = |input: Option<Value>| {
        let out = answer(input, &run, &Replay::of(&v));
        assert!(!out.success && out.output.is_null());
        out.error.unwrap()
    };
    let shape = r#"input: {"account": "<NEAR account id>", "network": "mainnet" | "testnet", "signed": true}; only account is required"#;
    assert_eq!(refused(None), shape);
    assert_eq!(refused(Some(json!([1, 2]))), shape);
    assert_eq!(refused(Some(json!("intents.near"))), shape);
    for bad in [json!({}), json!({ "account": 7 }), json!({ "account": "" }), json!({ "account": "a".repeat(65) })] {
        assert_eq!(refused(Some(bad)), "account: a NEAR account id, e.g. intents.near or alice.testnet");
    }
    assert_eq!(refused(Some(json!({ "account": "intents.near", "network": "devnet" }))), "network: testnet or mainnet");
    assert_eq!(refused(Some(json!({ "account": "intents.near", "network": 1 }))), "network: testnet or mainnet");
    assert_eq!(refused(Some(json!({ "account": "intents.near", "signed": "yes" }))), "signed: true or false");
    assert_eq!(refused(Some(json!({ "action": "open", "account": "intents.near" }))), "action: check or about");
}

/// sample.json is a real answer of the module: the arena's drained safe as testnet RPC answered about it, bought at
/// the price and signed with RFC 8032's test seed. The README shows it and verify.test.mjs checks its signature with
/// Node. It names the rules that made it, so it is written again whenever the module changes:
/// `MASKWARS_WRITE_SAMPLE=1 cargo test`.
#[test]
fn the_sample_answer_is_what_the_module_gives() {
    let (out, _) = ask(DRAINED, json!({ "account": "safe-0001.tinygif8324.testnet" }), PRICE_USD_MICRO, Some(SEED));
    let text = format!("{}\n", serde_json::to_string_pretty(&out).unwrap());
    let file = concat!(env!("CARGO_MANIFEST_DIR"), "/sample.json");
    if std::env::var("MASKWARS_WRITE_SAMPLE").is_ok() {
        std::fs::write(file, &text).unwrap();
    }
    assert_eq!(std::fs::read_to_string(file).unwrap_or_default(), text, "sample.json is stale: MASKWARS_WRITE_SAMPLE=1 cargo test");
}

#[test]
fn the_published_price_is_the_modules_own() {
    let deployment: Value = serde_json::from_str(include_str!("../deployment.json")).unwrap();
    assert_eq!(deployment["price_usd_micro"], PRICE_USD_MICRO);
    // A version is recorded whole or not at all: the key, the wasm and the rules it states.
    assert_eq!(deployment["key"].is_null(), deployment["wasm_sha256"].is_null());
    assert_eq!(deployment["key"].is_null(), deployment["rules"].is_null());
}

/// A recorded version is this checkout's build: the module carries the two shared lists, so a version recorded before
/// a list changed signs answers that could miss a drain the site already reads. The site then answers itself
/// (apps/web/lib/check-tee.ts); here it fails loudly. Nothing recorded yet: nothing to compare.
#[test]
fn a_recorded_version_states_the_rules_this_checkout_builds() {
    let deployment: Value = serde_json::from_str(include_str!("../deployment.json")).unwrap();
    if let Some(rules) = deployment["rules"].as_str() {
        assert_eq!(
            rules, RULES,
            "deployment.json records a module built from other sources or another shared list: publish this build and record it (live.mjs --record)"
        );
    }
}
