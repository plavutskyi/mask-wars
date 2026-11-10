// Work sealed for the judge's key. Every revealed step of a `tee_tests` or `ai_review` job is a box only its judge
// opens, inside its TEE: the client, the other masks and the chain see ciphertext before the verdict and after it. The
// box is the step's content (938 characters on chain, the contract checks the form), sealed like a mask's strategy for
// its mind (services/brain), with the job's contract, the job and the mask as associated data: a box copied onto
// another mask or another job does not open. Only the winner's work ever leaves the TEE: once the job is paid, the
// judge seals it again for the client's key (`seal_delivery`). This file is shared: services/judge-review includes it.
//
// A box, `mw1.` and base64url (no padding) of:
//
//   eph_pub (32) || nonce (12) || AES-256-GCM(key, nonce, padded, aad) (640 + 16)
//   key    = HKDF-SHA256(ikm = X25519(eph, judge), salt = eph_pub || judge_pub, info = "maskwars:work:v1")
//   aad    = "maskwars:work:v1:<contract>:<job>:<mask>"
//   padded = 1 || module || 0x80 || 0x00…   (640 bytes, so a box says nothing about the module's size)
//
// The work rides in the box, so the whole work is on chain: nothing a mask names elsewhere can slow the judge or fail
// its run. The leading byte is the kind of what follows: 1 a Wasm module (`tee_tests`), 2 UTF-8 text (`ai_review`, a
// scout's finding, a verifier's check).
//
// The judge's X25519 key comes from a seed OutLayer generates inside the TEE (`PROTECTED_TESTS_SEED`,
// `PROTECTED_REVIEW_SEED`) and hands to every run of the judge project as its author's secret: nobody, the arena
// included, ever sees it. `{"action":"key"}` answers with the public half, and OutLayer signs that answer with the
// enclave's attestation; the jobs contract pins it with the judge's version. Test vector: vector.json.
//
// The delivery, the winner's work for the client: `mwd1.` and base64url of
//
//   eph_pub (32) || nonce (12) || AES-256-GCM(key, nonce, work, aad) (len + 16)
//   key = HKDF-SHA256(ikm = X25519(eph, client), salt = eph_pub || client_pub, info = "maskwars:delivery:v1")
//   aad = "maskwars:delivery:v1:<contract>:<job>:<client>"
//
// The ephemeral key and the nonce come from the judge's own secret, the job and the work's hash: unknown to anyone
// else, the same box for the same work, never one key for two works.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

pub use x25519_dalek::{PublicKey as JudgePublic, StaticSecret as JudgeSecret};

pub const PREFIX: &str = "mw1.";
pub const DELIVERY_PREFIX: &str = "mwd1.";
/// The kind byte of a box's content.
pub const MODULE: u8 = 1;
pub const TEXT: u8 = 2;
pub const PADDED: usize = 640;
pub const BOX_BYTES: usize = 32 + 12 + PADDED + 16;
/// The longest module or text a box carries inline: the kind byte and the end marker take two of the 640.
pub const MAX_INLINE: usize = PADDED - 2;
/// The `tee_tests` judge's key info; the `ai_review` judge has its own (services/judge-review).
pub const KEY_INFO: &[u8] = b"maskwars:judge-tests:x25519:v1";
const BOX_INFO: &[u8] = b"maskwars:work:v1";
const DELIVERY_INFO: &[u8] = b"maskwars:delivery:v1";

/// What a box holds.
#[derive(Debug, Clone, PartialEq)]
pub enum Work {
    Module(Vec<u8>),
    Text(String),
}

/// The `tee_tests` judge's X25519 key from the TEE's seed.
pub fn judge_secret(seed: &[u8; 32]) -> StaticSecret {
    judge_secret_for(seed, KEY_INFO)
}

/// A judge's X25519 key from the TEE's seed, under its own `info`.
pub fn judge_secret_for(seed: &[u8; 32], info: &[u8]) -> StaticSecret {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b"maskwars"), seed).expand(info, &mut out).expect("32 bytes is a valid length");
    StaticSecret::from(out)
}

