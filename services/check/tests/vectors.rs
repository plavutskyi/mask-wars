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
