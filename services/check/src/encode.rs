// The three encodings the module writes and reads: base64 (view-call arguments, signatures), base58 (NEAR's public
// keys and hashes) and hex (the signing seed).

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Standard base64, padded.
pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Base58 in Bitcoin's alphabet, as NEAR writes keys and hashes.
pub fn base58(bytes: &[u8]) -> String {
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    // Digits in base 58, least significant first.
    let mut digits: Vec<u8> = vec![];
    for byte in &bytes[zeros..] {
        let mut carry = u32::from(*byte);
        for d in digits.iter_mut() {
            carry += u32::from(*d) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = "1".repeat(zeros);
    out.extend(digits.iter().rev().map(|d| B58[*d as usize] as char));
    out
}

/// Whether `s` is base58 of about 32 bytes: a NEAR transaction or block hash.
pub fn hash_ok(s: &str) -> bool {
    (32..=44).contains(&s.len()) && s.bytes().all(|c| B58.contains(&c))
}

/// Exactly 32 bytes from 64 hex characters, either case.
pub fn hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.as_bytes();
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, pair) in s.chunks(2).enumerate() {
        let digit = |c: u8| (c as char).to_digit(16);
        out[i] = (digit(pair[0])? * 16 + digit(pair[1])?) as u8;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_as_everyone_writes_it() {
        for (plain, coded) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("{}", "e30="),
            (r#"{"id":"race-0003"}"#, "eyJpZCI6InJhY2UtMDAwMyJ9"),
        ] {
            assert_eq!(base64(plain.as_bytes()), coded);
        }
        assert_eq!(base64(&[0xfb, 0xff, 0xfe]), "+//+");
    }

    #[test]
    fn base58_as_near_writes_it() {
        assert_eq!(base58(&[0u8; 32]), "11111111111111111111111111111111");
        assert_eq!(base58(b"Hello World!"), "2NEpo7TZRRrLZSi2U");
        assert_eq!(base58(&[0, 0, 1]), "112");
        assert!(hash_ok("2oJxC9Sf5iFU9Nj4rHQneWw6VTHXfneHyTg1Mm85ogw4") && !hash_ok("0OIl") && !hash_ok("short"));
    }

    #[test]
    fn hex_of_a_seed() {
        assert_eq!(hex32(&"0f".repeat(32)), Some([15u8; 32]));
        assert_eq!(hex32(&"0F".repeat(32)), Some([15u8; 32]));
        assert_eq!(hex32("0f"), None);
        assert_eq!(hex32(&"zz".repeat(32)), None);
    }
}
