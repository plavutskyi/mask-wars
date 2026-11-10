//! The job judges against the real jobs contract in a local NEAR sandbox. The world is the one the jobs contract's sandbox
//! builds (`jobs-sandbox`): the jobs and crews contracts deployed without a key, masks that sign only with narrow keys,
//! and the OutLayer stand-in that holds the judge's question until the test hands back an answer.
//!
//! Here that answer is the judge's own: the judge library runs over the sandbox's RPC, reads the job from the chain
//! the way it does on OutLayer, and its stdout goes back to the contract as the judge run's result. In the sandbox
//! both RPC "sources" are the one local node, and the content store is in memory.

use anyhow::{bail, ensure, Context, Result};
use jobs_sandbox::{why, World};
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;

pub use jobs_sandbox::{
    bonds_of, n3, paid_out, settle_event, sha256_hex, yocto, Mask, CLIENT_KEY, CLIENT_SECRET, MILLI, MIN_NS, ONE_NEAR,
    REVIEW_KEY, TESTS_KEY, TESTS_V,
};
pub use maskwars_judge_tests::job::{Caller, Chain, Keep};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// The judge project's storage on OutLayer, in memory, kept from run to run: public and private keys apart.
#[derive(Default)]
pub struct Kept(pub Mutex<BTreeMap<(bool, String), Vec<u8>>>);

impl Keep for Kept {
    fn keep(&self, key: &str, value: &[u8], public: bool) -> std::result::Result<(), String> {
        self.0.lock().unwrap().insert((public, key.to_string()), value.to_vec());
        Ok(())
    }
    fn load(&self, key: &str, public: bool) -> std::result::Result<Option<Vec<u8>>, String> {
        Ok(self.0.lock().unwrap().get(&(public, key.to_string())).cloned())
    }
}

impl Kept {
    /// How many keys start with `prefix`, public or not.
    pub fn count(&self, prefix: &str) -> usize {
        self.0.lock().unwrap().keys().filter(|(_, k)| k.starts_with(prefix)).count()
    }

    pub fn public(&self, key: &str) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(&(true, key.to_string())).cloned()
    }

    /// Everything the project published, gone.
    pub fn forget_public(&self) {
        self.0.lock().unwrap().retain(|(public, _), _| !public);
    }
}

/// The judge projects the sandbox's jobs contract serves `tee_tests` and `ai_review` with.
pub const TESTS_PROJECT: &str = "maskwars.testnet/tests";
pub const REVIEW_PROJECT: &str = "maskwars.testnet/review";

/// The sandbox's JSON-RPC over plain HTTP, for a judge, which asks synchronously.
#[derive(Clone)]
pub struct SandboxRpc {
    host: String,
    name: &'static str,
}

impl SandboxRpc {
    pub fn new(addr: &str, name: &'static str) -> Self {
        Self { host: addr.trim_start_matches("http://").trim_end_matches('/').to_string(), name }
    }

    /// One JSON-RPC call to the sandbox node: the whole response body.
    pub fn call(&self, method: &str, params: Value) -> std::result::Result<String, String> {
        self.post(&json!({ "jsonrpc": "2.0", "id": "judge", "method": method, "params": params }).to_string())
    }

    fn post(&self, body: &str) -> std::result::Result<String, String> {
        let mut s = TcpStream::connect(&self.host).map_err(|e| e.to_string())?;
        let req = format!(
            "POST / HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            self.host,
            body.len()
        );
        s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
        let mut raw = vec![];
        s.read_to_end(&mut raw).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&raw);
        let (head, body) = text.split_once("\r\n\r\n").ok_or("no HTTP body")?;
        Ok(if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
            unchunk(body)
        } else {
            body.to_string()
        })
    }
}

fn unchunk(mut rest: &str) -> String {
    let mut out = String::new();
    while let Some((size, tail)) = rest.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || tail.len() < n {
            break;
        }
        out.push_str(&tail[..n]);
        rest = tail[n..].trim_start_matches("\r\n");
    }
    out
}

impl Chain for SandboxRpc {
    fn name(&self) -> &str {
        self.name
    }
    fn rpc(&self, method: &str, params: Value) -> std::result::Result<String, String> {
        self.call(method, params)
    }
}

/// Two readers of the sandbox's one node: the judge reads through both and they must agree.
pub fn sources(w: &World) -> (SandboxRpc, SandboxRpc) {
    let addr = w.worker.rpc_addr();
    (SandboxRpc::new(&addr, "sandbox rpc"), SandboxRpc::new(&addr, "sandbox rpc, second reader"))
}

/// What OutLayer tells a run of the judge project about itself, here for the sandbox's jobs contract, and the contract
/// the judge serves: on OutLayer the one written into its wasm for the network, here the sandbox's.
pub fn caller(w: &World, project: &str) -> Caller {
    Caller { predecessor: Some(w.jobs.to_string()), project: Some(project.to_string()), served: vec![w.jobs.to_string()] }
}

