//! NEP-330 for a contract without near-sdk's `#[near]` struct: the JSON `contract_source_metadata` returns, written at
//! build time into `$OUT_DIR/nep330.json` exactly as near-sdk 5 writes it for its own contracts. The same file serves
//! contracts/house, contracts/home and contracts/masks/mask (a test of the house holds the three equal).
//!
//! - `version`: `NEP330_VERSION`, else the crate's version; `link`: `NEP330_LINK`, else the crate's `repository`.
//! - `build_info`: only when `cargo near build reproducible-wasm` runs the build in its pinned image, which sets the
//!   `NEP330_BUILD_INFO_*` variables: the image, the command, the folder and the commit the code was built from. A
//!   plain `cargo build` (build.sh) gives `null` there, and so says what it is.

use std::env::{self, VarError};

fn var(name: &str) -> Result<String, VarError> {
    println!("cargo:rerun-if-env-changed={name}");
    env::var(name)
}

/// A JSON string as serde_json writes it.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn text(v: Option<&str>) -> String {
    v.map_or_else(|| "null".to_string(), quote)
}

fn bad(raw: &str) -> ! {
    panic!("problem parsing `NEP330_BUILD_INFO_BUILD_COMMAND` value: {raw}")
}

/// Four hex digits of a `\u` escape.
fn hex(raw: &str, chars: &mut std::iter::Peekable<std::str::Chars>) -> u32 {
    let h: String = (0..4).filter_map(|_| chars.next()).collect();
    u32::from_str_radix(&h, 16).unwrap_or_else(|_| bad(raw))
}

/// `NEP330_BUILD_INFO_BUILD_COMMAND`: a JSON array of strings, read as near-sdk reads it.
fn command(raw: &str) -> Vec<String> {
    let mut chars = raw.trim().chars().peekable();
    let mut out = Vec::new();
    if chars.next() != Some('[') {
        bad(raw);
    }
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        match chars.next() {
            Some(']') if out.is_empty() => break,
            Some('"') => {}
            _ => bad(raw),
        }
        let mut s = String::new();
        loop {
            match chars.next() {
                Some('"') => break,
                Some('\\') => match chars.next() {
                    Some('"') => s.push('"'),
                    Some('\\') => s.push('\\'),
                    Some('/') => s.push('/'),
                    Some('b') => s.push('\u{8}'),
                    Some('f') => s.push('\u{c}'),
                    Some('n') => s.push('\n'),
                    Some('r') => s.push('\r'),
                    Some('t') => s.push('\t'),
                    Some('u') => {
                        let hi = hex(raw, &mut chars);
                        let code = if (0xd800..0xdc00).contains(&hi) {
                            if chars.next() != Some('\\') || chars.next() != Some('u') {
                                bad(raw);
                            }
                            let lo = hex(raw, &mut chars);
                            if !(0xdc00..0xe000).contains(&lo) {
                                bad(raw);
                            }
                            0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00)
                        } else {
                            hi
                        };
                        s.push(char::from_u32(code).unwrap_or_else(|| bad(raw)));
                    }
                    _ => bad(raw),
                },
                Some(c) => s.push(c),
                None => bad(raw),
            }
        }
        out.push(s);
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        match chars.next() {
            Some(',') => {}
            Some(']') => break,
            _ => bad(raw),
        }
    }
    if chars.any(|c| !c.is_whitespace()) {
        bad(raw);
    }
    out
}

fn build_info() -> String {
    let Ok(environment) = var("NEP330_BUILD_INFO_BUILD_ENVIRONMENT") else {
        // Read anyway, so that cargo builds again when any of them is set.
        for name in ["BUILD_COMMAND", "SOURCE_CODE_SNAPSHOT", "CONTRACT_PATH", "OUTPUT_WASM_PATH"] {
            let _ = var(&format!("NEP330_BUILD_INFO_{name}"));
        }
        return "null".to_string();
    };
    let need = |name: &str| {
        var(name)
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| panic!("`{name}` is required with a build environment"))
    };
    assert!(!environment.is_empty(), "`NEP330_BUILD_INFO_BUILD_ENVIRONMENT` is set, but it's set to empty string!");
    let command = command(&need("NEP330_BUILD_INFO_BUILD_COMMAND"));
    let snapshot = need("NEP330_BUILD_INFO_SOURCE_CODE_SNAPSHOT");
    let path = var("NEP330_BUILD_INFO_CONTRACT_PATH")
        .expect("`NEP330_BUILD_INFO_CONTRACT_PATH` was provided, but it's not set!");
    let output = match var("NEP330_BUILD_INFO_OUTPUT_WASM_PATH") {
        Ok(p) => Some(p),
        Err(VarError::NotPresent) => None,
        Err(VarError::NotUnicode(_)) => {
            panic!("`NEP330_BUILD_INFO_OUTPUT_WASM_PATH` was provided, but it contained invalid UTF8!")
        }
    };
    let command: Vec<String> = command.iter().map(|c| quote(c)).collect();
    format!(
        r#"{{"build_environment":{},"build_command":[{}],"contract_path":{},"source_code_snapshot":{},"output_wasm_path":{}}}"#,
        quote(&environment),
        command.join(","),
        quote(&path),
        quote(&snapshot),
        text(output.as_deref()),
    )
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let pick = |own: &str, cargo: &str| var(own).or_else(|_| var(cargo)).ok().filter(|v| !v.is_empty());
    let version = pick("NEP330_VERSION", "CARGO_PKG_VERSION");
    let link = pick("NEP330_LINK", "CARGO_PKG_REPOSITORY");
    let json = format!(
        r#"{{"version":{},"link":{},"standards":[{{"standard":"nep330","version":"1.3.0"}}],"build_info":{}}}"#,
        text(version.as_deref()),
        text(link.as_deref()),
        build_info(),
    );
    let out = std::path::PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(out.join("nep330.json"), json).expect("write nep330.json");
}
