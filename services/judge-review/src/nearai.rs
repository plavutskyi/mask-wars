// NEAR AI Cloud from inside the judge's TEE, over TLS to cloud-api.near.ai: one chat completion on a model in NEAR
// AI's Confidential TEE, then the signature the model's TEE made over the exact bytes, checked here (as packages/mind
// does):
//
//   signed text = "<model>:<sha256(request body)>:<sha256(response body)>", EIP-191, secp256k1
//
// The answer counts only with a consistent signature: one that commits to this model, this request and this response,
// recovers to the address it names, and that NEAR AI marks `provider_tee`. That the address is an attested NEAR AI TEE
// node the judge does not check: the module pins no list of addresses, which NEAR AI rotates. The verdict carries the
// signer, and anyone checks it against NEAR AI's attestation report (`pnpm --filter @maskwars/mind
// verify:attestation`). The judge itself only asks NEAR AI over TLS, which is what the signature is worth inside it.

use crate::job::sha256_hex;
use serde_json::Value;

pub const BASE_URL: &str = "https://cloud-api.near.ai/v1";
/// The signature is kept on the TEE node that answered; a lookup can land on another and miss for a moment.
const SIGNATURE_TRIES: u32 = 6;
const SIGNATURE_PAUSE_MS: u64 = 700;

/// HTTPS as the judge reaches it. `Err` only when no HTTP answer came.
pub trait Transport {
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<(u16, String), String>;
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<(u16, String), String>;
    fn pause(&self, ms: u64);
}

/// One answered call, with what proves it.
#[derive(Debug, Clone, PartialEq)]
pub struct Called {
    pub request: String,
    pub response: String,
    /// The model's answer text: `choices[0].message.content`.
    pub content: String,
    pub chat: String,
    pub signature: String,
    /// The address recovered from the signature, `0x…`, lowercase.
    pub signer: String,
}

impl Called {
    pub fn request_sha256(&self) -> String {
        sha256_hex(self.request.as_bytes())
    }
    pub fn response_sha256(&self) -> String {
        sha256_hex(self.response.as_bytes())
    }
}

/// Why a call gave no answer the judge can check.
#[derive(Debug, Clone, PartialEq)]
pub enum AskError {
    /// The request or the answer is the work's doing: NEAR AI refused the request itself (400, 413, 422: too long, not
    /// a request it takes), the token limit cut the answer (`finish_reason: length`), or it gave no message. The seed is
    /// refused at once: work that breaks its call breaks only its own.
    Refused(String),
    /// No answer came, and not by the work's doing: the network, a timeout, a rate limit (429), NEAR AI down (5xx) or
    /// our key (401, 402, 403), its signature. The seed is not spent: it is asked again, later by the chain's clock.
    Failed(String),
}

/// Whether NEAR AI refused the request itself, for what the request holds: the work's doing, so the seed is spent.
/// Every other status is NEAR AI's or the judge's own trouble, and asked again later.
pub fn refused_status(status: u16) -> bool {
    matches!(status, 400 | 413 | 422)
}

impl std::fmt::Display for AskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AskError::Refused(e) | AskError::Failed(e) => f.write_str(e),
        }
    }
}

impl From<String> for AskError {
    fn from(e: String) -> Self {
        AskError::Failed(e)
    }
}

impl From<&str> for AskError {
    fn from(e: &str) -> Self {
        AskError::Failed(e.to_string())
    }
}

/// A model the judge asks. The NEAR AI client in production; recorded answers in the tests.
pub trait Model {
    fn ask(&self, request: &str) -> Result<Called, AskError>;
}

pub struct NearAi<'a> {
    pub http: &'a dyn Transport,
    pub key: &'a str,
    pub model: &'a str,
}

