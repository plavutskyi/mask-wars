// The vectors shared with the TypeScript check: packages/check/test/vectors.json holds, for each check, every answer
// the RPC nodes gave and what `maskCheck` said. The module must say the same from the same answers: the same verdict,
// reasons, evidence and words, with the fields in the same order.

use maskwars_check::check::{mask_check, CheckError, Options};
use maskwars_check::list::{parse_list, shared};
use maskwars_check::network::Network;
use maskwars_check::rpc::{Reader, Transport};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;

mod common;
use common::{vector, vectors, Replay};

fn strings(v: &Value) -> Vec<&str> {
    v.as_array().expect("a list").iter().map(|s| s.as_str().expect("a string")).collect()
}

/// What the module answers a vector, in the vector's own form, and the requests the vector did not hold.
fn answer(vector: &Value) -> (Value, Vec<String>) {
    let network = Network::parse(vector["network"].as_str().unwrap()).expect("a network");
    let list = match &vector["list"] {
        Value::String(repo) if repo == "repo" => shared(network),
        inline => parse_list(&inline.to_string()),
    }
    .expect("the vector's list parses");
    let reader = &vector["reader"];
    let endpoints = strings(&reader["endpoints"]);
    let archival: Vec<(&str, &str)> = reader["archival"].as_object().unwrap().iter().map(|(k, v)| (k.as_str(), v.as_str().unwrap())).collect();
    let replay = Replay::of(vector);
    let mut chain = Reader::new(&endpoints, &archival, reader["crossCheck"].as_bool().unwrap(), &replay);
    let options =
        Options { list: &list, network, window_hours: vector["window_hours"].as_u64().unwrap() as u32, now_ms: vector["now_ms"].as_i64().unwrap() };
    let got = match mask_check(vector["account"].as_str().unwrap(), &mut chain, &options) {
        Ok(result) => serde_json::to_value(result).unwrap(),
        Err(CheckError::InvalidAccount(message)) => serde_json::json!({ "throws": "InvalidAccountError", "message": message }),
        // No vector expects this: it shows as a difference, next to the others.
        Err(CheckError::Failed(why)) => serde_json::json!({ "failed": why }),
    };
    (got, replay.unexpected.into_inner())
}

#[test]
fn every_vector_gets_the_answer_the_typescript_check_gives() {
    let vectors = vectors();
    assert!(vectors.len() >= 78, "the file holds {} vectors", vectors.len());
    // Every vector is tried before any is reported: one change to the check shows everything it moved.
    let mut wrong = vec![];
    for v in &vectors {
        let name = v["name"].as_str().unwrap();
        let (got, unexpected) = answer(v);
        if !unexpected.is_empty() {
            wrong.push(format!("{name}: the module asked what the TypeScript check did not: {unexpected:?}"));
        } else if got != v["expect"] {
            wrong.push(format!("{name}:\n   module     {got}\n   TypeScript {}", v["expect"]));
        } else {
            // The same fields in the same order: the answer is the same text, not only the same data.
            let (text, expected) = (got.to_string(), v["expect"].to_string());
            if text != expected {
                wrong.push(format!("{name}: the fields are in another order"));
            }
        }
    }
    assert!(wrong.is_empty(), "{} of {} vectors differ:\n{}", wrong.len(), vectors.len(), wrong.join("\n"));
}

#[test]
fn the_vectors_cover_every_reason_and_verdict_on_both_networks() {
    let (mut codes, mut verdicts, mut networks) = (vec![], vec![], vec![]);
    for v in vectors() {
        networks.push(v["network"].as_str().unwrap().to_string());
        if let Some(verdict) = v["expect"]["verdict"].as_str() {
            verdicts.push(verdict.to_string());
            codes.extend(v["expect"]["reasons"].as_array().unwrap().iter().map(|r| r["code"].as_str().unwrap().to_string()));
        }
    }
    for list in [&mut codes, &mut verdicts, &mut networks] {
        list.sort();
        list.dedup();
    }
    assert_eq!(
        codes,
        [
            "account_age",
            "arena_drained",
            "arena_pending",
            "arena_taken_over",
            "arena_target",
            "arena_unreadable",
            "arena_withstood",
            "chain_unreadable",
            "code_changed",
            "code_deployed",
            "contract",
            "history_unavailable",
            "no_account",
            "plain_account",
            "reported",
            "rpc_agree",
            "rpc_disagree",
            "rpc_single",
            "unused_implicit",
            "young_account",
        ]
    );
    assert_eq!(verdicts, ["allow", "block", "warn"]);
    assert_eq!(networks, ["mainnet", "testnet"]);
}

