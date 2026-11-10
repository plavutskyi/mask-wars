// The project's signature on a verdict: ed25519 (RFC 8032) over the UTF-8 bytes of a message the module wrote.
// The key is made from `PROTECTED_CHECK_SEED`, 32 bytes OutLayer generated inside the TEE and gives only to this
// project's runs. Anyone checks a signature against the public key alone; a run of `{"action":"about"}` returns that
// key, and the run's TEE attestation shows it came out of this code.

use crate::encode::{base58, base64, hex32};
use ed25519_dalek::{Signer as _, SigningKey};
use serde::Serialize;

pub struct Signer(SigningKey);

/// A signature as a verdict carries it.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Signed {
    pub alg: &'static str,
    /// `ed25519:` and the public key in base58, as NEAR writes keys.
    pub key: String,
    /// Exactly the bytes that were signed, as UTF-8.
    pub message: String,
    /// The 64-byte signature in base64.
    pub signature: String,
}

impl Signer {
    /// The key of a seed: 64 hex characters. Anything else is no key.
    pub fn from_seed(seed: &str) -> Option<Signer> {
        hex32(seed.trim()).map(|bytes| Signer(SigningKey::from_bytes(&bytes)))
    }

    pub fn public_key(&self) -> String {
        format!("ed25519:{}", base58(self.0.verifying_key().as_bytes()))
    }

    pub fn sign(&self, message: &str) -> Signed {
        let signature = self.0.sign(message.as_bytes());
        Signed { alg: "ed25519", key: self.public_key(), message: message.to_string(), signature: base64(&signature.to_bytes()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    /// RFC 8032, section 7.1, test 1: the seed, its public key and the signature of the empty message.
    const SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const PUBLIC: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const EMPTY_SIGNED: &str =
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn signs_as_rfc_8032_says() {
        let signer = Signer::from_seed(SEED).unwrap();
        assert_eq!(signer.public_key(), format!("ed25519:{}", base58(&bytes(PUBLIC))));
        assert_eq!(signer.sign("").signature, base64(&bytes(EMPTY_SIGNED)));
    }

    #[test]
    fn a_signature_verifies_against_the_public_key_alone() {
        let signer = Signer::from_seed(SEED).unwrap();
        let signed = signer.sign(r#"{"maskwars_check":1,"account":"intents.near","verdict":"allow"}"#);
        let key = VerifyingKey::from_bytes(&bytes(PUBLIC).try_into().unwrap()).unwrap();
        let signature = Signature::from_bytes(&signer.0.sign(signed.message.as_bytes()).to_bytes());
        assert_eq!(signed.signature, base64(&signature.to_bytes()));
        assert!(key.verify(signed.message.as_bytes(), &signature).is_ok());
        assert!(key.verify(signed.message.replace("allow", "block").as_bytes(), &signature).is_err());
    }

    #[test]
    fn a_seed_is_64_hex_characters_or_no_key() {
        assert!(Signer::from_seed(&format!(" {SEED}\n")).is_some());
        for bad in ["", "9d61", &"z".repeat(64), &format!("{SEED}00")] {
            assert!(Signer::from_seed(bad).is_none(), "{bad}");
        }
    }
}