/// The client opens a job of `kind` with these hashes, secrets and bar, paying exactly what `quote` says, with its own
/// key for the winning work and the default bond (`fuel_per_mask`). Until the judge checks the material
/// (`check_with`), no mask may enlist.
#[allow(clippy::too_many_arguments)]
pub async fn open(
    w: &World,
    id: &str,
    kind: &str,
    judge_version: &str,
    spec: &str,
    rubric: &str,
    secrets: Option<Value>,
    bar: Value,
    reward: u128,
    slots: u8,
) -> Result<Value> {
    let fuel = 50 * MILLI;
    let quote = w
        .view(&w.jobs, "quote", json!({ "reward": reward.to_string(), "fuel_per_mask": fuel.to_string(), "slots": slots }))
        .await?;
    let total: u128 = quote["total"].as_str().context("quote")?.parse()?;
    let r = w
        .client
        .call(&w.jobs, "open")
        .args_json(json!({
            "id": id, "kind": kind, "brief": "Say whether each input is a valid NEAR account id; private test set",
            "spec": spec, "rubric": rubric, "judge_version": judge_version, "round": null, "secrets": secrets, "bar": bar,
            "reward": reward.to_string(), "fuel_per_mask": fuel.to_string(), "slots": slots,
            "open_to": { "who": "anyone" }, "work_minutes": 5, "reveal_minutes": 5, "appeal_minutes": 10,
            "client_key": CLIENT_KEY,
        }))
        .deposit(NearToken::from_yoctonear(total))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(r.is_success(), "open {id}: {}", why(&r));
    w.job(id).await
}