/// `x25519:` and the public key in lowercase hex, as the judge publishes it.
pub fn key_text(public: &PublicKey) -> String {
    format!("x25519:{}", crate::job::hex(public.as_bytes()))
}

pub fn parse_key(text: &str) -> Result<PublicKey, String> {
    let bytes = crate::job::unhex(text.strip_prefix("x25519:").ok_or("a key is x25519:<hex>")?)?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| "a key is 32 bytes")?;
    Ok(PublicKey::from(bytes))
}

pub fn aad(contract: &str, job: &str, mask: &str) -> String {
    format!("maskwars:work:v1:{contract}:{job}:{mask}")
}

/// Seals a work module for the judge's key, for one mask on one job. `eph` and `nonce` must be fresh random bytes;
/// they are arguments so that a test vector pins the format.
pub fn seal(
    judge: &PublicKey,
    contract: &str,
    job: &str,
    mask: &str,
    module: &[u8],
    eph: [u8; 32],
    nonce: [u8; 12],
) -> Result<String, String> {
    seal_kind(judge, contract, job, mask, MODULE, module, eph, nonce)
}

/// Seals text for the judge's key: a review, a finding, a check. At most 638 bytes of UTF-8.
pub fn seal_text(
    judge: &PublicKey,
    contract: &str,
    job: &str,
    mask: &str,
    text: &str,
    eph: [u8; 32],
    nonce: [u8; 12],
) -> Result<String, String> {
    seal_kind(judge, contract, job, mask, TEXT, text.as_bytes(), eph, nonce)
}

