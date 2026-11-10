// The race judge, for a race in the sandbox (a team's private code never leaves it). It answers one question for the
// bounty contract: did race `run_id` break this bounty's target, and which mask won? It trusts exactly one thing: a
// successful manual run of the `Live race` workflow on `main` of the MASK WARS repository, made after the bounty
// opened, on a commit that is in the history of the branch `main` and no older than `MIN_COMMIT`, the commit whose
// `Live race` this judge was built for. That workflow ends by uploading one artifact named
// `maskwars-result~<bounty id>~<target>~<winner account or "held">`; the judge lists the run's artifacts on GitHub
// and checks that name against the bounty, and the winner against the masks the bounty was opened for. It needs read
// access to Actions and to the code (for `compare`). Which repository and workflow count is fixed here, in the code
// OutLayer attests.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const REPO: &str = "plavutskyi/mask-wars-hq";
/// The oldest commit whose `Live race` the judge trusts: the workflow, the race and the sandbox as this judge was built
/// for them. A run on an older commit of `main` ran older code and vouches for nothing. It moves with every judge that
/// trusts a newer workflow, and it stays in `main`'s history because pull requests are merged with a merge commit.
pub const MIN_COMMIT: &str = "bb939042534a523253e3f53f159b54f76f368421";
pub const WORKFLOW: &str = ".github/workflows/live-race.yml";
pub const RESULT_PREFIX: &str = "maskwars-result~";
/// The winner part of the result name when no mask broke the target.
pub const HELD: &str = "held";

