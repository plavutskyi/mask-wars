// The MASK WARS judge: one question in, one verdict out. `kind: "drain"` is a live safe on chain (chain.rs); anything
// else is a sandbox race on GitHub (judge.rs). On OutLayer it runs as the `maskwars-judge` wasm (main.rs); the local
// sandbox round in contracts/challenges uses this same code over the sandbox's RPC.

pub mod chain;
pub mod judge;

use serde_json::Value;

/// The public readings of a drain, besides the RPC the OutLayer worker gives the module for its own network, for the
/// network the safe lives on (A14). Every source must give the same verdict. A `.testnet` safe is read on testnet with
/// one public RPC beside the worker's. Any other safe is read on mainnet, where the NEAR is real, with two public RPCs of
/// two more operators: FastNEAR and dRPC, as MASK CHECK reads mainnet. A forged drain then needs the worker's RPC,
/// FastNEAR and dRPC to lie the same way at once. A worker of the other network does not know the safe, and the claim
/// fails.
pub fn public_rpcs(input: Option<&Value>) -> &'static [&'static str] {
    let safe = input.and_then(|i| i.get("safe")).and_then(Value::as_str).unwrap_or("");
    if safe.ends_with(".testnet") {
        &["https://rpc.testnet.fastnear.com"]
    } else {
        &["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]
    }
}

/// The judge's answer to one question from the bounty contract.
pub fn answer(input: Option<Value>, gh: &dyn judge::GitHub, chains: &[&dyn chain::Chain]) -> judge::Output {
    let Some(input) = input else {
        return judge::Output::from::<()>(Err("bad input".into()));
    };
    if input.get("kind").and_then(Value::as_str) == Some("drain") {
        match serde_json::from_value::<chain::DrainInput>(input) {
            Ok(i) => judge::Output::from(chain::judge_drain(&i, chains)),
            Err(_) => judge::Output::from::<()>(Err("bad input".into())),
        }
    } else {
        match serde_json::from_value::<judge::Input>(input) {
            Ok(i) => judge::Output::from(judge::judge(&i, gh)),
            Err(_) => judge::Output::from::<()>(Err("bad input".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Nothing;

    impl judge::GitHub for Nothing {
        fn get(&self, path: &str) -> Result<Value, String> {
            Err(format!("404 {path}"))
        }
    }

    impl chain::Chain for Nothing {
        fn name(&self) -> &str {
            "none"
        }
        fn rpc(&self, _: &str, _: Value) -> Result<Value, String> {
            Err("unreachable".into())
        }
    }

    #[test]
    fn a_drain_goes_to_the_chain_and_a_race_to_github() {
        let tx = "9vZy5fJ3bQhW2nT8kR4mX1cLpA6sDgE7uYoHiNjKwMzV";
        let drain = json!({ "kind": "drain", "contract": "bounty.tinygif8324.testnet", "bounty_id": "race-0004", "safe": "safe-0002.tinygif8324.testnet",
            "mask": "nova.tinygif8324.testnet", "tx_hash": tx, "min_loot": "1", "opened_ns": "1", "deadline_ns": "2",
            "plan": [{ "method": "sweep", "args": {} }], "plan_txs": [tx], "opened_height": "7",
            "safe_code": "7Hq3rXbK9mP2vW5yZ8cD1fG4hJ6kL9nQ2sT5uV8wX1yA", "masks": ["nova.tinygif8324.testnet"] });
        let out = answer(Some(drain), &Nothing, &[&Nothing]);
        assert_eq!(out.error.as_deref(), Some("none: unreachable"));

        for race in [
            json!({ "kind": "race", "bounty_id": "race-0001", "target": "open-admin", "run_id": "42",
                    "opened_ns": "1", "masks": ["nova.testnet"] }),
            json!({ "bounty_id": "race-0001", "target": "open-admin", "run_id": "42", "opened_ns": "1", "masks": ["nova.testnet"] }),
        ] {
            let out = answer(Some(race), &Nothing, &[&Nothing]);
            assert!(out.error.unwrap().starts_with("404 /repos/"));
        }
    }

    #[test]
    fn a_drain_is_read_on_the_network_of_its_safe() {
        let on = |safe: &str| public_rpcs(Some(&json!({ "kind": "drain", "safe": safe })));
        assert_eq!(on("safe-0002.tinygif8324.testnet"), ["https://rpc.testnet.fastnear.com"]);
        // Mainnet: two more operators beside the worker's RPC (A14), the same two MASK CHECK reads mainnet with.
        let mainnet = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];
        assert_eq!(on("s0001.season.maskwars.near"), mainnet);
        assert_eq!(on("safe-0001.maskwars.near"), mainnet);
        assert_eq!(on("0e6879a4be880000000000000000000000000000000000000000000000000000"), mainnet);
        assert_eq!(public_rpcs(None), mainnet, "no safe named: the stricter reading");
    }

    #[test]
    fn unreadable_input_is_refused() {
        for bad in [None, Some(json!({ "kind": "drain", "bounty_id": "x" })), Some(json!([1, 2]))] {
            let out = answer(bad, &Nothing, &[&Nothing]);
            assert_eq!((out.success, out.error.as_deref()), (false, Some("bad input")));
        }
    }

    #[test]
    fn a_verdict_keeps_the_shape_the_contract_reads() {
        let v = judge::Verdict { bounty_id: "race-0001".into(), winner: "nova.testnet".into(), run_id: "42".into() };
        let out = serde_json::to_value(judge::Output::from(Ok(v))).unwrap();
        assert_eq!(
            out,
            json!({ "success": true, "output": { "bounty_id": "race-0001", "winner": "nova.testnet", "run_id": "42" }, "error": null })
        );
    }
}
