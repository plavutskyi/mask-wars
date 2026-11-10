// What the tests of the module share: the vectors of packages/check/test/vectors.json and RPC nodes that answer from
// one vector's exchanges.
#![allow(dead_code)]

use maskwars_check::rpc::Transport;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

const VECTORS: &str = include_str!("../../../../packages/check/test/vectors.json");

/// A value with its object keys in one fixed order, so two spellings of one request are one key.
fn sorted(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
        Value::Object(o) => {
            let ordered: BTreeMap<&String, Value> = o.iter().map(|(k, v)| (k, sorted(v))).collect();
            Value::Object(ordered.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
        other => other.clone(),
    }
}

fn key_of(url: &str, method: &str, params: &Value) -> String {
    format!("{url} {method} {}", sorted(params))
}

/// The RPC nodes of one vector: each request gets the answer the vector holds for it.
pub struct Replay {
    answers: HashMap<String, Result<(u16, Vec<u8>), String>>,
    pub unexpected: RefCell<Vec<String>>,
}

impl Replay {
    pub fn of(vector: &Value) -> Replay {
        let mut answers = HashMap::new();
        for e in vector["exchanges"].as_array().expect("exchanges") {
            let key = key_of(e["url"].as_str().unwrap(), e["method"].as_str().unwrap(), &e["params"]);
            let answer = match (e.get("fail"), e.get("body"), e.get("response")) {
                (Some(why), _, _) => Err(why.as_str().unwrap().to_string()),
                (_, Some(body), _) => Ok((e["status"].as_u64().unwrap() as u16, body.as_str().unwrap().as_bytes().to_vec())),
                (_, _, Some(response)) => Ok((e["status"].as_u64().unwrap() as u16, response.to_string().into_bytes())),
                _ => panic!("an exchange with no answer: {e}"),
            };
            answers.insert(key, answer);
        }
        Replay { answers, unexpected: RefCell::new(vec![]) }
    }
}

impl Transport for Replay {
    fn post(&self, url: &str, body: &str) -> Result<(u16, Vec<u8>), String> {
        let request: Value = serde_json::from_str(body).expect("the reader sends JSON");
        assert_eq!(request["jsonrpc"], "2.0");
        let key = key_of(url, request["method"].as_str().expect("a method"), &request["params"]);
        self.answers.get(&key).cloned().unwrap_or_else(|| {
            self.unexpected.borrow_mut().push(key.clone());
            Err(format!("not in the vector: {key}"))
        })
    }
}

pub fn vectors() -> Vec<Value> {
    let file: Value = serde_json::from_str(VECTORS).expect("vectors.json");
    file["vectors"].as_array().expect("vectors").clone()
}

/// The vector of that name.
pub fn vector(name: &str) -> Value {
    vectors().into_iter().find(|v| v["name"] == name).unwrap_or_else(|| panic!("no vector named {name}"))
}