#[derive(Deserialize)]
pub struct Input {
    pub bounty_id: String,
    pub target: String,
    /// The contract sends `U64`, which is a JSON string.
    pub run_id: String,
    /// When the bounty opened, ns: a run made earlier did not race for it.
    #[serde(default)]
    pub opened_ns: Option<String>,
    /// The masks the bounty may pay.
    #[serde(default)]
    pub masks: Option<Vec<String>>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Verdict {
    pub bounty_id: String,
    pub winner: String,
    pub run_id: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Output {
    pub success: bool,
    pub output: Option<Value>,
    pub error: Option<String>,
}

impl Output {
    pub fn from<T: Serialize>(r: Result<T, String>) -> Self {
        match r.and_then(|v| serde_json::to_value(v).map_err(|_| "unwritable verdict".to_string())) {
            Ok(v) => Output { success: true, output: Some(v), error: None },
            Err(e) => Output { success: false, output: None, error: Some(e) },
        }
    }
}

/// What the judge needs from GitHub. On OutLayer it is HTTPS from inside the TEE; in tests, canned answers.
pub trait GitHub {
    fn get(&self, path: &str) -> Result<Value, String>;
}

pub fn run_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
}

/// The run must be a finished, successful manual run of `Live race` on `main`, made after the bounty opened.
pub fn check_run(run: &Value, opened_ns: u64) -> Result<(), String> {
    let s = |k: &str| run.get(k).and_then(Value::as_str).unwrap_or("");
    if s("path") != WORKFLOW {
        return Err("not a Live race run".into());
    }
    if s("event") != "workflow_dispatch" || s("head_branch") != "main" {
        return Err("not a manual run on main".into());
    }
    if s("status") != "completed" || s("conclusion") != "success" {
        return Err("the run did not finish cleanly".into());
    }
    // A re-run keeps the time the run was made; both times must come after the opening.
    for k in ["created_at", "run_started_at"] {
        let at = utc_ns(s(k)).ok_or("the run's time is unreadable")?;
        if at < opened_ns {
            return Err("the run was made before the bounty opened".into());
        }
    }
    Ok(())
}

/// GitHub's UTC time, `2026-11-06T09:55:21Z`, in ns since 1970.
pub fn utc_ns(t: &str) -> Option<u64> {
    let b = t.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z'
    {
        return None;
    }
    let n = |r: std::ops::Range<usize>| t.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    // Days from 1970-01-01 to the civil date (H. Hinnant's days_from_civil).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3_600 + mm * 60 + ss;
    u64::try_from(secs).ok()?.checked_mul(1_000_000_000)
}

/// A full commit SHA, 40 hex digits.
fn sha_ok(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// How GitHub relates `head` to `base`: `ahead`, `behind`, `identical` or `diverged`.
fn compare(gh: &dyn GitHub, base: &str, head: &str) -> Result<String, String> {
    let cmp = gh.get(&format!("/repos/{REPO}/compare/{base}...{head}"))?;
    Ok(cmp.get("status").and_then(Value::as_str).unwrap_or("").to_string())
}

/// The run's commit is in the history of the branch `main`, and no older than `MIN_COMMIT`. The branch is read by its
/// full ref, `heads/main`, and compared by the SHA it points at: a tag called `main`, which GitHub would take for
/// `main` in a comparison, cannot stand in for the branch. A run on a tag or a branch that happens to be called `main`,
/// on a commit that never went into `main`, does not count, and neither does a run on an older commit of `main`.
pub fn check_commit(run: &Value, gh: &dyn GitHub) -> Result<(), String> {
    let sha = run.get("head_sha").and_then(Value::as_str).unwrap_or("");
    if !sha_ok(sha) {
        return Err("the run's commit is unreadable".into());
    }
    let head = gh.get(&format!("/repos/{REPO}/git/ref/heads/main"))?;
    let main = head.pointer("/object/sha").and_then(Value::as_str).filter(|s| sha_ok(s)).ok_or("main is unreadable")?;
    if !matches!(compare(gh, main, sha)?.as_str(), "behind" | "identical") {
        return Err("the run's commit is not in main".into());
    }
    if !matches!(compare(gh, MIN_COMMIT, sha)?.as_str(), "ahead" | "identical") {
        return Err("the run's commit is older than the judge's Live race".into());
    }
    Ok(())
}

/// The run's one result artifact, checked against the bounty.
pub fn read_result(artifacts: &Value, input: &Input) -> Result<String, String> {
    let list = artifacts.get("artifacts").and_then(Value::as_array).ok_or("no artifacts")?;
    let mut results =
        list.iter().filter_map(|a| a.get("name").and_then(Value::as_str)).filter(|n| n.starts_with(RESULT_PREFIX));
    let name = results.next().ok_or("the run reported no result")?;
    if results.next().is_some() {
        return Err("the run reported more than one result".into());
    }
    let parts: Vec<&str> = name[RESULT_PREFIX.len()..].split('~').collect();
    let [bounty_id, target, winner] = *parts.as_slice() else {
        return Err("the result is unreadable".into());
    };
    if bounty_id != input.bounty_id {
        return Err("the race was for another bounty".into());
    }
    if target != input.target {
        return Err("the race was on another target".into());
    }
    if winner == HELD {
        return Err("vault held".into());
    }
    if !account_ok(winner) {
        return Err("the winner is not a NEAR account".into());
    }
    Ok(winner.to_string())
}

/// NEAR account id rules, short form: 2-64 chars of a-z 0-9 - _ . with no separator at the edges or doubled.
pub fn account_ok(a: &str) -> bool {
    let b = a.as_bytes();
    (2..=64).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-_.".contains(c))
        && !b"-_.".contains(&b[0])
        && !b"-_.".contains(&b[b.len() - 1])
        && !b.windows(2).any(|w| b"-_.".contains(&w[0]) && b"-_.".contains(&w[1]))
}

pub fn judge(input: &Input, gh: &dyn GitHub) -> Result<Verdict, String> {
    if !run_id_ok(&input.run_id) {
        return Err("bad run id".into());
    }
    let opened_ns = input.opened_ns.as_deref().and_then(|n| n.parse::<u64>().ok());
    let opened_ns = opened_ns.ok_or("bad bounty terms: no opening time")?;
    let masks = input.masks.as_deref().filter(|m| !m.is_empty()).ok_or("bad bounty terms: no masks")?;
    let run = gh.get(&format!("/repos/{REPO}/actions/runs/{}", input.run_id))?;
    check_run(&run, opened_ns)?;
    check_commit(&run, gh)?;
    let artifacts = gh.get(&format!("/repos/{REPO}/actions/runs/{}/artifacts", input.run_id))?;
    let winner = read_result(&artifacts, input)?;
    if !masks.contains(&winner) {
        return Err("the winner is not a mask of this race".into());
    }
    Ok(Verdict { bounty_id: input.bounty_id.clone(), winner, run_id: input.run_id.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    struct Canned(HashMap<String, Value>);

    impl GitHub for Canned {
        fn get(&self, path: &str) -> Result<Value, String> {
            self.0.get(path).cloned().ok_or_else(|| format!("404 {path}"))
        }
    }

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    /// Where the branch `main` points.
    const MAIN: &str = "89abcdef0123456789abcdef0123456789abcdef";
    /// The bounty opened at 2026-11-08T10:00:00Z; the run was made a minute later.
    const OPENED_NS: u64 = 1_794_132_000_000_000_000;

    fn input() -> Input {
        Input {
            bounty_id: "race-0001".into(),
            target: "open-admin".into(),
            run_id: "42".into(),
            opened_ns: Some(OPENED_NS.to_string()),
            masks: Some(vec!["nova.maskwars.testnet".into(), "onyx.maskwars.testnet".into()]),
        }
    }

    fn run() -> Value {
        json!({ "path": WORKFLOW, "event": "workflow_dispatch", "head_branch": "main", "status": "completed",
                "conclusion": "success", "head_sha": SHA, "created_at": "2026-11-08T10:01:00Z",
                "run_started_at": "2026-11-08T10:01:00Z" })
    }

    fn github(run: Value, names: &[&str]) -> Canned {
        let artifacts: Vec<Value> = names.iter().map(|n| json!({ "name": n })).collect();
        let mut m = HashMap::new();
        m.insert(format!("/repos/{REPO}/actions/runs/42"), run);
        m.insert(format!("/repos/{REPO}/actions/runs/42/artifacts"), json!({ "artifacts": artifacts }));
        // main has moved on from the run's commit, which is newer than the judge's minimum.
        m.insert(format!("/repos/{REPO}/git/ref/heads/main"), json!({ "object": { "sha": MAIN, "type": "commit" } }));
        m.insert(format!("/repos/{REPO}/compare/{MAIN}...{SHA}"), json!({ "status": "behind", "behind_by": 3 }));
        m.insert(format!("/repos/{REPO}/compare/{MIN_COMMIT}...{SHA}"), json!({ "status": "ahead", "ahead_by": 5 }));
        Canned(m)
    }

    fn result(winner: &str) -> String {
        format!("{RESULT_PREFIX}race-0001~open-admin~{winner}")
    }

    #[test]
    fn a_clean_run_with_a_winner_names_the_winner() {
        let v = judge(&input(), &github(run(), &["race-open-admin", &result("nova.maskwars.testnet")])).unwrap();
        assert_eq!(
            v,
            Verdict { bounty_id: "race-0001".into(), winner: "nova.maskwars.testnet".into(), run_id: "42".into() }
        );
    }

    #[test]
    fn a_held_vault_pays_nothing() {
        assert_eq!(judge(&input(), &github(run(), &[&result(HELD)])).unwrap_err(), "vault held");
    }

    #[test]
    fn only_a_successful_manual_live_race_on_main_counts() {
        for (k, v) in [
            ("path", ".github/workflows/ci.yml"),
            ("event", "push"),
            ("head_branch", "feature"),
            ("conclusion", "failure"),
            ("status", "in_progress"),
        ] {
            let mut r = run();
            r[k] = json!(v);
            assert!(judge(&input(), &github(r, &[&result("nova.maskwars.testnet")])).is_err(), "{k}");
        }
    }

    #[test]
    fn a_result_for_another_bounty_or_target_pays_nothing() {
        let other = format!("{RESULT_PREFIX}race-9999~open-admin~nova.maskwars.testnet");
        assert_eq!(judge(&input(), &github(run(), &[&other])).unwrap_err(), "the race was for another bounty");
        let other = format!("{RESULT_PREFIX}race-0001~over-withdraw~nova.maskwars.testnet");
        assert_eq!(judge(&input(), &github(run(), &[&other])).unwrap_err(), "the race was on another target");
    }

    #[test]
    fn no_result_or_two_results_are_refused() {
        assert_eq!(judge(&input(), &github(run(), &["race-open-admin"])).unwrap_err(), "the run reported no result");
        let two = [result("nova.maskwars.testnet"), result("onyx.maskwars.testnet")];
        let two: Vec<&str> = two.iter().map(String::as_str).collect();
        assert_eq!(judge(&input(), &github(run(), &two)).unwrap_err(), "the run reported more than one result");
    }

    #[test]
    fn a_malformed_name_is_refused() {
        let bad = format!("{RESULT_PREFIX}race-0001~open-admin~nova.testnet~extra");
        assert_eq!(judge(&input(), &github(run(), &[&bad])).unwrap_err(), "the result is unreadable");
    }

    #[test]
    fn a_winner_must_be_a_near_account() {
        for bad in ["NOVA", "a", "..x", "nova..testnet", "nova.testnet."] {
            assert!(judge(&input(), &github(run(), &[&result(bad)])).is_err(), "{bad}");
        }
    }

    #[test]
    fn github_time_reads_as_ns() {
        assert_eq!(utc_ns("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(utc_ns("2026-11-08T10:00:00Z"), Some(OPENED_NS));
        assert_eq!(utc_ns("2024-02-29T23:59:59Z"), Some(1_709_251_199_000_000_000));
        for bad in
            ["", "2026-11-08 10:00:00Z", "2026-13-08T10:00:00Z", "2026-11-08T10:00:00+01:00", "1969-12-31T23:59:59Z"]
        {
            assert_eq!(utc_ns(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_bounty_must_say_when_it_opened_and_who_may_win() {
        let gh = github(run(), &[&result("nova.maskwars.testnet")]);
        let mut i = input();
        i.opened_ns = None;
        assert_eq!(judge(&i, &gh).unwrap_err(), "bad bounty terms: no opening time");
        let mut i = input();
        i.masks = Some(vec![]);
        assert_eq!(judge(&i, &gh).unwrap_err(), "bad bounty terms: no masks");
    }

    #[test]
    fn a_bad_run_id_never_reaches_github() {
        let mut i = input();
        i.run_id = "42/../../evil".into();
        assert_eq!(judge(&i, &Canned(HashMap::new())).unwrap_err(), "bad run id");
    }
}

#[cfg(test)]
mod attacks {
    //! A8: the sandbox judge took any successful run named for the bounty, made whenever, on any commit called `main`,
    //! paying whichever account the repository variable named. These go through `answer`, as the contract asks.
    use crate::answer;
    use crate::chain::Chain;
    use crate::judge::{GitHub, MIN_COMMIT, REPO, WORKFLOW};
    use serde_json::{json, Value};
    use std::collections::HashMap;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
    const MAIN: &str = "89abcdef0123456789abcdef0123456789abcdef";
    const RESULT: &str = "maskwars-result~race-0001~open-admin~nova.maskwars.testnet";

    struct Canned(HashMap<String, Value>);

    impl GitHub for Canned {
        fn get(&self, path: &str) -> Result<Value, String> {
            self.0.get(path).cloned().ok_or_else(|| format!("404 {path}"))
        }
    }

    impl Chain for Canned {
        fn name(&self) -> &str {
            "none"
        }
        fn rpc(&self, _: &str, _: Value) -> Result<Value, String> {
            Err("unreachable".into())
        }
    }

    /// A run made at `made`, on a commit the branch `main` relates to as `status`, that reported `result`. The
    /// commit is newer than the judge's minimum.
    fn github(made: &str, status: &str, result: &str) -> Canned {
        let run = json!({ "path": WORKFLOW, "event": "workflow_dispatch", "head_branch": "main", "status": "completed",
                          "conclusion": "success", "head_sha": SHA, "created_at": made, "run_started_at": made });
        let mut m = HashMap::new();
        m.insert(format!("/repos/{REPO}/actions/runs/42"), run);
        m.insert(format!("/repos/{REPO}/actions/runs/42/artifacts"), json!({ "artifacts": [{ "name": result }] }));
        m.insert(format!("/repos/{REPO}/git/ref/heads/main"), json!({ "object": { "sha": MAIN } }));
        m.insert(format!("/repos/{REPO}/compare/{MAIN}...{SHA}"), json!({ "status": status }));
        // The ambiguous name: a comparison with `main` that GitHub may resolve to a tag. The judge must not ask it.
        m.insert(format!("/repos/{REPO}/compare/main...{SHA}"), json!({ "status": status }));
        m.insert(format!("/repos/{REPO}/compare/{MIN_COMMIT}...{SHA}"), json!({ "status": "ahead" }));
        Canned(m)
    }

    /// What the contract asks for a sandbox claim on `race-0001`, opened 2026-11-08T10:00:00Z for NOVA and ONYX.
    fn question() -> Value {
        json!({ "kind": "race", "bounty_id": "race-0001", "target": "open-admin", "run_id": "42",
                "opened_ns": "1794132000000000000", "masks": ["nova.maskwars.testnet", "onyx.maskwars.testnet"] })
    }

    fn verdict(gh: &Canned) -> (bool, Option<String>) {
        let out = answer(Some(question()), gh, &[gh]);
        (out.success, out.error)
    }

    #[test]
    fn an_honest_run_after_the_opening_on_main_pays_its_winner() {
        assert_eq!(verdict(&github("2026-11-08T10:01:00Z", "behind", RESULT)), (true, None));
        assert_eq!(verdict(&github("2026-11-08T10:01:00Z", "identical", RESULT)), (true, None));
    }

    #[test]
    fn a_run_made_before_the_bounty_opened_wins_nothing() {
        // The id `race-0001` was easy to guess: someone ran the race the day before and kept the artifact.
        let (ok, why) = verdict(&github("2026-11-07T10:01:00Z", "behind", RESULT));
        assert!(!ok);
        assert_eq!(why.as_deref(), Some("the run was made before the bounty opened"));
    }

    #[test]
    fn a_run_on_a_commit_that_never_went_into_main_wins_nothing() {
        // A tag or a stray branch named `main` reads as `head_branch: main`; its commit is not in main's history.
        for status in ["ahead", "diverged"] {
            let (ok, why) = verdict(&github("2026-11-08T10:01:00Z", status, RESULT));
            assert!(!ok, "{status}");
            assert_eq!(why.as_deref(), Some("the run's commit is not in main"), "{status}");
        }
    }

    #[test]
    fn a_winner_the_bounty_was_not_opened_for_wins_nothing() {
        // The repository variable MASK_ACCOUNTS named another account as the mask.
        let theirs = "maskwars-result~race-0001~open-admin~thief.testnet";
        let (ok, why) = verdict(&github("2026-11-08T10:01:00Z", "behind", theirs));
        assert!(!ok);
        assert_eq!(why.as_deref(), Some("the winner is not a mask of this race"));
    }

    #[test]
    fn a_tag_called_main_cannot_stand_in_for_the_branch() {
        // Review finding 5: the judge compared with the name `main`, which GitHub also reads as a tag. A tag `main` on
        // a commit that never went into the branch made the run's commit look `behind` main. The judge now compares
        // with the SHA the branch itself points at.
        let mut gh = github("2026-11-08T10:01:00Z", "diverged", RESULT);
        gh.0.insert(format!("/repos/{REPO}/compare/main...{SHA}"), json!({ "status": "behind" }));
        let (ok, why) = verdict(&gh);
        assert!(!ok);
        assert_eq!(why.as_deref(), Some("the run's commit is not in main"));
    }

    #[test]
    fn a_run_on_an_older_commit_of_main_wins_nothing() {
        // Review finding 5: an old commit of main is `behind` main too, and its `Live race` is older code. The run's
        // commit must be the judge's minimum or come after it.
        let mut gh = github("2026-11-08T10:01:00Z", "behind", RESULT);
        for older in ["behind", "diverged"] {
            gh.0.insert(format!("/repos/{REPO}/compare/{MIN_COMMIT}...{SHA}"), json!({ "status": older }));
            let (ok, why) = verdict(&gh);
            assert!(!ok, "{older}");
            assert_eq!(why.as_deref(), Some("the run's commit is older than the judge's Live race"), "{older}");
        }
        gh.0.insert(format!("/repos/{REPO}/compare/{MIN_COMMIT}...{SHA}"), json!({ "status": "identical" }));
        assert_eq!(verdict(&gh), (true, None));
    }

    #[test]
    fn the_judge_pins_a_real_commit() {
        assert!(MIN_COMMIT.len() == 40 && MIN_COMMIT.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    }
}