impl Model for NearAi<'_> {
    fn ask(&self, request: &str) -> Result<Called, AskError> {
        let auth = format!("Bearer {}", self.key);
        let headers = [
            ("accept", "application/json"),
            ("content-type", "application/json"),
            ("authorization", auth.as_str()),
            // A canonical model id and no aliasing: an alias would change who signs the answer.
            ("x-no-aliasing", "true"),
            ("user-agent", "maskwars-judge-review"),
        ];
        let (status, response) = self.http.post(&format!("{BASE_URL}/chat/completions"), &headers, request)?;
        if refused_status(status) {
            return Err(AskError::Refused(format!("NEAR AI refused the request: {status}")));
        }
        if status != 200 {
            return Err(AskError::Failed(format!("NEAR AI answered {status}")));
        }
        let parsed: Value = serde_json::from_str(&response).map_err(|_| "NEAR AI's answer is not JSON".to_string())?;
        if parsed.get("model").and_then(Value::as_str) != Some(self.model) {
            return Err("NEAR AI answered with another model".into());
        }
        // An answer the token limit cut is not the model's whole answer: a refusal, not a failure.
        match parsed.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
            Some("stop") => {}
            other => {
                return Err(AskError::Refused(format!(
                    "the model's answer did not finish: {}",
                    other.unwrap_or("no finish_reason")
                )))
            }
        }
        let content = parsed
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| AskError::Refused("NEAR AI's answer has no message".into()))?
            .to_string();
        let chat = parsed.get("id").and_then(Value::as_str).ok_or("NEAR AI's answer has no id")?.to_string();
        let url = format!("{BASE_URL}/signature/{chat}?model={}&signing_algo=ecdsa", self.model.replace('/', "%2F"));
        let mut tries = 0;
        let signed: Value = loop {
            tries += 1;
            match self.http.get(&url, &headers)? {
                (200, body) => break serde_json::from_str(&body).map_err(|_| "the signature is not JSON".to_string())?,
                (404, _) if tries < SIGNATURE_TRIES => self.http.pause(SIGNATURE_PAUSE_MS),
                (status, _) => return Err(AskError::Failed(format!("NEAR AI gave no signature: {status}"))),
            }
        };
        let text = signed.get("text").and_then(Value::as_str).ok_or("the signature has no text")?;
        let signature = signed.get("signature").and_then(Value::as_str).ok_or("the signature is empty")?;
        let expected = format!("{}:{}:{}", self.model, sha256_hex(request.as_bytes()), sha256_hex(response.as_bytes()));
        if text != expected {
            return Err("the signature is not over this model, request and response".into());
        }
        if signed.get("signature_kind").and_then(Value::as_str) != Some("provider_tee") {
            return Err("NEAR AI does not say the model's TEE signed the answer".into());
        }
        let signer = recover(text, signature)?;
        let named = signed.get("signing_address").and_then(Value::as_str).unwrap_or_default();
        if named.to_ascii_lowercase() != signer {
            return Err("the signature is not from the address it names".into());
        }
        Ok(Called { request: request.to_string(), response, content, chat, signature: signature.to_string(), signer })
    }
}

