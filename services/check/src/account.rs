// NEAR account ids, by the same rules as packages/check/src/account.ts.

/// 2 to 64 characters, lowercase parts split by `.`; inside a part, letters and digits joined by single `-` or `_`.
pub fn account_ok(id: &str) -> bool {
    (2..=64).contains(&id.len()) && id.split('.').all(part_ok)
}

fn part_ok(part: &str) -> bool {
    !part.is_empty() && part.split(['-', '_']).all(|run| !run.is_empty() && run.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

fn hex(s: &str) -> bool {
    s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// An implicit account: a NEAR one (64 hex characters of a public key) or an Ethereum-style one (`0x` + 40 hex).
pub fn is_implicit(id: &str) -> bool {
    (id.len() == 64 && hex(id)) || (id.len() == 42 && id.starts_with("0x") && hex(&id[2..]))
}

/// The id without the white space around it, as JavaScript's `trim` takes it off: Unicode's white space, but not
/// U+0085 (next line), and with U+FEFF (the byte-order mark).
pub fn trimmed(id: &str) -> &str {
    id.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

/// A mainnet name such as `alice.near`.
pub fn is_mainnet_name(id: &str) -> bool {
    id.ends_with(".near")
}

/// A testnet name such as `alice.testnet`. There is no `testnet` account on mainnet, so none of these exist there.
pub fn is_testnet_name(id: &str) -> bool {
    id == "testnet" || id.ends_with(".testnet")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_ids_near_takes() {
        for ok in ["intents.near", "a.b", "ab", "safe-0001.tinygif8324.testnet", "a_b-c.d", "0x1", &"a".repeat(64)] {
            assert!(account_ok(ok), "{ok}");
        }
        for bad in ["", "a", "Alice.near", "a..b", ".ab", "ab.", "a--b", "-ab", "ab_", "a b", "а.near", &"a".repeat(65)] {
            assert!(!account_ok(bad), "{bad}");
        }
    }

    #[test]
    fn trims_what_javascript_trims() {
        assert_eq!(trimmed("  alice.near\t\r\n"), "alice.near");
        assert_eq!(trimmed("\u{feff}\u{a0}alice.near\u{2029}\u{3000}"), "alice.near");
        assert_eq!(trimmed("alice.near\u{85}"), "alice.near\u{85}");
        assert_eq!(trimmed("a b"), "a b");
    }

    #[test]
    fn tells_implicit_ids_and_networks() {
        assert!(is_implicit(&"be".repeat(32)));
        assert!(is_implicit(&format!("0x{}", "0f".repeat(20))));
        assert!(!is_implicit(&"BE".repeat(32)));
        assert!(!is_implicit("intents.near"));
        assert!(is_mainnet_name("alice.near") && !is_mainnet_name("near"));
        assert!(is_testnet_name("alice.testnet") && is_testnet_name("testnet") && !is_testnet_name("alice.near"));
    }
}
