//! The `ai_review` judge against the real jobs contract in a local NEAR sandbox, on the world of the jobs contract's sandbox
//! (`jobs-sandbox`) and the helpers of `services/judge-tests/sandbox`. The judge library runs over the sandbox's RPC
//! and its stdout goes back to the contract as the judge run's result.
//!
//! NEAR AI is not reachable from where these tests were written: the model's answers here are written by the tests
//! and signed by a test key standing in for a model TEE's key (`Recorded`). Everything else is the judge's own code.
//! The live run against NEAR AI is in the README.

use job_judges_sandbox::SandboxRpc;
use k256::ecdsa::SigningKey;
use maskwars_judge_review::job::{Caller, Chain};
use maskwars_judge_review::nearai::{AskError, Called, Model};
use maskwars_judge_review::{prompt, sealed, Clock, KEY_INFO};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use std::sync::Mutex;

pub use job_judges_sandbox::REVIEW_PROJECT;
use maskwars_judge_review::Keep;
use std::collections::BTreeMap;

/// The review judge project's storage on OutLayer, in memory, kept from run to run: public and private keys apart.
#[derive(Default)]
pub struct Kept(pub Mutex<BTreeMap<(bool, String), Vec<u8>>>);

impl Keep for Kept {
    fn keep(&self, key: &str, value: &[u8], public: bool) -> Result<(), String> {
        self.0.lock().unwrap().insert((public, key.to_string()), value.to_vec());
        Ok(())
    }
    fn load(&self, key: &str, public: bool) -> Result<Option<Vec<u8>>, String> {
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

    pub fn private(&self, key: &str) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(&(false, key.to_string())).cloned()
    }
}

/// The judge's TEE seed in the sandbox. On OutLayer it is generated inside the TEE and nobody sees it.
pub const SEED: &str = "be5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5e";

/// The review judge's key, as the jobs contract pins it (`REVIEW_KEY`).
pub fn judge_key() -> sealed::JudgePublic {
    let seed: [u8; 32] = maskwars_judge_review::job::unhex(SEED).unwrap().try_into().unwrap();
    sealed::JudgePublic::from(&sealed::judge_secret_for(&seed, KEY_INFO))
}

/// Text a mask (or the client, for its reference review) seals for the judge's key, as its agent does.
pub fn sealed_text(w: &jobs_sandbox::World, mask: &str, job: &str, text: &str, salt: u8) -> String {
    sealed::seal_text(&judge_key(), w.jobs.as_str(), job, mask, text, [salt; 32], [salt; 12]).unwrap()
}

/// The sandbox node as the review judge reads it.
pub struct Rpc(pub SandboxRpc);

impl Chain for Rpc {
    fn name(&self) -> &str {
        job_judges_sandbox::Chain::name(&self.0)
    }
    fn rpc(&self, method: &str, params: Value) -> Result<String, String> {
        self.0.call(method, params)
    }
}

/// What OutLayer tells the review judge about a run, and the contract it serves: the sandbox's jobs contract.
pub fn caller(w: &jobs_sandbox::World) -> Caller {
    Caller {
        predecessor: Some(w.jobs.to_string()),
        project: Some(REVIEW_PROJECT.to_string()),
        served: vec![w.jobs.to_string()],
    }
}

/// A model whose answers the test wrote, signed by a test key the way a model TEE signs NEAR AI answers:
/// `model:sha256(request):sha256(response)`. Each call is about one entrant: it answers from the script whose needle
/// the call's data holds, in order. It checks that the request is the judge's: the module's instructions word for
/// word, the material as one JSON object in the user message. Out of answers, it fails as NEAR AI that cannot be
/// reached.
pub struct Recorded {
    pub scripts: Mutex<Vec<Script>>,
    pub requests: Mutex<Vec<String>>,
}

/// One entrant's script: the text its calls hold, and the answers to give them in order.
pub type Script = (&'static str, Vec<Result<String, AskError>>);

impl Recorded {
    pub fn new(scripts: Vec<Script>) -> Self {
        Recorded { scripts: Mutex::new(scripts), requests: Mutex::new(vec![]) }
    }

    /// The data of every request whose data holds `needle`.
    pub fn asked(&self, needle: &str) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| serde_json::from_str::<Value>(r).unwrap()["messages"][1]["content"].as_str().unwrap().to_string())
            .filter(|d| d.contains(needle))
            .map(|d| serde_json::from_str(&d).unwrap())
            .collect()
    }
}

fn key() -> SigningKey {
    SigningKey::from_slice(&[0x42; 32]).unwrap()
}

/// The test key's address, as a verdict names its signer.
pub fn signer() -> String {
    let point = key().verifying_key().to_encoded_point(false);
    format!("0x{}", hex(&Keccak256::digest(&point.as_bytes()[1..])[12..]))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn sha(b: &[u8]) -> String {
    maskwars_judge_review::job::sha256_hex(b)
}

impl Model for Recorded {
    fn ask(&self, request: &str) -> Result<Called, AskError> {
        let r: Value = serde_json::from_str(request).map_err(|_| AskError::Failed("not JSON".into()))?;
        assert_eq!(r["messages"][0]["content"], prompt::SYSTEM, "the instructions are the module's");
        let data = r["messages"][1]["content"].as_str().unwrap().to_string();
        assert!(serde_json::from_str::<Value>(&data).is_ok());
        self.requests.lock().unwrap().push(request.to_string());
        let content = {
            let mut scripts = self.scripts.lock().unwrap();
            match scripts.iter_mut().find(|(needle, _)| data.contains(needle)) {
                Some((_, answers)) if !answers.is_empty() => answers.remove(0),
                _ => Err(AskError::Failed("NEAR AI is unreachable".into())),
            }
        }?;
        let n = self.requests.lock().unwrap().len();
        let response = json!({ "id": format!("chatcmpl-sandbox-{n}"), "object": "chat.completion", "model": prompt::MODEL,
                               "choices": [{ "index": 0, "message": { "role": "assistant", "content": content }, "finish_reason": "stop" }] })
        .to_string();
        let text = format!("{}:{}:{}", prompt::MODEL, sha(request.as_bytes()), sha(response.as_bytes()));
        let digest = Keccak256::new_with_prefix(format!("\x19Ethereum Signed Message:\n{}", text.len()).as_bytes())
            .chain_update(text.as_bytes());
        let (sig, id) = key().sign_digest_recoverable(digest).unwrap();
        let signature = format!("0x{}{:02x}", hex(&sig.to_bytes()), id.to_byte() + 27);
        Ok(Called { request: request.to_string(), response, content, chat: "chatcmpl-sandbox".into(), signature, signer: signer() })
    }
}

/// A run's clock that never runs short: the sandbox has no 60-second limit.
pub struct NoRush;

impl Clock for NoRush {
    fn ms(&self) -> u64 {
        0
    }
}

/// A run with time for one model call: the reading took 10 seconds, and a call may take 35 of the 55 a run has.
pub struct OneCall(pub std::sync::atomic::AtomicU64);

impl OneCall {
    pub fn new() -> Self {
        OneCall(std::sync::atomic::AtomicU64::new(10_000))
    }
}

impl Default for OneCall {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for OneCall {
    fn ms(&self) -> u64 {
        self.0.fetch_add(45_000, std::sync::atomic::Ordering::SeqCst)
    }
}
