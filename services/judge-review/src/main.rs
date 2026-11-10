// OutLayer entry: JSON in on stdin, `{ success, output, error }` out on stdout, which the jobs contract reads. The
// judging is the library (lib.rs); this file only wires it to OutLayer's environment, RPC, storage and HTTPS.

/// The manifest OutLayer reads from the wasm itself (covered by the wasm's sha256): the NEAR AI key and the judge's TEE
/// seed come from the author's secrets on every run, and the module reaches only the hosts it names: dRPC (an operator
/// other than FastNEAR, whose RPC the worker serves), three IPFS gateways and NEAR AI.
#[cfg(target_os = "wasi")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_os = "wasi")]
mod wasi {
    use maskwars_judge_review::job::Chain;
    use maskwars_judge_review::nearai::Transport;
    use maskwars_judge_review::store::Http;
    use maskwars_judge_review::{Clock, Keep};
    use serde_json::Value;
    use std::time::{Duration, Instant};
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

    fn text(res: wasi_http_client::Response) -> Result<(u16, String), String> {
        let status = res.status();
        let bytes = body(res)?;
        Ok((status, String::from_utf8(bytes).map_err(|_| "the answer is not text".to_string())?))
    }

    /// HTTPS from inside the TEE: NEAR AI and the content store.
    pub struct Https;

    impl Transport for Https {
        fn post(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<(u16, String), String> {
            let mut req = Client::new().post(url).connect_timeout(Duration::from_secs(8));
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            text(req.body(body.as_bytes()).send().map_err(|_| "NEAR AI is unreachable".to_string())?)
        }
        fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<(u16, String), String> {
            let mut req = Client::new().get(url).connect_timeout(Duration::from_secs(8));
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            text(req.send().map_err(|_| "NEAR AI is unreachable".to_string())?)
        }
        fn pause(&self, ms: u64) {
            std::thread::sleep(Duration::from_millis(ms));
        }
    }

    impl Http for Https {
        fn get(&self, url: &str, accept: &str, max: usize) -> Result<(u16, Vec<u8>), String> {
            let res = Client::new()
                .get(url)
                .header("accept", accept)
                .header("user-agent", "maskwars-judge-review")
                .connect_timeout(Duration::from_secs(4))
                .send()
                .map_err(|_| "unreachable".to_string())?;
            let status = res.status();
            // An answer longer than asked for is an answer: what was read of it is kept, and it does not hash right.
            let mut out = vec![];
            while out.len() < max {
                match res.chunk(64 * 1024) {
                    Ok(Some(chunk)) => out.extend(chunk),
                    Ok(None) => break,
                    Err(_) => return Err("the answer was cut".into()),
                }
            }
            out.truncate(max);
            Ok((status, out))
        }
        fn pause(&self, ms: u64) {
            std::thread::sleep(Duration::from_millis(ms));
        }
    }

    /// A public NEAR RPC of another operator than the worker's, over HTTPS: the second, independent reading. The
    /// worker's RPC is FastNEAR's (OutLayer is FastNEAR's product), so the second is dRPC.
    pub struct PublicRpc(pub &'static str);

    impl Chain for PublicRpc {
        fn name(&self) -> &str {
            self.0
        }
        fn rpc(&self, method: &str, params: Value) -> Result<String, String> {
            let request = serde_json::json!({ "jsonrpc": "2.0", "id": "maskwars-judge-review", "method": method, "params": params });
            let res = Client::new()
                .post(self.0)
                .header("content-type", "application/json")
                .header("user-agent", "maskwars-judge-review")
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
    /// project (the evidence, the material the check passed, the delivery sealed for the client's key); the rest
    /// encrypted for this project's runs alone (the answers so far, the winner's boxes).
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

    /// Randomness from the TEE: the WASI host's, inside the enclave OutLayer runs the module in.
    pub struct Tee;

    impl maskwars_judge_review::Random for Tee {
        fn fill(&self, buf: &mut [u8]) -> Result<(), String> {
            getrandom::getrandom(buf).map_err(|e| format!("the TEE gave no randomness: {e}"))
        }
    }

    pub struct Since(pub Instant);

    impl Clock for Since {
        fn ms(&self) -> u64 {
            self.0.elapsed().as_millis() as u64
        }
    }

    pub fn var(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    }

    /// Whether a secrets row the call named supplied `name`. `OUTLAYER_SECRETS_ROWS` lists the caller's rows; the
    /// author's row (the project owner's, profile `judge`) is not one of them, even if it were listed.
    pub fn from_caller(name: &str) -> bool {
        let rows: Value = var("OUTLAYER_SECRETS_ROWS").and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
        let owner = var("OUTLAYER_PROJECT_OWNER").unwrap_or_default();
        rows.as_array().into_iter().flatten().any(|r| {
            let lists = r.get("keys").and_then(Value::as_array).is_some_and(|k| k.iter().any(|k| k.as_str() == Some(name)));
            let author = r.get("owner").and_then(Value::as_str) == Some(owner.as_str())
                && r.get("profile").and_then(Value::as_str) == Some("judge");
            lists && !author
        })
    }
}

#[cfg(target_os = "wasi")]
fn main() {
    use maskwars_judge_review::nearai::{Model, NearAi};
    use maskwars_judge_review::{answer, job::Caller, prompt::MODEL, store::Ipfs, store::GATEWAYS};

    let clock = wasi::Since(std::time::Instant::now());
    let input = outlayer::env::input_json::<serde_json::Value>().ok().flatten();
    // On OutLayer both are always set from facts the worker holds, never from the input: an empty predecessor (an
    // HTTPS call) matches no contract, so nothing but the jobs contract that asks gets a verdict. The contracts this
    // judge serves are the ones written into this wasm for the network the worker serves (`job::served`).
    let network = wasi::var("NEAR_NETWORK_ID");
    let caller = Caller {
        predecessor: Some(wasi::var("NEAR_PREDECESSOR_ID").unwrap_or_default()),
        project: Some(wasi::var("OUTLAYER_PROJECT_ID").unwrap_or_default()),
        served: maskwars_judge_review::job::served(network.as_deref()),
    };
    let public = wasi::PublicRpc(if network.as_deref() == Some("testnet") {
        "https://near-testnet.drpc.org"
    } else {
        "https://near.drpc.org"
    });
    let store = Ipfs::new(&wasi::Https, &GATEWAYS).until(&clock, maskwars_judge_review::FETCH_MS);
    // The key is the author's: a key that came from a row the caller named is not used.
    let key = wasi::var("NEARAI_API_KEY").filter(|_| !wasi::from_caller("NEARAI_API_KEY"));
    let near_ai = key.as_deref().map(|key| NearAi { http: &wasi::Https, key, model: MODEL });
    let model = near_ai.as_ref().map(|m| m as &dyn Model);
    // The judge's own seed, generated in the TEE: the author's, never a row the caller named.
    let seed = wasi::var("PROTECTED_REVIEW_SEED").filter(|_| !wasi::from_caller("PROTECTED_REVIEW_SEED"));
    let out = answer(input, &caller, &[&wasi::WorkerRpc, &public], &store, model, &wasi::Storage, &clock, seed.as_deref(), &wasi::Tee);
    let _ = outlayer::env::output_json(&out);
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("maskwars-judge-review runs on OutLayer: build with services/judge-review/build.sh");
    std::process::exit(1);
}