/// ANN forms a duo (KIRA scouts, NOVA strikes, 30/70); NOVA joins with its own key, ANN joins for KIRA on the
/// factory's word; each mask's owner locks its bond; ANN enlists the crew in `job`. Returns its entrant number.
pub async fn duo_on(w: &World, crew: &str, job: &str) -> Result<u32> {
    let members = json!([{ "mask": w.kira.id, "role": "scout" }, { "mask": w.nova.id, "role": "striker" }]);
    let r = w
        .ann
        .call(&w.crews, "form")
        .args_json(json!({ "id": crew, "members": members, "split": { "scout": 3000, "striker": 7000, "verifier": 0 } }))
        .deposit(NearToken::from_millinear(100))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    ensure!(r.is_success(), "form: {}", why(&r));
    let r = w.nova.on_crews.call(&w.crews, "join").args_json(json!({ "id": crew, "version": 1 })).transact().await?;
    ensure!(r.is_success(), "NOVA joins: {}", why(&r));
    let r = w
        .ann
        .call(&w.crews, "join_for")
        .args_json(json!({ "id": crew, "version": 1, "mask": w.kira.id }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    let logs = format!("{:?}", r.logs());
    ensure!(r.json::<bool>()?, "ANN joins for KIRA: {logs}");
    w.bond_all(job, &[&w.kira, &w.nova]).await?;
    let r = w
        .ann
        .call(&w.crews, "enlist")
        .args_json(json!({ "id": crew, "jobs": w.jobs, "job": job }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let failed = why(&r);
    r.json::<Option<u32>>()?.with_context(|| format!("the crew enlists: {failed}"))
}

/// The mask's owner locks its bond, and the mask takes the job alone.
pub async fn enlist(w: &World, mask: &Mask, job: &str) -> Result<u32> {
    w.enlist(mask, job).await
}

/// Waits out the work window, has every mask reveal what it sealed, then waits out the reveal window.
pub async fn reveal_all(w: &World, job: &Value, steps: &[(&Mask, u32, &str)]) -> Result<()> {
    w.wait_until(yocto(&job["terms"]["work_until"]) as u64).await?;
    for (mask, seq, content) in steps {
        let r = w.reveal(mask, job["id"].as_str().unwrap(), *seq, content).await?;
        ensure!(r.is_success(), "{} reveals step {seq}: {}", mask.id, why(&r));
    }
    w.wait_until(yocto(&job["terms"]["reveal_until"]) as u64).await
}

/// Anyone asks the judge; the judge (`run`, given the question OutLayer received, returning its stdout as JSON)
/// answers; its stdout goes back to the contract. Returns the judge's output, OutLayer's request and the job after
/// the callback.
pub async fn judge_with<F>(w: &World, id: &str, appeal: bool, run: F) -> Result<(Value, Value, Value)>
where
    F: FnOnce(Value) -> Value + Send + 'static,
{
    let (pending, index, request) = if appeal {
        appeal_request(w, id).await?
    } else {
        w.ask_judge(&w.bob, id).await?
    };
    let input: Value = serde_json::from_str(request["input"].as_str().context("input")?)?;
    let out = tokio::task::spawn_blocking(move || run(input)).await?;
    let stdout = serde_json::to_string(&out)?;
    ensure!(stdout.len() <= 4096, "the judge's answer fits what the contract reads: {} bytes", stdout.len());
    let r = w.answer(pending, index, &stdout).await?;
    ensure!(r.is_success(), "the callback: {}", why(&r));
    let job = w.job(id).await?;
    Ok((out, request, job))
}

/// Anyone asks the judge to check the job's material before any mask starts; the judge (`run`) answers in check mode
/// and its stdout goes back to the contract. Returns the judge's output and the job after the callback.
pub async fn check_with<F>(w: &World, id: &str, run: F) -> Result<(Value, Value)>
where
    F: FnOnce(Value) -> Value + Send + 'static,
{
    let (pending, index, request) = w.ask_check(&w.bob, id).await?;
    let input: Value = serde_json::from_str(request["input"].as_str().context("input")?)?;
    ensure!(input["check"] == json!(true), "the judge is asked to check: {input}");
    let out = tokio::task::spawn_blocking(move || run(input)).await?;
    let stdout = serde_json::to_string(&out)?;
    let r = w.answer(pending, index, &stdout).await?;
    ensure!(r.is_success(), "the check's callback: {}", why(&r));
    Ok((out, w.job(id).await?))
}

/// BOB appeals with the bond; returns the pending appeal once OutLayer has the question.
async fn appeal_request(w: &World, id: &str) -> Result<(near_workspaces::operations::TransactionStatus, u32, Value)> {
    let asked = w.view(w.outlayer.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
    let pending = w
        .bob
        .call(&w.jobs, "appeal")
        .args_json(json!({ "id": id }))
        .deposit(NearToken::from_millinear(200))
        .gas(Gas::from_tgas(250))
        .transact_async()
        .await?;
    for _ in 0..300 {
        if let std::task::Poll::Ready(r) = pending.status().await? {
            bail!("the contract did not take the appeal: {}", why(&r));
        }
        let requests = w.view(w.outlayer.id(), "requests", json!({})).await?;
        if let Some(r) = requests.as_array().and_then(|r| r.get(asked)) {
            return Ok((pending, asked as u32, r.clone()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    bail!("the appeal never reached OutLayer")
}

/// Anyone asks the judge of a paid job for the winning work, the judge (`run`) answers in delivery mode, and its stdout
/// goes back to the contract. Returns the judge's output, OutLayer's request and the `deliver` event.
pub async fn deliver_with<F>(w: &World, id: &str, run: F) -> Result<(Value, Value, Value)>
where
    F: FnOnce(Value) -> Value + Send + 'static,
{
    let (pending, index, request) = w.ask_delivery(&w.client, id).await?;
    let input: Value = serde_json::from_str(request["input"].as_str().context("input")?)?;
    ensure!(input["deliver"] == json!(true), "the judge is asked for a delivery: {input}");
    let out = tokio::task::spawn_blocking(move || run(input)).await?;
    let r = w.answer(pending, index, &serde_json::to_string(&out)?).await?;
    ensure!(r.is_success(), "the delivery's callback: {}", why(&r));
    let event = r
        .logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .find(|e| e["event"] == "deliver")
        .map(|e| e["data"].clone())
        .unwrap_or(Value::Null);
    Ok((out, request, event))
}

/// Balances of `ids`, in order.
pub async fn balances(w: &World, ids: &[&near_workspaces::AccountId]) -> Result<Vec<u128>> {
    let mut out = vec![];
    for id in ids {
        out.push(w.balance(id).await?);
    }
    Ok(out)
}

/// Builds the sandbox's work module, ONYX's sloppy version with `sloppy`, and returns its bytes.
pub fn work_module(sloppy: bool) -> Result<Vec<u8>> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("work");
    let target = dir.join("target").join(if sloppy { "sloppy" } else { "right" });
    let mut cmd = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cmd.current_dir(&dir)
        .env("CARGO_TARGET_DIR", &target)
        .env_remove("RUSTFLAGS")
        .args(["build", "--release", "--target", "wasm32-unknown-unknown"]);
    if sloppy {
        cmd.args(["--features", "sloppy"]);
    }
    ensure!(cmd.status().context("run cargo build")?.success(), "the work module did not build");
    Ok(std::fs::read(target.join("wasm32-unknown-unknown/release/account_check.wasm"))?)
}

/// The private test set of the sandbox's `tee_tests` job: is each input a valid NEAR account id?
pub fn account_tests() -> String {
    let cases: Vec<Value> = [
        ("nova.testnet", "yes"),
        ("a1", "yes"),
        ("maskwars_jobs.near", "yes"),
        ("0e6879a4be880000000000000000000000000000000000000000000000000000", "yes"),
        ("x", "no"),
        ("Nova.testnet", "no"),
        ("nova..testnet", "no"),
        (".nova", "no"),
        ("nova-", "no"),
        ("nova testnet", "no"),
        ("near_", "no"),
        ("a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-0-1-2-3-4-5-6", "no"),
    ]
    .iter()
    .map(|(i, e)| json!({ "input": i, "expect": e }))
    .collect();
    json!({ "format": "maskwars-tests/v1", "fuel": 20_000, "win_at": 10, "cases": cases }).to_string()
}
