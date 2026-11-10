//! The mask's mind on OutLayer. A person may give their mask one line of strategy; the browser seals it for the
//! mind's key, the factory keeps only the sealed box, and the line opens only here, inside the TEE.
//!
//! The mind's key comes from `PROTECTED_BRAIN_SEED`, a secret OutLayer generates inside the TEE
//! (`outlayer secrets set --generate PROTECTED_BRAIN_SEED:hex32`): nobody, the arena included, ever sees it. The
//! module answers `{"action":"key"}` with the public half, and OutLayer signs that answer with the enclave's
//! attestation, so anyone can check the key the factory publishes came out of this code.
//!
//! A sealed box, `v1.` and base64url (no padding) of:
//!
//! ```text
//! eph_pub (32) || nonce (12) || AES-256-GCM(key, nonce, line || 0x80 || 0x00…, aad = mask account) (512 + 16)
//! key = HKDF-SHA256(ikm = X25519(eph, mind), salt = eph_pub || mind_pub, info = "maskwars:strategy:v1")
//! ```
//!
//! Every line pads to the same 512 bytes, so a box tells nothing about the line's length. The mask's account is the
//! associated data: a box copied onto another mask does not open.
//!
//! The mind at play (`{"action":"plan"}`, [`mind`]): for one attempt of a person's mask, asked by the keeper only, the
//! module reads the mask on chain, opens its strategy here, asks the mask's model on NEAR AI Cloud and hands back only
//! a plan the module writes itself: the calls a person's mask plays, in the order the model chose.

pub mod mind;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// The mind's keys, for code that seals or opens boxes (the factory's sandbox tests).
pub use x25519_dalek::{PublicKey as MindPublic, StaticSecret as MindSecret};

/// Bytes a strategy line pads to.
pub const PADDED: usize = 512;
/// A sealed box in bytes, and in text as the factory checks it.
pub const BOX_BYTES: usize = 32 + 12 + PADDED + 16;
pub const BOX_TEXT: usize = 3 + 763;
/// The longest line in characters; the padding holds up to 511 bytes of UTF-8.
pub const MAX_CHARS: usize = 160;
const KEY_INFO: &[u8] = b"maskwars:brain:x25519:v1";
const BOX_INFO: &[u8] = b"maskwars:strategy:v1";

/// The mind's X25519 key from the TEE's seed.
pub fn mind_secret(seed: &[u8; 32]) -> StaticSecret {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(b"maskwars"), seed)
        .expand(KEY_INFO, &mut out)
        .expect("32 bytes is a valid length");
    StaticSecret::from(out)
}

/// `x25519:` and the public key in lowercase hex, as the factory keeps it.
pub fn key_text(public: &PublicKey) -> String {
    format!("x25519:{}", hex(public.as_bytes()))
}

pub fn parse_key(text: &str) -> Result<PublicKey, String> {
    let bytes = unhex(
        text.strip_prefix("x25519:")
            .ok_or("a key is x25519:<hex>")?,
    )?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| "a key is 32 bytes")?;
    Ok(PublicKey::from(bytes))
}

/// One line: 1 to 160 characters, at most 511 bytes, no line breaks or other control characters.
pub fn line_ok(line: &str) -> bool {
    let chars = line.chars().count();
    (1..=MAX_CHARS).contains(&chars) && line.len() < PADDED && !line.chars().any(char::is_control)
}

/// Seals `line` for the mind's key and the mask's account. `eph` and `nonce` must be fresh random bytes; they are
/// arguments so that a test vector pins the format.
pub fn seal(
    mind: &PublicKey,
    mask: &str,
    line: &str,
    eph: [u8; 32],
    nonce: [u8; 12],
) -> Result<String, String> {
    if !line_ok(line) {
        return Err("a strategy is one line of 1 to 160 characters".into());
    }
    let eph = StaticSecret::from(eph);
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(mind);
    if !shared.was_contributory() {
        return Err("not a usable key".into());
    }
    let mut padded = line.as_bytes().to_vec();
    padded.push(0x80);
    padded.resize(PADDED, 0);
    let cipher = box_cipher(shared.as_bytes(), eph_pub.as_bytes(), mind.as_bytes());
    let sealed = cipher
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &padded,
                aad: mask.as_bytes(),
            },
        )
        .map_err(|_| "sealing failed")?;
    let mut out = Vec::with_capacity(BOX_BYTES);
    out.extend_from_slice(eph_pub.as_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(format!("v1.{}", base64url(&out)))
}