/// The house's vault, made again under the same name for every round, reads as an arena target by design once the
/// chain confirms it is the house's: never as a hole, and its new account and new code are said, not warned about. A
/// look-alike, or the vault's name the chain does not confirm, gets no label at all.
#[test]
fn the_houses_vault_is_an_arena_target_by_design_and_a_look_alike_is_not() {
    let read = |name: &str| {
        let (got, unexpected) = answer(&vector(name));
        assert!(unexpected.is_empty(), "{name}: {unexpected:?}");
        let reasons: Vec<(String, String)> = got["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["code"].as_str().unwrap().to_string(), r["level"].as_str().unwrap().to_string()))
            .collect();
        (got, reasons)
    };
    let pairs = |list: &[(&str, &str)]| list.iter().map(|(c, l)| (c.to_string(), l.to_string())).collect::<Vec<_>>();
    let design = "Only the house funds it; only the masks of its round (nova.maskwars.near, onyx.maskwars.near, oracle.maskwars.near) can open it; after the round, retire sends the rest home to house.maskwars.near.";

    let (open, reasons) = read("the house's vault in its open round: an arena target by design, warn; its new account said, not warned");
    assert_eq!(open["verdict"], "warn");
    assert_eq!(
        open["summary"],
        format!("WARN: Arena target, by design: the MASK WARS house's vault, live in race-0012 right now. {design} Bounty 0.2 NEAR. Do not send NEAR here.")
    );
    assert_eq!(reasons, pairs(&[("arena_target", "warn"), ("young_account", "info"), ("contract", "info"), ("rpc_agree", "info")]));
    let evidence = &open["reasons"][0]["evidence"];
    assert_eq!((evidence["race"].as_str(), evidence["state"].as_str()), (Some("race-0012"), Some("open")));
    assert_eq!(evidence["code"], maskwars_check::check::SAFE_CODE_URL);
    assert_eq!(evidence["explorer"], "https://nearblocks.io/address/vault.house.maskwars.near");
    assert!(open["reasons"][1]["text"]
        .as_str()
        .unwrap()
        .ends_with("Expected here: the house makes its vault again under the same name for every round."));
    let said = open["summary"].as_str().unwrap().to_lowercase();
    assert!(!said.contains("hole") && !said.contains("critical") && !said.contains("vulnerab"), "{said}");

    let (_, reasons) = read("the house's vault made again over yesterday's with a newer safe code: the change said, not warned");
    assert_eq!(reasons[..3], pairs(&[("arena_target", "warn"), ("code_changed", "info"), ("account_age", "info")]));

    let (drained, reasons) = read("the house's vault a mask drained: block, framed as the arena");
    assert_eq!(drained["verdict"], "block");
    assert!(drained["summary"]
        .as_str()
        .unwrap()
        .starts_with("BLOCK: Drained on the MASK WARS arena, by design: mask nova.maskwars.near won race-0012"));
    assert_eq!(reasons[0], ("arena_drained".to_string(), "block".to_string()));

    let (taken, reasons) = read("the house's vault a mask took over in its open round: block, and still the arena's target");
    assert_eq!(taken["verdict"], "block");
    assert_eq!(reasons[..2], pairs(&[("arena_taken_over", "block"), ("arena_target", "warn")]));

    // A round nobody broke leaves the vault the arena's until it retires: never an allow.
    let (withstood, reasons) = read("the house's vault that withstood its round: warn, still the arena's target until it retires, the round said");
    assert_eq!(withstood["verdict"], "warn");
    assert_eq!(
        withstood["summary"],
        "WARN: Arena target, by design: the MASK WARS house's vault; race-0012 ended with no break, and retire sends everything it holds home to house.maskwars.near. Do not send NEAR here."
    );
    assert_eq!(reasons[..2], pairs(&[("arena_target", "warn"), ("arena_withstood", "info")]));
    for v in vectors().iter().filter(|v| v["account"] == "vault.house.maskwars.near" && v["name"].as_str().unwrap().starts_with("the house's vault"))
    {
        let label = v["expect"]["reasons"].as_array().unwrap().iter().any(|r| r["code"].as_str().unwrap().starts_with("arena_"));
        if label {
            assert_ne!(v["expect"]["verdict"], "allow", "{}", v["name"]);
        }
    }

    let (waiting, _) = read("the house's vault before its round opens: warn, waiting for today's round");
    assert_eq!(
        waiting["summary"],
        format!("WARN: Arena target, by design: the MASK WARS house's vault, waiting for today's round to open. {design} Do not send NEAR here.")
    );

    for name in [
        "a look-alike of the house's vault that answers all the same on chain: no label, a new account",
        "the house's vault whose team is not the house: no label",
        "the house's vault on a code the bounty contract does not list: no label",
    ] {
        let (got, reasons) = read(name);
        assert_eq!(got["verdict"], "warn", "{name}");
        assert_eq!(reasons, pairs(&[("young_account", "warn"), ("contract", "info"), ("rpc_agree", "info")]), "{name}");
        assert!(!got.to_string().contains("by design") && !got.to_string().contains("Expected here"), "{name}");
    }
}

/// A hung first node costs the module one request, not one per read: OutLayer ends a run on its second timeout.
#[test]
fn a_node_that_went_down_is_not_asked_again_in_failover() {
    let v = &vector("failover: the first node cannot be reached, the second answers every read");
    struct Counting<'r>(&'r Replay, RefCell<HashMap<String, u32>>);
    impl Transport for Counting<'_> {
        fn post(&self, url: &str, body: &str) -> Result<(u16, Vec<u8>), String> {
            *self.1.borrow_mut().entry(url.to_string()).or_default() += 1;
            self.0.post(url, body)
        }
    }
    let replay = Replay::of(v);
    let counting = Counting(&replay, RefCell::new(HashMap::new()));
    let list = parse_list(&v["list"].to_string()).unwrap();
    let endpoints = strings(&v["reader"]["endpoints"]);
    let mut chain = Reader::new(&endpoints, &[], false, &counting);
    let options = Options { list: &list, network: Network::Testnet, window_hours: 24, now_ms: v["now_ms"].as_i64().unwrap() };
    let got = mask_check(v["account"].as_str().unwrap(), &mut chain, &options).unwrap();
    assert_eq!(serde_json::to_value(got).unwrap(), v["expect"]);
    let asked = counting.1.into_inner();
    assert_eq!(asked[endpoints[0]], 1, "the node that is down");
    assert!(asked[endpoints[1]] >= 5, "the node that answers");
}
