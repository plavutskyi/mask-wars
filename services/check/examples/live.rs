// The module's own code against live NEAR RPC, run natively for development:
//
//   cargo run --example live -- intents.near
//   cargo run --example live -- safe-0001.tinygif8324.testnet testnet
//   OUTLAYER_EXECUTION_TYPE=HTTPS USD_PAYMENT=10000 PROTECTED_CHECK_SEED=<64 hex> cargo run --example live -- intents.near
//
// It is `answer` from lib.rs with the run's facts taken from this process: the input from the arguments, the payment
// and the seed from the environment, HTTPS through the `curl` on the PATH. On OutLayer the same function gets them
// from the TEE worker and reaches the RPC providers over `wasi:http` (main.rs).

use maskwars_check::rpc::Transport;
use maskwars_check::{answer, Run};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

struct Curl;

impl Transport for Curl {
    fn post(&self, url: &str, body: &str) -> Result<(u16, Vec<u8>), String> {
        let mut curl = Command::new("curl")
            .args(["--silent", "--show-error", "--max-time", "8", "--request", "POST", "--header", "content-type: application/json"])
            .args(["--user-agent", "maskwars-check", "--data-binary", "@-", "--write-out", "\n%{http_code}", url])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("curl did not start ({e})"))?;
        curl.stdin.take().expect("piped").write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        let out = curl.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("no answer ({})", String::from_utf8_lossy(&out.stderr).trim()));
        }
        // The status is the last line curl wrote, after the body.
        let cut = out.stdout.iter().rposition(|b| *b == b'\n').ok_or("curl wrote no status")?;
        let status = String::from_utf8_lossy(&out.stdout[cut + 1..]).trim().parse().map_err(|_| "curl wrote no status")?;
        Ok((status, out.stdout[..cut].to_vec()))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(account) = args.first() else {
        eprintln!("usage: live <account> [testnet|mainnet]");
        std::process::exit(3);
    };
    let mut input = serde_json::json!({ "account": account });
    if let Some(network) = args.get(1) {
        input["network"] = serde_json::json!(network);
    }
    // The run's facts from this process's environment, by the same rule as on OutLayer: a payment counts only with
    // the kind of call it belongs to.
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let run = Run::from_env(|name| std::env::var(name).ok(), now_ms);
    let out = answer(Some(input), &run, &Curl);
    println!("{}", serde_json::to_string_pretty(&out).expect("an answer is JSON"));
    std::process::exit(i32::from(!out.success));
}