/// Opens a box sealed for this mind and this mask. Only ever runs inside the TEE: the line never leaves it.
pub fn open(mind: &StaticSecret, mask: &str, sealed: &str) -> Result<String, String> {
    let body = sealed.strip_prefix("v1.").ok_or("not a v1 box")?;
    let bytes = unbase64url(body)?;
    if bytes.len() != BOX_BYTES {
        return Err("a box has one size".into());
    }
    let eph_pub: [u8; 32] = bytes[..32].try_into().unwrap();
    let eph_pub = PublicKey::from(eph_pub);
    let shared = mind.diffie_hellman(&eph_pub);
    if !shared.was_contributory() {
        return Err("not a usable key".into());
    }
    let mind_pub = PublicKey::from(mind);
    let cipher = box_cipher(shared.as_bytes(), eph_pub.as_bytes(), mind_pub.as_bytes());
    let nonce: [u8; 12] = bytes[32..44].try_into().unwrap();
    let padded = cipher
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &bytes[44..],
                aad: mask.as_bytes(),
            },
        )
        .map_err(|_| "this box is not for this mind and this mask")?;
    let end = padded
        .iter()
        .rposition(|b| *b != 0)
        .filter(|i| padded[*i] == 0x80)
        .ok_or("bad padding")?;
    String::from_utf8(padded[..end].to_vec()).map_err(|_| "not text".into())
}

fn box_cipher(shared: &[u8; 32], eph_pub: &[u8; 32], mind_pub: &[u8; 32]) -> Aes256Gcm {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(eph_pub);
    salt[32..].copy_from_slice(mind_pub);
    let mut key = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared)
        .expand(BOX_INFO, &mut key)
        .expect("32 bytes is a valid length");
    Aes256Gcm::new_from_slice(&key).expect("a 32-byte key")
}

// ---------------------------------------------------------------------------------------------------------------------
// OutLayer
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Input {
    /// The mind's public key, for the factory to publish.
    Key,
    /// One attempt of a person's mask in a race: a plan, made here with the owner's strategy, or, for a copy, its
    /// author's. That is the only thing the mind does with a strategy: no action opens one for anyone.
    Plan(mind::PlanInput),
}

/// No chain and no model: for the `key` action, which needs neither.
pub struct Nowhere;

impl mind::Chain for Nowhere {
    fn rpc(&self, _: &str, _: Value) -> Result<Value, String> {
        Err("no chain here".into())
    }
}

