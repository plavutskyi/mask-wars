// The vault keeps each winning break sealed inside OutLayer's TEE. Only the race worker (the project owner) seals a
// break; anyone may read its public line for the board; the full break leaves only for the holder of the claim code
// the requester got when they asked for the race. The vault stores the code's SHA-256, never the code itself.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Where sealed records live. On OutLayer this is the project's encrypted worker storage; in tests, a map.
pub trait Store {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    /// Writes only if the key is new; false when it already exists.
    fn put_new(&mut self, key: &str, value: &[u8]) -> Result<bool, String>;
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Input {
    Seal { id: String, claim_hash: String, public: Value, finding: Value },
    Board { id: String },
    Open { id: String, claim: String },
}

#[derive(Serialize, Deserialize)]
struct Record {
    claim_hash: String,
    public: Value,
    finding: Value,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Output {
    pub success: bool,
    pub output: Value,
    pub error: Option<String>,
}

fn ok(output: Value) -> Output {
    Output { success: true, output, error: None }
}

fn fail(error: &str) -> Output {
    Output { success: false, output: Value::Null, error: Some(error.to_string()) }
}

const MIN_CLAIM: usize = 32;
const MAX_RECORD: usize = 256 * 1024;

fn id_ok(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn hex_sha256(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Same answer in the same time whatever the bytes, so a guess learns nothing from timing.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn key(id: &str) -> String {
    format!("break:{id}")
}

/// `caller` is the account that paid for this run; `owner` is the project owner. Only the owner may seal.
pub fn handle(input: Input, caller: Option<&str>, owner: Option<&str>, store: &mut dyn Store) -> Output {
    match input {
        Input::Seal { id, claim_hash, public, finding } => {
            match (caller, owner) {
                (Some(c), Some(o)) if c == o => {}
                _ => return fail("only the race worker seals"),
            }
            if !id_ok(&id) {
                return fail("bad id");
            }
            if !is_hex64(&claim_hash) {
                return fail("bad claim hash");
            }
            let bytes = match serde_json::to_vec(&Record { claim_hash, public, finding }) {
                Ok(b) => b,
                Err(_) => return fail("bad record"),
            };
            if bytes.len() > MAX_RECORD {
                return fail("record too large");
            }
            match store.put_new(&key(&id), &bytes) {
                Ok(true) => ok(serde_json::json!({ "id": id })),
                Ok(false) => fail("already sealed"),
                Err(e) => fail(&e),
            }
        }
        Input::Board { id } => match load(store, &id) {
            Ok(r) => ok(r.public),
            Err(e) => fail(e),
        },
        Input::Open { id, claim } => {
            if claim.len() < MIN_CLAIM {
                return fail("wrong claim");
            }
            match load(store, &id) {
                Ok(r) if same(&hex_sha256(&claim), &r.claim_hash) => ok(r.finding),
                Ok(_) => fail("wrong claim"),
                Err(e) => fail(e),
            }
        }
    }
}

fn load(store: &dyn Store, id: &str) -> Result<Record, &'static str> {
    if !id_ok(id) {
        return Err("bad id");
    }
    match store.get(&key(id)) {
        Ok(Some(b)) => serde_json::from_slice(&b).map_err(|_| "unreadable record"),
        Ok(None) => Err("not found"),
        Err(_) => Err("storage unavailable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Mem(HashMap<String, Vec<u8>>);

    impl Store for Mem {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.get(key).cloned())
        }
        fn put_new(&mut self, key: &str, value: &[u8]) -> Result<bool, String> {
            if self.0.contains_key(key) {
                return Ok(false);
            }
            self.0.insert(key.to_string(), value.to_vec());
            Ok(true)
        }
    }

    const OWNER: &str = "maskwars.near";
    const CLAIM: &str = "c1a1m-c0de-0123456789abcdef0123456789";

    fn seal(store: &mut Mem, caller: &str) -> Output {
        let input = serde_json::from_value(json!({
            "action": "seal",
            "id": "race-0001",
            "claim_hash": hex_sha256(CLAIM),
            "public": { "winner": "NOVA", "seconds": 188 },
            "finding": { "plan": ["call set_owner", "call withdraw"] },
        }))
        .unwrap();
        handle(input, Some(caller), Some(OWNER), store)
    }

    fn run(store: &mut Mem, v: Value) -> Output {
        handle(serde_json::from_value(v).unwrap(), Some("someone.near"), Some(OWNER), store)
    }

    #[test]
    fn owner_seals_once() {
        let mut s = Mem::default();
        assert!(seal(&mut s, OWNER).success);
        assert_eq!(seal(&mut s, OWNER).error.as_deref(), Some("already sealed"));
    }

    #[test]
    fn stranger_cannot_seal() {
        let mut s = Mem::default();
        assert_eq!(seal(&mut s, "someone.near").error.as_deref(), Some("only the race worker seals"));
        assert!(s.0.is_empty());
    }

    #[test]
    fn board_shows_only_the_public_line() {
        let mut s = Mem::default();
        seal(&mut s, OWNER);
        let out = run(&mut s, json!({ "action": "board", "id": "race-0001" }));
        assert_eq!(out.output, json!({ "winner": "NOVA", "seconds": 188 }));
    }

    #[test]
    fn right_claim_opens_the_break() {
        let mut s = Mem::default();
        seal(&mut s, OWNER);
        let out = run(&mut s, json!({ "action": "open", "id": "race-0001", "claim": CLAIM }));
        assert_eq!(out.output, json!({ "plan": ["call set_owner", "call withdraw"] }));
    }

    #[test]
    fn wrong_or_short_claim_opens_nothing() {
        let mut s = Mem::default();
        seal(&mut s, OWNER);
        for claim in ["short", "c1a1m-c0de-0123456789abcdef012345678X"] {
            let out = run(&mut s, json!({ "action": "open", "id": "race-0001", "claim": claim }));
            assert_eq!(out.error.as_deref(), Some("wrong claim"));
            assert_eq!(out.output, Value::Null);
        }
    }

    #[test]
    fn the_claim_itself_is_never_stored() {
        let mut s = Mem::default();
        seal(&mut s, OWNER);
        let stored = String::from_utf8(s.0.values().next().unwrap().clone()).unwrap();
        assert!(!stored.contains(CLAIM));
    }

    #[test]
    fn bad_ids_are_refused() {
        let mut s = Mem::default();
        for id in ["short", "../etc", "has space in it"] {
            let out = run(&mut s, json!({ "action": "board", "id": id }));
            assert_eq!(out.error.as_deref(), Some("bad id"));
        }
    }
}
