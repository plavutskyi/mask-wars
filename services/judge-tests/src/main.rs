// OutLayer entry: JSON in on stdin, `{ success, output, error }` out on stdout, which the jobs contract reads. The
// judging is the library (lib.rs); this file only wires it to OutLayer's environment, its RPC and HTTPS.

/// The manifest OutLayer reads from the wasm itself (covered by the wasm's sha256): the judge's own seed comes from
/// the author's secrets on every run, and the module reaches only the RPC hosts it names: dRPC, an operator other than
/// FastNEAR, whose RPC the OutLayer worker itself serves.
#[cfg(target_os = "wasi")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_os = "wasi")]
mod wasi {
    use maskwars_judge_tests::job::{Chain, Keep};
    use serde_json::Value;
    use std::time::Duration;
    use wasi_http_client::Client;

    /// The biggest body the judge reads from any host.
    const MAX_BODY: u64 = 1 << 20;

    fn body(res: wasi_http_client::Response) -> Result<Vec<u8>, String> {
        let mut out = vec![];
        while let Some(chunk) = res.chunk(64 * 1024).map_err(|_| "the answer was cut".to_string())? {
            out.extend(chunk);
            if out.len() as u64 > MAX_BODY {
                return Err("the answer is too long".into());
            }
        }
        Ok(out)
    }

    /// A public NEAR RPC of another operator than the worker's, over HTTPS: the second, independent reading. The
    /// worker's RPC is FastNEAR's (OutLayer is FastNEAR's product), so the second is dRPC.
    pub struct PublicRpc(pub &'static str);

    impl Chain for PublicRpc {
        fn name(&self) -> &str {
            self.0
        }
        fn rpc(&self, method: &str, params: Value) -> Result<String, String> {
            let request = serde_json::json!({ "jsonrpc": "2.0", "id": "maskwars-judge-tests", "method": method, "params": params });
            let res = Client::new()
                .post(self.0)
                .header("content-type", "application/json")
                .header("user-agent", "maskwars-judge-tests")
                .body(request.to_string().as_bytes())
                .connect_timeout(Duration::from_secs(8))
                .send()
                .map_err(|_| "unreachable".to_string())?;
            if res.status() != 200 {
                return Err(format!("answered {}", res.status()));
            }
            String::from_utf8(body(res)?).map_err(|_| "the answer is not text".to_string())
        }
    }

    /// The NEAR RPC the OutLayer worker gives the module for the network it serves.
    pub struct WorkerRpc;

    impl Chain for WorkerRpc {
        fn name(&self) -> &str {
            "outlayer rpc"
        }
        fn rpc(&self, method: &str, params: Value) -> Result<String, String> {
            let (body, error) = outlayer::raw::rpc::raw(method, &params.to_string());
            if !error.is_empty() {
                return Err("unreachable".into());
            }
            Ok(body)
        }
    }

    /// The project's storage on OutLayer, shared by its runs: public keys in plaintext, readable by key from any
    /// project (the delivery for the client, sealed for its key); the rest encrypted for this project's runs alone (the
    /// test set the check kept, the winner's boxes).
    pub struct Storage;

    impl Keep for Storage {
        fn keep(&self, key: &str, value: &[u8], public: bool) -> Result<(), String> {
            outlayer::storage::set_worker_with_options(key, value, Some(!public))
                .map_err(|e| format!("the project's storage did not keep {key}: {e}"))
        }
        fn load(&self, key: &str, _public: bool) -> Result<Option<Vec<u8>>, String> {
            outlayer::storage::get_worker(key).map_err(|e| format!("the project's storage did not read {key}: {e}"))
        }
    }

    pub fn var(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    }

    /// The owner and profile of the secrets row that supplied `name`, from `OUTLAYER_SECRETS_ROWS`.
    pub fn row_of(name: &str) -> (Option<String>, Option<String>) {
        let rows: Value = var("OUTLAYER_SECRETS_ROWS").and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
        let row = rows.as_array().into_iter().flatten().find(|r| {
            r.get("keys").and_then(Value::as_array).is_some_and(|k| k.iter().any(|k| k.as_str() == Some(name)))
        });
        let field = |f: &str| row.and_then(|r| r.get(f)).and_then(Value::as_str).map(String::from);
        (field("owner"), field("profile"))
    }
}

#[cfg(target_os = "wasi")]
fn main() {
    use maskwars_judge_tests::{answer, job::Caller, Secrets};

    let input = outlayer::env::input_json::<serde_json::Value>().ok().flatten();
    // On OutLayer both are always set from facts the worker holds, never from the input: an empty predecessor (an
    // HTTPS call) matches no contract, so nothing but the jobs contract that asks gets a verdict. The contracts this
    // judge serves are the ones written into this wasm for the network the worker serves (`job::served`).
    let network = wasi::var("NEAR_NETWORK_ID");
    let caller = Caller {
        predecessor: Some(wasi::var("NEAR_PREDECESSOR_ID").unwrap_or_default()),
        project: Some(wasi::var("OUTLAYER_PROJECT_ID").unwrap_or_default()),
        served: maskwars_judge_tests::job::served(network.as_deref()),
    };
    let (tests_owner, tests_profile) = wasi::row_of("MASKWARS_TESTS");
    // The seed is the author's alone: OutLayer refuses to start a run where the caller's row defines it too. The test
    // set comes from the client's row only at the check, the one run the jobs contract names that row for.
    let secrets = Secrets {
        seed: wasi::var("PROTECTED_TESTS_SEED"),
        tests: wasi::var("MASKWARS_TESTS"),
        tests_owner,
        tests_profile,
    };
    let public = wasi::PublicRpc(if network.as_deref() == Some("testnet") {
        "https://near-testnet.drpc.org"
    } else {
        "https://near.drpc.org"
    });
    let out = answer(input, &caller, &secrets, &[&wasi::WorkerRpc, &public], &wasi::Storage);
    let _ = outlayer::env::output_json(&out);
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("maskwars-judge-tests runs on OutLayer: build with services/judge-tests/build.sh");
    std::process::exit(1);
}