impl mind::Llm for Nowhere {
    fn complete(&self, _: &str, _: &[Value], _: u32, _: f32) -> Result<mind::Reply, String> {
        Err("no model here".into())
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Output {
    pub success: bool,
    pub output: Value,
    pub error: Option<String>,
}

/// `seed` is `PROTECTED_BRAIN_SEED` in hex, as OutLayer hands the module its secret; `caller` is the run's signer
/// (`NEAR_SENDER_ID`: over HTTPS, the payment key's owner); `chain` is the worker's RPC and `llm` NEAR AI Cloud, both
/// reached from inside the TEE. Anyone may ask for the key; only the keeper for a plan.
pub fn handle(
    input: Input,
    seed: Option<&str>,
    caller: Option<&str>,
    chain: &dyn mind::Chain,
    llm: &dyn mind::Llm,
) -> Output {
    let Some(seed) = seed
        .and_then(|s| unhex(s).ok())
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
    else {
        return Output {
            success: false,
            output: Value::Null,
            error: Some("the mind has no seed in this TEE".into()),
        };
    };
    match input {
        Input::Key => {
            let public = PublicKey::from(&mind_secret(&seed));
            Output {
                success: true,
                output: json!({ "key": key_text(&public) }),
                error: None,
            }
        }
        Input::Plan(input) => match mind::play(&input, caller, &mind_secret(&seed), chain, llm) {
            Ok(played) => Output {
                success: true,
                output: serde_json::to_value(played).unwrap_or(Value::Null),
                error: None,
            },
            Err(e) => Output {
                success: false,
                output: Value::Null,
                error: Some(e),
            },
        },
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------------

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not hex".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "not hex".into()))
        .collect()
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding, as NEAR RPC takes a view call's arguments.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(B64_STD[(n >> (18 - 6 * i) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn base64url(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..chunk.len() + 1 {
            out.push(char::from(B64[(n >> (18 - 6 * i) & 63) as usize]));
        }
    }
    out
}

pub fn unbase64url(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in text.bytes() {
        let v = B64.iter().position(|b| *b == c).ok_or("not base64url")? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if acc != 0 {
        return Err("not base64url".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the format the browser seals with (`packages/forge`, which checks the same vector).
    #[derive(Deserialize)]
    struct Vector {
        seed: String,
        key: String,
        mask: String,
        line: String,
        eph: String,
        nonce: String,
        sealed: String,
    }

    fn vector() -> Vector {
        serde_json::from_str(include_str!("../vector.json")).unwrap()
    }

    fn seed() -> [u8; 32] {
        unhex(&vector().seed).unwrap().try_into().unwrap()
    }

    #[test]
    fn the_vector_seals_and_opens() {
        let v = vector();
        let mind = mind_secret(&seed());
        assert_eq!(key_text(&PublicKey::from(&mind)), v.key);
        let eph: [u8; 32] = unhex(&v.eph).unwrap().try_into().unwrap();
        let nonce: [u8; 12] = unhex(&v.nonce).unwrap().try_into().unwrap();
        let sealed = seal(&parse_key(&v.key).unwrap(), &v.mask, &v.line, eph, nonce).unwrap();
        assert_eq!(sealed, v.sealed);
        assert_eq!(sealed.len(), BOX_TEXT);
        assert_eq!(open(&mind, &v.mask, &sealed).unwrap(), v.line);
    }

    #[test]
    fn a_box_opens_only_for_its_mask() {
        let v = vector();
        let err = open(
            &mind_secret(&seed()),
            "lena.masks.tinygif8324.testnet",
            &v.sealed,
        )
        .unwrap_err();
        assert!(err.contains("not for this mind and this mask"), "{err}");
    }

    #[test]
    fn a_box_opens_only_for_its_mind() {
        let v = vector();
        assert!(open(&mind_secret(&[9; 32]), &v.mask, &v.sealed).is_err());
    }

    #[test]
    fn a_touched_box_does_not_open() {
        let v = vector();
        let mut bytes = unbase64url(&v.sealed[3..]).unwrap();
        bytes[100] ^= 1;
        let touched = format!("v1.{}", base64url(&bytes));
        assert!(open(&mind_secret(&seed()), &v.mask, &touched).is_err());
    }

    #[test]
    fn every_box_has_the_same_size() {
        let mind = PublicKey::from(&mind_secret(&seed()));
        let short = seal(&mind, "kira.masks.near", "a", [1; 32], [2; 12]).unwrap();
        let long = seal(&mind, "kira.masks.near", &"я".repeat(160), [1; 32], [2; 12]).unwrap();
        assert_eq!((short.len(), long.len()), (BOX_TEXT, BOX_TEXT));
        assert_eq!(
            open(&mind_secret(&seed()), "kira.masks.near", &long).unwrap(),
            "я".repeat(160)
        );
    }

    #[test]
    fn a_strategy_is_one_line() {
        assert!(line_ok("Wait for the window, then take everything."));
        assert!(!line_ok("") && !line_ok("two\nlines") && !line_ok(&"x".repeat(161)));
        let mind = PublicKey::from(&mind_secret(&seed()));
        assert!(seal(&mind, "kira.masks.near", "two\nlines", [1; 32], [2; 12]).is_err());
    }

    #[test]
    fn the_module_tells_its_key_and_nothing_else() {
        let v = vector();
        let out = handle(Input::Key, Some(&v.seed), None, &Nowhere, &Nowhere);
        assert_eq!(
            out,
            Output {
                success: true,
                output: json!({ "key": v.key }),
                error: None
            }
        );
        assert!(!serde_json::to_string(&out).unwrap().contains(&v.seed));
        let none = handle(Input::Key, None, None, &Nowhere, &Nowhere);
        assert_eq!(
            (none.success, none.error.as_deref()),
            (false, Some("the mind has no seed in this TEE"))
        );
    }

    /// Review findings 1 and 2, the attack: BOB, who owns a copy of KIRA, had the keeper ask the mind to `view` his
    /// copy, and the mind opened KIRA's strategy and sealed it for a key BOB chose. The mind has no such action now:
    /// an input asking to view, reveal or open a strategy is not one the module reads, and OutLayer gets only
    /// `bad input` back. The one thing the mind does with a strategy is play it (`plan`), and a plan's answer never
    /// carries it (the mind's tests).
    #[test]
    fn the_mind_opens_a_strategy_for_no_one() {
        for asked in [
            r#"{"action":"view","mask":"nina.masks.tinygif8324.testnet","viewer":"bob.testnet"}"#,
            r#"{"action":"reveal","mask":"kira.masks.tinygif8324.testnet","viewer":"bob.testnet"}"#,
            r#"{"action":"open","mask":"kira.masks.tinygif8324.testnet"}"#,
            r#"{"action":"strategy","mask":"kira.masks.tinygif8324.testnet"}"#,
        ] {
            assert!(serde_json::from_str::<Input>(asked).is_err(), "{asked}");
        }
        assert!(matches!(
            serde_json::from_str::<Input>(r#"{"action":"key"}"#),
            Ok(Input::Key)
        ));
    }

    #[test]
    fn base64url_round_trips() {
        for n in 0..10 {
            let bytes: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(unbase64url(&base64url(&bytes)).unwrap(), bytes);
        }
        assert_eq!(base64url(b"\xfb\xff"), "-_8");
    }
}

/// Prints the test vector `vector.json` is made from: `cargo test -- --ignored print_vector --nocapture`.
#[cfg(test)]
mod vector_maker {
    use super::*;

    #[test]
    #[ignore]
    fn print_vector() {
        let seed: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(7).wrapping_add(3));
        let eph: [u8; 32] = std::array::from_fn(|i| (i as u8).wrapping_mul(13).wrapping_add(66));
        let nonce: [u8; 12] = std::array::from_fn(|i| (i as u8).wrapping_mul(29).wrapping_add(5));
        let mask = "kira.masks.tinygif8324.testnet";
        let line = "Wait for the window. Then take it all, тихо.";
        let mind = PublicKey::from(&mind_secret(&seed));
        let sealed = seal(&mind, mask, line, eph, nonce).unwrap();
        let v = json!({ "seed": hex(&seed), "key": key_text(&mind), "mask": mask, "line": line,
                        "eph": hex(&eph), "nonce": hex(&nonce), "sealed": sealed });
        println!("{}", serde_json::to_string_pretty(&v).unwrap());
    }
}
