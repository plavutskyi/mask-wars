// The rubric a client publishes before its job opens; the job holds its sha256 (`rubric`), the spec's too (`spec`).
// Both are fetched by hash from the content store (store.rs): bytes that hash to anything else are not the rubric.
//
// {
//   "format": "maskwars-rubric/v1",
//   "criteria": [
//     { "id": "finds-the-bug", "max": 10, "weight": 3, "text": "Does the review find the quorum bug in section 4?" },
//     { "id": "fix", "max": 5, "weight": 1, "text": "Does it propose a fix that keeps abstentions out of the quorum?" }
//   ],
//   "win_at": 60     the fewest points, of 100, a work needs to win (1 when absent)
// }
//
// A work's points: Σ weight × score over Σ weight × max, of 100. Every field is checked: an unknown one, a limit
// passed or a field missing makes the rubric one this judge cannot use, which is the client's to answer for.

use serde::{Deserialize, Serialize};

pub const FORMAT: &str = "maskwars-rubric/v1";
pub const MAX_RUBRIC_BYTES: usize = 8 * 1024;
/// The spec: what the work is about (a proposal to review, a brief). UTF-8 text.
pub const MAX_SPEC_BYTES: usize = 24 * 1024;
pub const MAX_CRITERIA: usize = 12;
const MAX_ID: usize = 32;
const MAX_TEXT: usize = 500;

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Criterion {
    pub id: String,
    pub max: u32,
    pub weight: u32,
    pub text: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Rubric {
    pub format: String,
    pub criteria: Vec<Criterion>,
    #[serde(default = "one")]
    pub win_at: u32,
}

fn one() -> u32 {
    1
}

impl Rubric {
    /// Σ weight × max: the denominator of every work's points.
    pub fn full(&self) -> u64 {
        self.criteria.iter().map(|c| u64::from(c.weight) * u64::from(c.max)).sum()
    }

    /// Σ weight × score for scores already checked against the criteria, in the rubric's order.
    pub fn weighted(&self, scores: &[u32]) -> u64 {
        self.criteria.iter().zip(scores).map(|(c, s)| u64::from(c.weight) * u64::from(*s)).sum()
    }

    /// Points of 100, rounded down, for people; comparisons use `weighted`.
    pub fn points(&self, weighted: u64) -> u64 {
        weighted * 100 / self.full()
    }

    pub fn wins(&self, weighted: u64) -> bool {
        weighted * 100 >= u64::from(self.win_at) * self.full()
    }
}

pub fn parse(bytes: &[u8]) -> Result<Rubric, String> {
    if bytes.len() > MAX_RUBRIC_BYTES {
        return Err("the rubric is over 8 KiB".into());
    }
    let r: Rubric = serde_json::from_slice(bytes).map_err(|e| format!("the rubric is not {FORMAT}: {e}"))?;
    if r.format != FORMAT {
        return Err(format!("the rubric is not {FORMAT}"));
    }
    if r.criteria.is_empty() || r.criteria.len() > MAX_CRITERIA {
        return Err("a rubric has 1 to 12 criteria".into());
    }
    for (i, c) in r.criteria.iter().enumerate() {
        let id_ok = (1..=MAX_ID).contains(&c.id.len())
            && c.id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !id_ok || r.criteria[..i].iter().any(|o| o.id == c.id) {
            return Err("a criterion's id is 1 to 32 lowercase letters, digits or -, each once".into());
        }
        if !(1..=10).contains(&c.max) || !(1..=10).contains(&c.weight) {
            return Err("a criterion's max and weight are 1 to 10".into());
        }
        if c.text.trim().is_empty() || c.text.chars().count() > MAX_TEXT {
            return Err("a criterion's text is 1 to 500 characters".into());
        }
    }
    if r.win_at > 100 {
        return Err("win_at is 0 to 100 points".into());
    }
    Ok(r)
}

pub fn spec(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_SPEC_BYTES {
        return Err("the spec is over 24 KiB".into());
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "the spec is not UTF-8 text".into())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub const RUBRIC: &str = r#"{"format":"maskwars-rubric/v1","criteria":[
        {"id":"finds-the-bug","max":10,"weight":3,"text":"Does the review find the quorum bug in section 4 of the proposal?"},
        {"id":"fix","max":5,"weight":1,"text":"Does it propose a fix that keeps abstentions out of the quorum count?"}],
        "win_at":60}"#;

    #[test]
    fn points_are_weighted_of_one_hundred() {
        let r = parse(RUBRIC.as_bytes()).unwrap();
        assert_eq!(r.full(), 35);
        let w = r.weighted(&[9, 4]);
        assert_eq!((w, r.points(w), r.wins(w)), (31, 88, true));
        let w = r.weighted(&[6, 2]);
        assert_eq!((w, r.points(w), r.wins(w)), (20, 57, false));
    }

    #[test]
    fn a_rubric_this_judge_cannot_use_is_refused() {
        let base = |c: &str, extra: &str| format!(r#"{{"format":"maskwars-rubric/v1","criteria":[{c}]{extra}}}"#);
        let ok = r#"{"id":"a","max":10,"weight":1,"text":"t"}"#;
        assert_eq!(parse(base(ok, "").as_bytes()).unwrap().win_at, 1);
        for (bad, why) in [
            (base("", ""), "1 to 12"),
            (base(&format!("{ok},{ok}"), ""), "each once"),
            (base(r#"{"id":"A","max":10,"weight":1,"text":"t"}"#, ""), "lowercase"),
            (base(r#"{"id":"a","max":11,"weight":1,"text":"t"}"#, ""), "1 to 10"),
            (base(r#"{"id":"a","max":10,"weight":0,"text":"t"}"#, ""), "1 to 10"),
            (base(r#"{"id":"a","max":10,"weight":1,"text":" "}"#, ""), "500"),
            (base(ok, r#","win_at":101"#), "0 to 100"),
            (base(ok, r#","winner":"me""#), "unknown field"),
        ] {
            let err = parse(bad.as_bytes()).unwrap_err();
            assert!(err.contains(why), "{bad}: {err}");
        }
        assert!(spec(&[0xff, 0xfe]).is_err());
        assert!(spec(&vec![b'a'; MAX_SPEC_BYTES + 1]).is_err());
    }
}