/// The Ethereum address that signed `text` (EIP-191 personal message), `0x…` lowercase.
pub fn recover(text: &str, signature: &str) -> Result<String, String> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    use sha3::{Digest, Keccak256};
    let bytes = crate::job::unhex(signature.trim_start_matches("0x")).map_err(|_| "the signature is not hex")?;
    if bytes.len() != 65 {
        return Err("a signature is 65 bytes".into());
    }
    let sig = Signature::from_slice(&bytes[..64]).map_err(|_| "not a signature")?;
    let v = match bytes[64] {
        27 | 28 => bytes[64] - 27,
        0 | 1 => bytes[64],
        _ => return Err("bad recovery id".into()),
    };
    let id = RecoveryId::from_byte(v).ok_or("bad recovery id")?;
    let digest = Keccak256::new_with_prefix(format!("\x19Ethereum Signed Message:\n{}", text.len()).as_bytes())
        .chain_update(text.as_bytes())
        .finalize();
    let key = VerifyingKey::recover_from_prehash(&digest, &sig, id).map_err(|_| "the signature recovers no key")?;
    let point = key.to_encoded_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    Ok(format!("0x{}", crate::job::hex(&hash[12..])))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;
    use sha3::{Digest, Keccak256};
    use std::cell::RefCell;

    /// A stand-in for a model TEE's key: answers here are signed by the tests, not by NEAR AI.
    pub fn tee_key() -> SigningKey {
        SigningKey::from_slice(&[0x42; 32]).unwrap()
    }

    pub fn address(key: &SigningKey) -> String {
        let point = key.verifying_key().to_encoded_point(false);
        format!("0x{}", crate::job::hex(&Keccak256::digest(&point.as_bytes()[1..])[12..]))
    }

    pub fn sign(key: &SigningKey, text: &str) -> String {
        let digest = Keccak256::new_with_prefix(format!("\x19Ethereum Signed Message:\n{}", text.len()).as_bytes())
            .chain_update(text.as_bytes());
        let (sig, id) = key.sign_digest_recoverable(digest).unwrap();
        format!("0x{}{:02x}", crate::job::hex(&sig.to_bytes()), id.to_byte() + 27)
    }

    #[test]
    fn a_signature_recovers_its_signer() {
        // A known EIP-191 vector: the key 0x4c08…f54d signs "hello" (eth_account, web3.js docs).
        let key = SigningKey::from_slice(&crate::job::unhex("4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318").unwrap()).unwrap();
        assert_eq!(address(&key), "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
        let sig = sign(&key, "hello");
        assert_eq!(recover("hello", &sig).unwrap(), "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
        assert_ne!(recover("hullo", &sig).unwrap(), "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
        assert!(recover("hello", "0x1234").is_err());
    }

    /// NEAR AI as recorded in fixtures/: the completion and the signature endpoint, in their documented shapes.
    pub struct Recorded {
        pub completion: String,
        pub signature: RefCell<Vec<(u16, String)>>,
        pub asked: RefCell<Vec<String>>,
    }

    impl Transport for Recorded {
        fn post(&self, url: &str, headers: &[(&str, &str)], body: &str) -> Result<(u16, String), String> {
            assert!(headers.contains(&("x-no-aliasing", "true")) && headers.iter().any(|(k, v)| *k == "authorization" && v.starts_with("Bearer ")));
            self.asked.borrow_mut().push(format!("POST {url} {}", body.len()));
            Ok((200, self.completion.clone()))
        }
        fn get(&self, url: &str, _: &[(&str, &str)]) -> Result<(u16, String), String> {
            self.asked.borrow_mut().push(format!("GET {url}"));
            Ok(self.signature.borrow_mut().remove(0))
        }
        fn pause(&self, _: u64) {}
    }

    fn fixture(model: &str, content: &str, request: &str) -> (String, String) {
        let quoted = serde_json::to_string(content).unwrap();
        let completion = include_str!("../fixtures/completion.json")
            .replace("{MODEL}", model)
            .replace("{CONTENT}", &quoted[1..quoted.len() - 1]);
        let text = format!("{model}:{}:{}", sha256_hex(request.as_bytes()), sha256_hex(completion.as_bytes()));
        let key = tee_key();
        let signature = include_str!("../fixtures/signature.json")
            .replace("{TEXT}", &text)
            .replace("{SIGNATURE}", &sign(&key, &text))
            .replace("{ADDRESS}", &address(&key));
        (completion, signature)
    }

    const MODEL: &str = crate::prompt::MODEL;

    #[test]
    fn an_answer_counts_with_the_tee_signature_over_its_exact_bytes() {
        let request = crate::prompt::request("{}", 1);
        let (completion, signature) = fixture(MODEL, "{\"winner\":null}", &request);
        let http = Recorded { completion, signature: RefCell::new(vec![(404, String::new()), (200, signature)]), asked: RefCell::new(vec![]) };
        let called = NearAi { http: &http, key: "test", model: MODEL }.ask(&request).unwrap();
        assert_eq!(called.content, "{\"winner\":null}");
        assert_eq!(called.signer, address(&tee_key()));
        assert_eq!(called.request_sha256(), sha256_hex(request.as_bytes()));
        let asked = http.asked.borrow();
        assert_eq!(asked[0], format!("POST https://cloud-api.near.ai/v1/chat/completions {}", request.len()));
        assert!(asked[1].starts_with("GET https://cloud-api.near.ai/v1/signature/chatcmpl-"), "{}", asked[1]);
        assert!(asked[1].ends_with("?model=deepseek-ai%2FDeepSeek-V4.1-Flash-1017&signing_algo=ecdsa"));
        assert_eq!(asked.len(), 3, "a missed signature lookup is asked again");
    }

    /// Third review, finding 4: a rate limit (429), NEAR AI down or a timeout is a failure, which spends no seed: the
    /// judge asks again later. Only NEAR AI refusing the request itself, for what it holds, refuses the seed.
    #[test]
    fn a_rate_limit_or_an_outage_fails_and_only_a_refused_request_refuses() {
        struct Answers(u16);
        impl Transport for Answers {
            fn post(&self, _: &str, _: &[(&str, &str)], _: &str) -> Result<(u16, String), String> {
                Ok((self.0, "{\"error\":\"x\"}".into()))
            }
            fn get(&self, _: &str, _: &[(&str, &str)]) -> Result<(u16, String), String> {
                unreachable!("no signature without an answer")
            }
            fn pause(&self, _: u64) {}
        }
        struct Down;
        impl Transport for Down {
            fn post(&self, _: &str, _: &[(&str, &str)], _: &str) -> Result<(u16, String), String> {
                Err("timed out".into())
            }
            fn get(&self, _: &str, _: &[(&str, &str)]) -> Result<(u16, String), String> {
                Err("timed out".into())
            }
            fn pause(&self, _: u64) {}
        }
        let request = crate::prompt::request("{}", 1);
        for status in [429, 500, 502, 503, 504, 401, 402, 403, 404, 408] {
            let r = NearAi { http: &Answers(status), key: "test", model: MODEL }.ask(&request);
            assert_eq!(r.unwrap_err(), AskError::Failed(format!("NEAR AI answered {status}")), "{status}");
        }
        for status in [400, 413, 422] {
            let r = NearAi { http: &Answers(status), key: "test", model: MODEL }.ask(&request);
            assert_eq!(r.unwrap_err(), AskError::Refused(format!("NEAR AI refused the request: {status}")));
        }
        assert!(matches!(NearAi { http: &Down, key: "test", model: MODEL }.ask(&request), Err(AskError::Failed(_))));
    }

    #[test]
    fn an_answer_whose_signature_does_not_match_is_refused() {
        let request = crate::prompt::request("{}", 1);
        let (completion, signature) = fixture(MODEL, "{}", &request);
        let ask = |completion: String, signature: String| {
            let http = Recorded { completion, signature: RefCell::new(vec![(200, signature)]), asked: RefCell::new(vec![]) };
            NearAi { http: &http, key: "test", model: MODEL }.ask(&request).unwrap_err().to_string()
        };
        // The response was changed after it was signed.
        assert_eq!(ask(completion.replace("{}", "{ }"), signature.clone()), "the signature is not over this model, request and response");
        // Another model answered.
        let (other, sig) = fixture("z-ai/glm-5.3-flash", "{}", &request);
        assert_eq!(ask(other, sig), "NEAR AI answered with another model");
        // The signature names an address that did not make it.
        let forged = signature.replace(&address(&tee_key())[2..], &"ab".repeat(20));
        assert_eq!(ask(completion.clone(), forged), "the signature is not from the address it names");
        // The gateway signed it, not the model's TEE.
        let gateway = signature.replace("\"provider_tee\"", "\"gateway\"");
        assert_eq!(ask(completion.clone(), gateway), "NEAR AI does not say the model's TEE signed the answer");
        // Finding 3 of the second review: an answer the token limit cut is a refusal of the seed, not a failure to ask
        // again: work that makes the model ramble breaks only its own call.
        let cut = completion.replace("\"finish_reason\":\"stop\"", "\"finish_reason\":\"length\"");
        let http = Recorded { completion: cut, signature: RefCell::new(vec![(200, signature)]), asked: RefCell::new(vec![]) };
        assert_eq!(
            NearAi { http: &http, key: "test", model: MODEL }.ask(&request).unwrap_err(),
            AskError::Refused("the model's answer did not finish: length".into())
        );
    }
}
