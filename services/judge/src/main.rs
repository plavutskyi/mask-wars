// OutLayer entry: JSON in on stdin, `{ success, output, error }` out on stdout, which the bounty contract reads.
// The judging itself is the library (lib.rs); this file only wires it to OutLayer's input, HTTPS and RPC.

#[cfg(target_os = "wasi")]
use maskwars_judge::{answer, chain, judge, public_rpcs};
#[cfg(target_os = "wasi")]
use serde_json::Value;

#[cfg(target_os = "wasi")]
mod https {
    use std::time::Duration;
    use wasi_http_client::Client;

    fn read(res: wasi_http_client::Response, who: &str) -> Result<serde_json::Value, String> {
        let status = res.status();
        if status != 200 {
            return Err(format!("{who} answered {status}"));
        }
        let body = res.body().map_err(|_| format!("{who}'s answer was cut"))?;
        serde_json::from_slice(&body).map_err(|_| format!("{who}'s answer is not JSON"))
    }

    /// GitHub's REST API over HTTPS from inside the TEE. `GITHUB_TOKEN` is an OutLayer sealed secret, needed only
    /// while the repository is private; it can read Actions and nothing else.
    pub struct Api;

    impl super::judge::GitHub for Api {
        fn get(&self, path: &str) -> Result<serde_json::Value, String> {
            let mut req = Client::new()
                .get(&format!("https://api.github.com{path}"))
                .header("accept", "application/vnd.github+json")
                .header("user-agent", "maskwars-judge")
                .header("x-github-api-version", "2022-11-28")
                .connect_timeout(Duration::from_secs(10));
            if let Some(token) = std::env::var("GITHUB_TOKEN").ok().filter(|t| !t.is_empty()) {
                req = req.header("authorization", format!("Bearer {token}"));
            }
            read(req.send().map_err(|_| "GitHub is unreachable".to_string())?, "GitHub")
        }
    }

    /// A public NEAR RPC, reached over HTTPS from inside the TEE: an independent reading beside the worker's.
    pub struct PublicRpc(pub &'static str);

    impl super::chain::Chain for PublicRpc {
        fn name(&self) -> &str {
            self.0
        }
        fn rpc(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
            let body =
                serde_json::json!({ "jsonrpc": "2.0", "id": "maskwars-judge", "method": method, "params": params });
            let res = Client::new()
                .post(self.0)
                .header("content-type", "application/json")
                .header("user-agent", "maskwars-judge")
                .body(body.to_string().as_bytes())
                .connect_timeout(Duration::from_secs(10))
                .send()
                .map_err(|_| "unreachable".to_string())?;
            read(res, "RPC")
        }
    }

    /// The NEAR RPC that the OutLayer worker itself gives the module (`near:rpc`), for the network it serves.
    pub struct WorkerRpc;

    impl super::chain::Chain for WorkerRpc {
        fn name(&self) -> &str {
            "outlayer rpc"
        }
        fn rpc(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
            let (body, error) = outlayer::raw::rpc::raw(method, &params.to_string());
            if !error.is_empty() {
                return Err("unreachable".into());
            }
            serde_json::from_str(&body).map_err(|_| "answer is not JSON".to_string())
        }
    }
}

#[cfg(target_os = "wasi")]
fn main() {
    use outlayer::env;

    let input = env::input_json::<Value>().ok().flatten();
    // The public readings of a drain, on the network of the safe: one on testnet, two of other operators on mainnet;
    // the first reading is always the worker's own RPC. Every one of them must agree.
    let public: Vec<https::PublicRpc> = public_rpcs(input.as_ref()).iter().map(|url| https::PublicRpc(url)).collect();
    let mut sources: Vec<&dyn chain::Chain> = vec![&https::WorkerRpc];
    sources.extend(public.iter().map(|p| p as &dyn chain::Chain));
    let out = answer(input, &https::Api, &sources);
    let _ = env::output_json(&out);
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("maskwars-judge runs on OutLayer: build with --target wasm32-wasip2");
    std::process::exit(1);
}