#[allow(clippy::too_many_arguments)]
fn seal_kind(
    judge: &PublicKey,
    contract: &str,
    job: &str,
    mask: &str,
    kind: u8,
    payload: &[u8],
    eph: [u8; 32],
    nonce: [u8; 12],
) -> Result<String, String> {
    if payload.is_empty() || payload.len() > MAX_INLINE {
        return Err("a work is 1 to 638 bytes".into());
    }
    let mut padded = [&[kind][..], payload].concat();
    padded.push(0x80);
    padded.resize(PADDED, 0);
    let eph = StaticSecret::from(eph);
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(judge);
    if !shared.was_contributory() {
        return Err("not a usable key".into());
    }
    let sealed = cipher(shared.as_bytes(), eph_pub.as_bytes(), judge.as_bytes())
        .encrypt(&Nonce::from(nonce), Payload { msg: &padded, aad: aad(contract, job, mask).as_bytes() })
        .map_err(|_| "sealing failed")?;
    let mut out = Vec::with_capacity(BOX_BYTES);
    out.extend_from_slice(eph_pub.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(format!("{PREFIX}{}", b64url(&out)))
}

/// Opens a box sealed for this judge, this contract, this job and this mask: the work module. Runs only inside the
/// TEE. Whatever a box holds, opening it never panics: one mask's box cannot fail the judge's run.
pub fn open(judge: &StaticSecret, contract: &str, job: &str, mask: &str, text: &str) -> Result<Vec<u8>, String> {
    match open_work(judge, contract, job, mask, text)? {
        Work::Module(m) => Ok(m),
        Work::Text(_) => Err("the box holds no work module".into()),
    }
}

/// Opens a box sealed for this judge, this contract, this job and this mask: a module or text.
pub fn open_work(judge: &StaticSecret, contract: &str, job: &str, mask: &str, text: &str) -> Result<Work, String> {
    let bytes = unb64url(text.strip_prefix(PREFIX).ok_or("the work is not sealed for the judge")?)?;
    if bytes.len() != BOX_BYTES {
        return Err("a box has one size".into());
    }
    let eph_pub = PublicKey::from(<[u8; 32]>::try_from(&bytes[..32]).unwrap());
    let shared = judge.diffie_hellman(&eph_pub);
    if !shared.was_contributory() {
        return Err("not a usable key".into());
    }
    let judge_pub = PublicKey::from(judge);
    let nonce: [u8; 12] = bytes[32..44].try_into().unwrap();
    let padded = cipher(shared.as_bytes(), eph_pub.as_bytes(), judge_pub.as_bytes())
        .decrypt(&Nonce::from(nonce), Payload { msg: &bytes[44..], aad: aad(contract, job, mask).as_bytes() })
        .map_err(|_| "the box is not for this judge, job and mask")?;
    let end = padded.iter().rposition(|b| *b != 0).filter(|i| padded[*i] == 0x80).ok_or("bad padding")?;
    match (padded[0], padded.get(1..end)) {
        (MODULE, Some(module)) if !module.is_empty() => Ok(Work::Module(module.to_vec())),
        (TEXT, Some(text)) if !text.is_empty() => {
            String::from_utf8(text.to_vec()).map(Work::Text).map_err(|_| "the box's text is not UTF-8".into())
        }
        _ => Err("the box holds no work".into()),
    }
}

/// Seals the winner's work for the client's key, once the job is paid. The ephemeral key and the nonce come from the
/// judge's secret, the job and the work: nobody else can predict them, and a different work never shares a key.
pub fn seal_delivery(
    judge: &StaticSecret,
    client: &PublicKey,
    contract: &str,
    job: &str,
    client_account: &str,
    work: &[u8],
) -> Result<String, String> {
    let context = format!("{contract}:{job}:{client_account}:{}", crate::job::sha256_hex(work));
    let mut eph = [0u8; 32];
    let mut nonce = [0u8; 12];
    let hk = Hkdf::<Sha256>::new(Some(context.as_bytes()), judge.as_bytes());
    hk.expand(b"maskwars:delivery-eph:v1", &mut eph).expect("32 bytes is a valid length");
    hk.expand(b"maskwars:delivery-nonce:v1", &mut nonce).expect("12 bytes is a valid length");
    let eph = StaticSecret::from(eph);
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(client);
    if !shared.was_contributory() {
        return Err("the client's key is not a usable key".into());
    }
    let aad = format!("maskwars:delivery:v1:{contract}:{job}:{client_account}");
    let sealed = delivery_cipher(shared.as_bytes(), eph_pub.as_bytes(), client.as_bytes())
        .encrypt(&Nonce::from(nonce), Payload { msg: work, aad: aad.as_bytes() })
        .map_err(|_| "sealing failed")?;
    Ok(format!("{DELIVERY_PREFIX}{}", b64url(&[eph_pub.as_bytes().as_slice(), &nonce, &sealed].concat())))
}

/// Opens a delivery with the client's secret key: what the client's agent does.
pub fn open_delivery(client: &StaticSecret, contract: &str, job: &str, client_account: &str, text: &str) -> Result<Vec<u8>, String> {
    let bytes = unb64url(text.strip_prefix(DELIVERY_PREFIX).ok_or("not a delivery")?)?;
    if bytes.len() < 32 + 12 + 16 {
        return Err("a delivery is too short".into());
    }
    let eph_pub = PublicKey::from(<[u8; 32]>::try_from(&bytes[..32]).unwrap());
    let shared = client.diffie_hellman(&eph_pub);
    let nonce: [u8; 12] = bytes[32..44].try_into().unwrap();
    let aad = format!("maskwars:delivery:v1:{contract}:{job}:{client_account}");
    delivery_cipher(shared.as_bytes(), eph_pub.as_bytes(), PublicKey::from(client).as_bytes())
        .decrypt(&Nonce::from(nonce), Payload { msg: &bytes[44..], aad: aad.as_bytes() })
        .map_err(|_| "the delivery is not for this key, job and client".into())
}

fn delivery_cipher(shared: &[u8; 32], eph_pub: &[u8; 32], client_pub: &[u8; 32]) -> Aes256Gcm {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(eph_pub);
    salt[32..].copy_from_slice(client_pub);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared).expand(DELIVERY_INFO, &mut key).expect("32 bytes is a valid length");
    Aes256Gcm::new_from_slice(&key).expect("a 32-byte key")
}

