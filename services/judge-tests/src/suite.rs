// The client's private test set. It lives in the client's own OutLayer secrets under the judge project
// (`MASKWARS_TESTS`), readable only by this judge inside the TEE; the job holds its sha256 (`rubric`) from before any
// mask started. The exact bytes of the secret are hashed: whitespace counts.
//
// {
//   "format": "maskwars-tests/v1",
//   "fuel": 200000,             fuel (≈ Wasm instructions) one case may burn, at most MAX_CASE_FUEL
//   "win_at": 8,                the fewest passed cases that may win (1 when absent)
//   "cases": [
//     { "input": "text", "expect": "text" },
//     { "input_b64": "base64", "expect_b64": "base64" }
//   ]
// }
//
// A case passes when the work's output is byte for byte `expect`. Every field is checked: an unknown one, a limit
// passed or a field missing makes the test set one this judge cannot run, which is the client's to answer for.

use serde::Deserialize;

pub const FORMAT: &str = "maskwars-tests/v1";
/// The secret's bytes at most.
pub const MAX_SUITE_BYTES: usize = 64 * 1024;
pub const MAX_CASES: usize = 32;
/// One case's input and expected output, bytes.
pub const MAX_CASE_BYTES: usize = 4096;
pub const MIN_CASE_FUEL: u64 = 1_000;
/// Fuel all the cases of one work may burn together, and so one case. A judge run reads up to 16 works, and on appeal
/// runs the set twice more on up to three of them, all within the 1e9 instructions the jobs contract asks OutLayer
/// for: sandbox/tests/budget.rs measures it.
pub const MAX_CASE_FUEL: u64 = 500_000;
pub const MAX_SUITE_FUEL: u64 = 500_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Case {
    pub input: Vec<u8>,
    pub expect: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Suite {
    pub fuel: u64,
    pub win_at: u32,
    pub cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Raw {
    format: String,
    fuel: u64,
    #[serde(default)]
    win_at: Option<u32>,
    cases: Vec<RawCase>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCase {
    #[serde(default)]
    input: Option<String>,
    #[serde(default)]
    input_b64: Option<String>,
    #[serde(default)]
    expect: Option<String>,
    #[serde(default)]
    expect_b64: Option<String>,
}

pub fn parse(text: &str) -> Result<Suite, String> {
    if text.len() > MAX_SUITE_BYTES {
        return Err("the test set is over 64 KiB".into());
    }
    let raw: Raw = serde_json::from_str(text).map_err(|e| format!("the test set is not {FORMAT}: {e}"))?;
    if raw.format != FORMAT {
        return Err(format!("the test set is not {FORMAT}"));
    }
    if raw.cases.is_empty() || raw.cases.len() > MAX_CASES {
        return Err("a test set has 1 to 32 cases".into());
    }
    if !(MIN_CASE_FUEL..=MAX_CASE_FUEL).contains(&raw.fuel) {
        return Err(format!("fuel is {MIN_CASE_FUEL} to {MAX_CASE_FUEL} a case"));
    }
    if raw.fuel * raw.cases.len() as u64 > MAX_SUITE_FUEL {
        return Err(format!("fuel × cases is at most {MAX_SUITE_FUEL}"));
    }
    let win_at = raw.win_at.unwrap_or(1);
    if win_at == 0 || win_at as usize > raw.cases.len() {
        return Err("win_at is 1 to the number of cases".into());
    }
    let cases = raw
        .cases
        .into_iter()
        .map(|c| {
            let input = field(c.input, c.input_b64, "input")?;
            let expect = field(c.expect, c.expect_b64, "expect")?;
            if input.len() > MAX_CASE_BYTES || expect.len() > MAX_CASE_BYTES {
                return Err("a case's input and expect are at most 4096 bytes each".to_string());
            }
            Ok(Case { input, expect })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Suite { fuel: raw.fuel, win_at, cases })
}

fn field(text: Option<String>, b64: Option<String>, name: &str) -> Result<Vec<u8>, String> {
    match (text, b64) {
        (Some(t), None) => Ok(t.into_bytes()),
        (None, Some(b)) => unbase64(&b).ok_or_else(|| format!("{name}_b64 is not base64")),
        _ => Err(format!("a case has {name} or {name}_b64, one of them")),
    }
}

/// Standard base64, padding optional.
fn unbase64(text: &str) -> Option<Vec<u8>> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let body = text.trim_end_matches('=');
    if text.len() - body.len() > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in body.bytes() {
        acc = (acc << 6 | T.iter().position(|t| *t == c)? as u32) & 0xffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (bits < 6 && acc & ((1 << bits) - 1) == 0).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_test_set_reads_text_and_base64_cases() {
        let s = parse(r#"{"format":"maskwars-tests/v1","fuel":5000,"win_at":2,
            "cases":[{"input":"abc","expect":"cba"},{"input_b64":"AAH/","expect_b64":"/wEA"}]}"#)
        .unwrap();
        assert_eq!((s.fuel, s.win_at), (5000, 2));
        assert_eq!(s.cases[1], Case { input: vec![0, 1, 255], expect: vec![255, 1, 0] });
        assert_eq!(parse(r#"{"format":"maskwars-tests/v1","fuel":5000,"cases":[{"input":"","expect":""}]}"#).unwrap().win_at, 1);
    }

    #[test]
    fn a_test_set_this_judge_cannot_run_is_refused() {
        let base = |f: &str| format!(r#"{{"format":"maskwars-tests/v1",{f}}}"#);
        for (bad, why) in [
            (base(r#""fuel":5000,"cases":[]"#), "1 to 32"),
            (base(r#""fuel":5,"cases":[{"input":"a","expect":"a"}]"#), "fuel is"),
            (base(r#""fuel":400000,"cases":[{"input":"a","expect":"a"},{"input":"b","expect":"b"}]"#), "fuel × cases"),
            (base(r#""fuel":600000,"cases":[{"input":"a","expect":"a"}]"#), "fuel is"),
            (base(r#""fuel":5000,"win_at":2,"cases":[{"input":"a","expect":"a"}]"#), "win_at"),
            (base(r#""fuel":5000,"cases":[{"input":"a","input_b64":"YQ==","expect":"a"}]"#), "one of them"),
            (base(r#""fuel":5000,"cases":[{"input":"a"}]"#), "one of them"),
            (base(r#""fuel":5000,"cases":[{"input_b64":"Y","expect":"a"}]"#), "not base64"),
            (base(r#""fuel":5000,"timeout":3,"cases":[{"input":"a","expect":"a"}]"#), "unknown field"),
            (r#"{"format":"maskwars-tests/v2","fuel":5000,"cases":[{"input":"a","expect":"a"}]}"#.to_string(), "not maskwars-tests/v1"),
        ] {
            let err = parse(&bad).unwrap_err();
            assert!(err.contains(why), "{bad}: {err}");
        }
        let long = format!(r#"{{"format":"maskwars-tests/v1","fuel":5000,"cases":[{{"input":"{}","expect":""}}]}}"#, "a".repeat(4097));
        assert!(parse(&long).unwrap_err().contains("4096"));
    }
}