fn cipher(shared: &[u8; 32], eph_pub: &[u8; 32], judge_pub: &[u8; 32]) -> Aes256Gcm {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(eph_pub);
    salt[32..].copy_from_slice(judge_pub);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared).expand(BOX_INFO, &mut key).expect("32 bytes is a valid length");
    Aes256Gcm::new_from_slice(&key).expect("a 32-byte key")
}

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..=chunk.len() {
            out.push(B64URL[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

pub fn unb64url(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in text.bytes() {
        let v = B64URL.iter().position(|b| *b == c).ok_or("not base64url")? as u32;
        acc = (acc << 6 | v) & 0xffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    if bits >= 6 || acc & ((1 << bits) - 1) != 0 {
        return Err("not base64url".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const SEED: [u8; 32] = [7; 32];
    const MODULE: &[u8] = b"\0asm\x01\0\0\0";

    fn judge() -> (StaticSecret, PublicKey) {
        let s = judge_secret(&SEED);
        let p = PublicKey::from(&s);
        (s, p)
    }

    #[test]
    fn a_box_opens_only_for_its_judge_job_and_mask() {
        let (s, p) = judge();
        let text = seal(&p, "jobs.testnet", "job-1", "nova.testnet", MODULE, [1; 32], [2; 12]).unwrap();
        assert!(text.len() <= 1024, "a box fits a step: {}", text.len());
        assert_eq!(open(&s, "jobs.testnet", "job-1", "nova.testnet", &text).unwrap(), MODULE);
        for (c, j, m) in [
            ("jobs.testnet", "job-1", "onyx.testnet"),
            ("jobs.testnet", "job-2", "nova.testnet"),
            ("mimic.testnet", "job-1", "nova.testnet"),
        ] {
            assert_eq!(open(&s, c, j, m, &text).unwrap_err(), "the box is not for this judge, job and mask");
        }
        let other = judge_secret(&[8; 32]);
        assert!(open(&other, "jobs.testnet", "job-1", "nova.testnet", &text).is_err());
        assert_eq!(
            open(&s, "jobs.testnet", "job-1", "nova.testnet", "review: ipfs://bafy").unwrap_err(),
            "the work is not sealed for the judge"
        );
    }

    /// A box sealed by hand, with whatever bytes a mask chooses inside.
    fn crafted(p: &PublicKey, padded: &[u8]) -> String {
        let eph = StaticSecret::from([5; 32]);
        let eph_pub = PublicKey::from(&eph);
        let shared = eph.diffie_hellman(p);
        let sealed = cipher(shared.as_bytes(), eph_pub.as_bytes(), p.as_bytes())
            .encrypt(&Nonce::from([6; 12]), Payload { msg: padded, aad: aad("jobs.testnet", "job-1", "nova.testnet").as_bytes() })
            .unwrap();
        format!("{PREFIX}{}", b64url(&[eph_pub.as_bytes().as_slice(), &[6; 12], &sealed].concat()))
    }

    #[test]
    fn no_box_a_mask_can_seal_makes_the_judge_panic() {
        let (s, p) = judge();
        let mut cases: Vec<Vec<u8>> = vec![vec![0; PADDED], vec![0x80], vec![1, 0x80], vec![3, 1, 2, 0x80], vec![0x80, 1]];
        // A text box whose bytes are not UTF-8 is no work either.
        cases.push(vec![2, 0xff, 0xfe, 0x80]);
        cases.push([vec![0x80], vec![0; PADDED - 1]].concat());
        for padded in cases {
            let mut full = padded.clone();
            full.resize(PADDED.max(padded.len()), 0);
            let text = crafted(&p, &full[..PADDED.min(full.len())]);
            assert!(open(&s, "jobs.testnet", "job-1", "nova.testnet", &text).is_err(), "{:?}", &padded[..padded.len().min(4)]);
        }
        let short = crafted(&p, &[1, 9, 0x80]);
        assert_eq!(open(&s, "jobs.testnet", "job-1", "nova.testnet", &short).unwrap_err(), "a box has one size");
    }

    #[test]
    fn a_text_box_opens_as_text_and_is_no_module() {
        let (s, p) = judge();
        let text = seal_text(&p, "jobs.testnet", "job-1", "nova.testnet", "review: section 4", [1; 32], [2; 12]).unwrap();
        let module = seal(&p, "jobs.testnet", "job-1", "nova.testnet", MODULE, [1; 32], [2; 12]).unwrap();
        assert_eq!(text.len(), module.len(), "a text box and a module box are the same size");
        assert_eq!(open_work(&s, "jobs.testnet", "job-1", "nova.testnet", &text).unwrap(), Work::Text("review: section 4".into()));
        assert_eq!(open(&s, "jobs.testnet", "job-1", "nova.testnet", &text).unwrap_err(), "the box holds no work module");
        assert!(seal_text(&p, "j.testnet", "a", "m.testnet", &"x".repeat(MAX_INLINE + 1), [3; 32], [4; 12]).is_err());
    }

    /// The winner's work for the client: only the client's key opens it, only for this job, and a different work
    /// never shares a key with it.
    #[test]
    fn a_delivery_opens_only_with_the_client_s_key() {
        let (s, _) = judge();
        let client = StaticSecret::from([0xc1; 32]);
        let client_pub = PublicKey::from(&client);
        let work = b"{\"work\":\"review: section 4\"}";
        let d = seal_delivery(&s, &client_pub, "jobs.testnet", "job-1", "dao.testnet", work).unwrap();
        assert!(d.starts_with(DELIVERY_PREFIX));
        assert_eq!(open_delivery(&client, "jobs.testnet", "job-1", "dao.testnet", &d).unwrap(), work);
        assert_eq!(d, seal_delivery(&s, &client_pub, "jobs.testnet", "job-1", "dao.testnet", work).unwrap(), "the same box");
        let other = StaticSecret::from([0x0e; 32]);
        assert!(open_delivery(&other, "jobs.testnet", "job-1", "dao.testnet", &d).is_err(), "nobody else opens it");
        assert!(open_delivery(&client, "jobs.testnet", "job-2", "dao.testnet", &d).is_err());
        let d2 = seal_delivery(&s, &client_pub, "jobs.testnet", "job-1", "dao.testnet", b"another work").unwrap();
        assert_ne!(d[5..48], d2[5..48], "another work, another ephemeral key");
    }

    #[test]
    fn every_box_has_one_size() {
        let (_, p) = judge();
        let small = seal(&p, "j.testnet", "a", "m.testnet", &[1], [3; 32], [4; 12]).unwrap();
        let big = seal(&p, "j.testnet", "a", "m.testnet", &[1; MAX_INLINE], [3; 32], [4; 12]).unwrap();
        assert_eq!(small.len(), big.len());
        assert!(seal(&p, "j.testnet", "a", "m.testnet", &[1; MAX_INLINE + 1], [3; 32], [4; 12]).is_err());
        assert!(seal(&p, "j.testnet", "a", "m.testnet", &[], [3; 32], [4; 12]).is_err());
    }

    /// The vector agents check their own sealing against: same seed, keys and nonce, same box.
    #[test]
    fn the_vector_holds() {
        let v: Value = serde_json::from_str(include_str!("../vector.json")).unwrap();
        let seed: [u8; 32] = crate::job::unhex(v["seed"].as_str().unwrap()).unwrap().try_into().unwrap();
        let public = PublicKey::from(&judge_secret(&seed));
        assert_eq!(key_text(&public), v["key"].as_str().unwrap());
        assert_eq!(parse_key(v["key"].as_str().unwrap()).unwrap(), public);
        let eph: [u8; 32] = crate::job::unhex(v["eph"].as_str().unwrap()).unwrap().try_into().unwrap();
        let nonce: [u8; 12] = crate::job::unhex(v["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
        let module = crate::job::unhex(v["module"].as_str().unwrap()).unwrap();
        let (c, j, m) = (v["contract"].as_str().unwrap(), v["job"].as_str().unwrap(), v["mask"].as_str().unwrap());
        let text = seal(&public, c, j, m, &module, eph, nonce).unwrap();
        assert_eq!(text, v["box"].as_str().unwrap());
        assert_eq!(open(&judge_secret(&seed), c, j, m, &text).unwrap(), module);
    }

    #[test]
    fn base64url_round_trips() {
        for n in 0..8 {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(unb64url(&b64url(&bytes)).unwrap(), bytes);
        }
        assert_eq!(b64url(b"\xfb\xff"), "-_8");
        assert!(unb64url("a").is_err() && unb64url("ab=").is_err() && unb64url("-_9").is_err());
    }
}
