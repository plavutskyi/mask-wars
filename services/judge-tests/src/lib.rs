//! The `tee_tests` judge of MASK WARS jobs (contracts/jobs). On OutLayer it runs in a TEE at the exact wasm a job
//! pinned (main.rs); the local sandbox runs this same library over the sandbox's RPC.
//!
//! Before any mask starts, the check (`"check":true`): the client's private test set, read from the client's own
//! secrets row this once, is the one the job published, it fits the job's bar (`win_at`, cases, fuel), and the
//! client's own solution, sealed for this judge's key, passes at least `win_at` of its cases. A set nobody can pass
//! never opens to masks; anything else wrong sends the client everything back before anyone works. A set that passes
//! is kept in the project's private storage under the job it was checked for (`tests/<contract>/<job>/<sha256>`): no
//! later run names the client's secrets, so nothing the client changes after the check reaches a verdict, and no other
//! job reads it.
//!
//! The judge answers only the jobs contract written into it (`job::served`), and only a job pinned to its own key.
//!
//! Then a verdict:
//!
//! 1. Read the job, its entrants and steps at one final block, from two RPC sources of two operators that must agree
//!    (job.rs).
//! 2. Take the test set the check kept. Gone from the project's storage is the judge's failure, never the client's:
//!    no verdict, and the job waits for the judge again.
//! 3. Every step is a box sealed for this judge's key (sealed.rs). Each striker's work is its latest one, the module
//!    inside the box. Open it and run every case in a fresh, fuelled interpreter (run.rs). Nothing a work names
//!    outside the chain is fetched: no mask can slow the judge or fail its run.
//! 4. The work that passes the most cases wins, if it passes at least `win_at`; on a tie, the earlier seal. A work that
//!    passes at least one case is a real attempt and counts, with the scout and verifier steps of its crew. Fake is
//!    only what is objectively no work: a box that does not open for its mask, a striker's box that holds no module,
//!    a module that does not load (run.rs: valid, no imports, `memory`, `alloc`, `run`). Its mask loses its bond, to
//!    the company. A work that loads and passes no case of the private set is never fake: its mask could not see the
//!    set. It is not counted either: on the contract a seat with no counted step pays half its bond, so a module that
//!    passes nothing holds no slot for free. On appeal the works that could win run the set three times, in three orders, best
//!    first until one holds: a work whose results differ does not win.
//! 5. The winner's boxes are kept (`won/…`) until the client asks: once the job is paid, a delivery
//!    (`"deliver":true`) opens them and seals the work again for the client's key (`delivery/…`, public).

pub mod job;
pub mod run;
pub mod sealed;
pub mod suite;

use job::{Caller, Chain, Keep, Output, Read, Role, Verdict};
use serde_json::{json, Map, Value};

pub const KIND: &str = "tee_tests";

/// What OutLayer put in the run's environment.
///
/// A client cannot plant a `PROTECTED_TESTS_SEED` of its own: OutLayer refuses to start a run in which the author's
/// secrets and the caller's both define a name, and the client's row is named only for the check.
#[derive(Debug, Clone, Default)]
pub struct Secrets {
    /// `PROTECTED_TESTS_SEED`, hex: the judge's own seed, from the project author's secrets on every run.
    pub seed: Option<String>,
    /// `MASKWARS_TESTS`: the test set, from the secrets row the job named, at the check.
    pub tests: Option<String>,
    /// The owner and profile of the row that supplied `MASKWARS_TESTS` (`OUTLAYER_SECRETS_ROWS`).
    pub tests_owner: Option<String>,
    pub tests_profile: Option<String>,
}

/// The judge's answer to one run: `{"action":"key"}` gives its public key; a job's question is its check before the
/// work window (`"check":true`), its verdict, or once it is paid the winning work for the client (`"deliver":true`).
pub fn answer(input: Option<Value>, caller: &Caller, secrets: &Secrets, chains: &[&dyn Chain], keep: &dyn Keep) -> Output {
    let seed = secrets.seed.as_deref().and_then(|s| job::unhex(s).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok());
    let Some(seed) = seed else {
        return Output::fail("the judge has no key in this TEE");
    };
    let judge = sealed::judge_secret(&seed);
    let key = sealed::key_text(&sealed::JudgePublic::from(&judge));
    if input.as_ref().and_then(|i| i.get("action")).and_then(Value::as_str) == Some("key") {
        return Output::ok(json!({ "key": key }));
    }
    let q = match job::question(input, KIND, caller) {
        Ok(q) => q,
        Err(e) => return Output::fail(e),
    };
    if q.deliver {
        return deliver(&q, caller, chains, keep, &judge);
    }
    let read = match job::read(&q, KIND, caller, &key, chains) {
        Ok(r) => r,
        Err(e) => return Output::fail(e),
    };
    if q.check {
        return match check(&read, &q.contract, secrets, &judge) {
            Ok((found, suite_text)) => match keep.keep(&tests_key(&q.contract, &read), suite_text.as_bytes(), false) {
                Ok(()) => Output::check(&q.job, KIND, Ok(found)),
                Err(e) => Output::fail(e),
            },
            Err(why) => Output::check(&q.job, KIND, Err(why)),
        };
    }
    let suite = match kept_set(&read, &q.contract, keep) {
        Ok(s) => s,
        Err(e) => return Output::fail(e),
    };
    let v = judge_works(&read, &q.contract, q.appeal, &suite, &judge);
    if let Some(w) = v.winner {
        let won = serde_json::to_vec(&job::won(&read, w, None)).unwrap_or_default();
        if let Err(e) = keep.keep(&job::won_key(&q.contract, &q.job, w), &won, false) {
            return Output::fail(e);
        }
    }
    Output::verdict(&q.job, v)
}

/// Where the check keeps the test set, in the project's private storage: under the contract and the job it was checked
/// for, and its sha256. Only that job's verdicts read it.
pub fn tests_key(contract: &str, read: &Read) -> String {
    format!("tests/{contract}/{}/{}", read.job.id, read.job.terms.rubric.as_deref().unwrap_or_default())
}

/// The check before any mask starts: the client's test set is the one the job published and the bar describes, and the
/// client's own solution, sealed for this judge, passes at least `win_at` of its cases. `Err` refuses the job: the
/// contract sends the client everything back, since nobody has worked yet. `Ok` carries the set's exact text, which the
/// judge keeps.
pub fn check(
    read: &Read,
    contract: &str,
    secrets: &Secrets,
    judge: &sealed::JudgeSecret,
) -> Result<(Map<String, Value>, String), String> {
    let suite = test_set(read, secrets)?;
    let bar = read.job.terms.bar.as_ref().ok_or("the job sets no bar")?;
    let reference = bar.reference.as_deref().ok_or("the job carries no solution of the client's")?;
    let module = sealed::open(judge, contract, &read.job.id, &read.job.client, reference)
        .map_err(|e| format!("the client's solution is not a work this judge opens: {e}"))?;
    let engine = run::engine();
    let loaded = run::load(&engine, &module).map_err(|e| format!("the client's solution does not load: {e}"))?;
    let report = run::run(&engine, &loaded, &suite, &run::orders(suite.cases.len(), false, &read.job.id)[0]);
    let (passed, of) = (report.passed(), suite.cases.len());
    if passed < suite.win_at {
        return Err(format!("the client's own solution passes {passed} of {of} cases, below win_at {}", suite.win_at));
    }
    let mut found = Map::new();
    found.insert("win_at".into(), json!(suite.win_at));
    found.insert("cases".into(), json!(of));
    found.insert("fuel".into(), json!(suite.fuel));
    found.insert("reference".into(), json!({ "passed": passed, "of": of }));
    Ok((found, secrets.tests.clone().unwrap_or_default()))
}

/// The client's test set, exactly as the job published its hash and its bar, from the client's own secrets: the check
/// reads it there, once.
pub fn test_set(read: &Read, secrets: &Secrets) -> Result<suite::Suite, String> {
    let terms = &read.job.terms;
    let named = terms.secrets.as_ref().ok_or("the job names no secrets that hold its test set")?;
    let text = secrets.tests.as_deref().filter(|t| !t.is_empty()).ok_or("the client's test set is not in its secrets")?;
    if secrets.tests_owner.as_deref() != Some(read.job.client.as_str())
        || named.account_id != read.job.client
        || secrets.tests_profile.as_deref() != Some(named.profile.as_str())
    {
        return Err("the test set did not come from the client's own secrets for this job".into());
    }
    set_of(read, text)
}

/// The test set the check kept for this job, for a verdict. Gone or changed is the judge's own storage failing, not the
/// client: no verdict, and the job waits for the judge again.
pub fn kept_set(read: &Read, contract: &str, keep: &dyn Keep) -> Result<suite::Suite, String> {
    let bytes = keep
        .load(&tests_key(contract, read), false)?
        .ok_or("the test set the check kept is not in the judge's storage")?;
    let text = String::from_utf8(bytes).map_err(|_| "the test set the check kept is not text")?;
    set_of(read, &text).map_err(|e| format!("the test set the check kept: {e}"))
}

/// A test set's text, checked against the job's hash and bar.
fn set_of(read: &Read, text: &str) -> Result<suite::Suite, String> {
    let terms = &read.job.terms;
    let rubric = terms.rubric.as_deref().ok_or("the job published no test set hash")?;
    if job::sha256_hex(text.as_bytes()) != rubric {
        return Err("the client's test set is not the one the job published".into());
    }
    let suite = suite::parse(text).map_err(|e| format!("the client's test set cannot run here: {e}"))?;
    let bar = terms.bar.as_ref().ok_or("the job sets no bar for its test set")?;
    let fuel = bar.fuel.as_deref().and_then(|f| f.parse::<u64>().ok());
    if bar.win_at != suite.win_at || bar.cases != Some(suite.cases.len() as u32) || fuel != Some(suite.fuel) {
        return Err("the client's test set is not what the job's bar says: win_at, cases and fuel".into());
    }
    Ok(suite)
}

/// Once the job is paid: the winner's boxes, kept at the verdict, opened in the TEE and sealed again for the client's
/// key. The box goes to the project's public storage; the answer names where, with its sha256.
pub fn deliver(q: &job::Input, caller: &Caller, chains: &[&dyn Chain], keep: &dyn Keep, judge: &sealed::JudgeSecret) -> Output {
    match job::delivery(q, caller, chains, keep, judge, KIND) {
        Ok((at, sha)) => Output::delivered(&q.job, &at, &sha),
        Err(e) => Output::fail(e),
    }
}

/// Works an appeal runs three times, best first, until one holds: the most one appeal costs the judge is bounded.
pub const MAX_RECHECKS: usize = 3;

/// One striker's work and how it did.
#[derive(Debug, Clone, PartialEq)]
pub struct Judged {
    pub step: u32,
    pub entrant: u32,
    /// Cases passed in every run.
    pub passed: u32,
    /// On appeal: the set ran three times on this work, and whether every run gave the same result.
    pub runs: u32,
    pub stable: bool,
    /// Why the work did not run, when it did not.
    pub invalid: Option<String>,
}

pub fn judge_works(
    read: &Read,
    contract: &str,
    appeal: bool,
    suite: &suite::Suite,
    judge: &sealed::JudgeSecret,
) -> Verdict {
    let engine = run::engine();
    let orders = run::orders(suite.cases.len(), appeal, &read.job.id);
    let mut judged: Vec<Judged> = vec![];
    let mut loaded: Vec<Option<(wasmi::Module, run::Report)>> = vec![];
    for step in works(read) {
        let content = step.content.as_deref().unwrap_or_default();
        let module = sealed::open(judge, contract, &read.job.id, &step.mask, content);
        let mut j = Judged { step: step.seq, entrant: step.entrant, passed: 0, runs: 1, stable: true, invalid: None };
        match module.and_then(|m| run::load(&engine, &m).map_err(String::from)) {
            Err(why) => {
                j.invalid = Some(why);
                loaded.push(None);
            }
            Ok(module) => {
                let report = run::run(&engine, &module, suite, &orders[0]);
                j.passed = report.passed();
                loaded.push(Some((module, report)));
            }
        }
        judged.push(j);
    }
    if appeal {
        // The works that could win, best first: each runs the set twice more, backwards and shuffled. The first whose
        // three runs agree case by case may win; one that differs may not.
        let mut candidates: Vec<usize> = (0..judged.len()).filter(|i| judged[*i].passed >= suite.win_at).collect();
        candidates.sort_by(|a, b| judged[*b].passed.cmp(&judged[*a].passed).then(judged[*a].step.cmp(&judged[*b].step)));
        for i in candidates.into_iter().take(MAX_RECHECKS) {
            let (module, first) = loaded[i].as_ref().expect("a candidate ran");
            let again: Vec<run::Report> = orders[1..].iter().map(|o| run::run(&engine, module, suite, o)).collect();
            let j = &mut judged[i];
            j.runs = 3;
            j.stable = again.iter().all(|r| r.cases == first.cases);
            j.passed = again.iter().map(run::Report::passed).chain([j.passed]).min().unwrap_or(0);
            if j.stable {
                break;
            }
        }
    }
    verdict(read, contract, suite, &judged, appeal, judge)
}

/// Each striker mask's work: its latest revealed step that is sealed for the judge. Unsealed work does not count.
fn works(read: &Read) -> Vec<&job::Step> {
    let mut latest: Vec<&job::Step> = vec![];
    for s in read.eligible().filter(|s| s.role == Role::Striker) {
        if !s.content.as_deref().unwrap_or_default().starts_with(sealed::PREFIX) {
            continue;
        }
        match latest.iter_mut().find(|w| w.mask == s.mask) {
            Some(w) if s.seq > w.seq => *w = s,
            Some(_) => {}
            None => latest.push(s),
        }
    }
    latest.sort_by_key(|s| s.seq);
    latest
}

fn verdict(read: &Read, contract: &str, suite: &suite::Suite, judged: &[Judged], appeal: bool, judge: &sealed::JudgeSecret) -> Verdict {
    // On a tie the earlier seal wins: it wins the reward and nothing else, since a lost bond goes to the company.
    let winner = judged
        .iter()
        .filter(|j| j.stable && j.invalid.is_none() && j.passed >= suite.win_at && (!appeal || j.runs == 3))
        .max_by(|a, b| a.passed.cmp(&b.passed).then(b.step.cmp(&a.step)))
        .map(|j| j.entrant);
    let real: Vec<&Judged> = judged.iter().filter(|j| j.passed >= 1).collect();
    let opens = |s: &job::Step| {
        sealed::open_work(judge, contract, &read.job.id, &s.mask, s.content.as_deref().unwrap_or_default()).is_ok()
    };
    let mut counted: Vec<u32> = real.iter().map(|j| j.step).collect();
    counted.extend(
        read.eligible()
            .filter(|s| s.role != Role::Striker && real.iter().any(|j| j.entrant == s.entrant) && opens(s))
            .map(|s| s.seq),
    );
    // Fake only for objective reasons: a striker's work that does not open, holds no module or holds one that does not
    // load, and any other box that does not open for its mask. Never for the cases it failed: the set is private.
    let mut fake: Vec<u32> = judged.iter().filter(|j| j.invalid.is_some()).map(|j| j.step).collect();
    fake.extend(
        read.eligible()
            .filter(|s| !judged.iter().any(|j| j.step == s.seq) && !opens(s))
            .map(|s| s.seq)
            .collect::<Vec<_>>(),
    );
    let works: Vec<Value> = judged
        .iter()
        .map(|j| {
            let mut w = json!({ "step": j.step, "entrant": j.entrant, "passed": j.passed, "of": suite.cases.len() });
            if j.runs > 1 {
                w["runs"] = json!(j.runs);
            }
            if !j.stable {
                w["unstable"] = json!(true);
            }
            if let Some(why) = &j.invalid {
                w["invalid"] = json!(why);
            }
            w
        })
        .collect();
    let mut extra = Map::new();
    extra.insert("judge".into(), json!(KIND));
    extra.insert("rule".into(), json!(if appeal { "tests, three runs" } else { "tests" }));
    extra.insert("works".into(), json!(works));
    Verdict { winner, counted, fake, undecided: false, extra }
}

#[cfg(test)]
mod tests {
    use super::job::testing::*;
    use super::run::tests::{wasm, REVERSE};
    use super::sealed::{seal, JudgePublic};
    use super::*;

    const SEED: &str = "0707070707070707070707070707070707070707070707070707070707070707";
    const TESTS: &str = r#"{"format":"maskwars-tests/v1","fuel":20000,"win_at":2,"cases":[{"input":"abc","expect":"cba"},{"input":"near","expect":"raen"},{"input":"maskwars","expect":"srawksam"}]}"#;
    /// Right on every input of at most 4 bytes, wrong on longer ones.
    const SHORT: &str = r#"(module (memory (export "memory") 1)
      (func (export "alloc") (param i32) (result i32) (i32.const 64))
      (func (export "run") (param $p i32) (param $n i32) (result i64)
        (if (i32.gt_u (local.get $n) (i32.const 4)) (then (return (i64.const 0))))
        (if (i32.eq (local.get $n) (i32.const 3)) (then
          (i32.store8 (i32.const 128) (i32.load8_u (i32.const 66)))
          (i32.store8 (i32.const 129) (i32.load8_u (i32.const 65)))
          (i32.store8 (i32.const 130) (i32.load8_u (i32.const 64)))
          (return (i64.const 0x0000008000000003))))
        (i32.store8 (i32.const 128) (i32.load8_u (i32.const 67)))
        (i32.store8 (i32.const 129) (i32.load8_u (i32.const 66)))
        (i32.store8 (i32.const 130) (i32.load8_u (i32.const 65)))
        (i32.store8 (i32.const 131) (i32.load8_u (i32.const 64)))
        (i64.const 0x0000008000000004)))"#;

    fn public() -> JudgePublic {
        JudgePublic::from(&sealed::judge_secret(&[7; 32]))
    }

    fn boxed(mask: &str, module: &[u8]) -> String {
        seal(&public(), "jobs.testnet", "job-1", mask, module, [mask.len() as u8; 32], [3; 12]).unwrap()
    }

    fn secrets(tests: Option<&str>) -> Secrets {
        Secrets {
            seed: Some(SEED.into()),
            tests: tests.map(String::from),
            tests_owner: Some("dao.testnet".into()),
            tests_profile: Some("job-1".into()),
        }
    }

    /// The bar a job publishes for this test set, with the client's own solution sealed for the judge.
    fn bar(tests: &str, solution: &str) -> Value {
        let t: Value = serde_json::from_str(tests).unwrap();
        json!({ "win_at": t["win_at"], "cases": t["cases"].as_array().unwrap().len(), "fuel": t["fuel"].to_string(),
                "reference": boxed("dao.testnet", &wasm(solution)) })
    }

    /// A tee_tests job: NOVA (0) a crew with a scout, ONYX (1) and VOLT (2) alone. It pinned this judge and its key.
    fn chain(steps: Vec<Value>, tests: &str) -> Canned {
        let mut job = job("tee_tests", 3, steps.len() as u32);
        job["terms"]["judge"]["key"] = json!(sealed::key_text(&public()));
        job["terms"]["rubric"] = json!(job::sha256_hex(tests.as_bytes()));
        job["terms"]["secrets"] = json!({ "profile": "job-1", "account_id": "dao.testnet" });
        job["terms"]["bar"] = bar(tests, REVERSE);
        let duo = json!({ "crew": "duo", "version": 1, "members": [{ "mask": "kira.testnet", "role": "scout" },
                          { "mask": "nova.testnet", "role": "striker" }], "split": { "scout": 3000, "striker": 7000, "verifier": 0 } });
        Canned::new(job, json!([duo, solo("onyx.testnet"), solo("volt.testnet")]), json!(steps))
    }

    /// The check, then the question: the judge keeps the set at the check, and every later run reads that.
    fn kept(c: &Canned, tests: &str) -> Kept {
        let kept = Kept::default();
        let mut cc = Canned::new(c.job.clone(), c.entrants.clone(), c.steps.clone());
        cc.job["steps"] = json!(c.steps.as_array().unwrap().len());
        let input = json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests", "check": true });
        let out = answer(Some(input), &local(), &secrets(Some(tests)), &[&cc], &kept);
        assert_eq!(out.output.as_ref().map(|o| o["checked"].clone()), Some(json!(true)), "{out:?}");
        kept
    }

    fn ask_with(c: &Canned, secrets: &Secrets, kept: &Kept, appeal: bool) -> Output {
        let input = json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests", "appeal": appeal, "prior": null });
        let out = answer(Some(input), &caller("maskwars.testnet/tee_tests"), secrets, &[c], kept);
        assert!(out.len() <= job::MAX_REPLY_BYTES);
        out
    }

    /// The check passes on the client's row, then the verdict runs on what the check kept: no secrets named.
    fn ask(c: &Canned, tests: &str, appeal: bool) -> Value {
        let kept = kept(c, tests);
        let out = ask_with(c, &secrets(None), &kept, appeal);
        assert!(out.success, "{out:?}");
        out.output.unwrap()
    }

    fn text_box(mask: &str, text: &str) -> String {
        sealed::seal_text(&public(), "jobs.testnet", "job-1", mask, text, [mask.len() as u8 + 1; 32], [4; 12]).unwrap()
    }

    #[test]
    fn the_work_that_passes_the_most_cases_wins_every_real_attempt_counts_and_junk_is_fake() {
        let onyx = boxed("onyx.testnet", &wasm(SHORT));
        let nova = boxed("nova.testnet", &wasm(REVERSE));
        let junk = boxed("volt.testnet", b"\0asm\x01\0\0\0");
        let c = chain(
            vec![
                step(0, 1, "onyx.testnet", "striker", Some(&onyx), None),
                step(1, 0, "kira.testnet", "scout", Some(&text_box("kira.testnet", "finding: the input is bytes, not characters")), None),
                step(2, 0, "nova.testnet", "striker", Some(&text_box("nova.testnet", "draft: plain text is not work")), None),
                step(3, 0, "nova.testnet", "striker", Some(&nova), None),
                step(4, 2, "volt.testnet", "striker", Some(&junk), None),
            ],
            TESTS,
        );
        let o = ask(&c, TESTS, false);
        assert_eq!(o["winner"], json!(0), "{o}");
        assert_eq!(o["counted"], json!([0, 1, 3]), "NOVA's draft was superseded by its work");
        assert_eq!(o["fake"], json!([4]), "VOLT's empty module exports nothing: it does not load, fake");
        assert_eq!(o["rule"], "tests");
        assert_eq!(o["works"][0], json!({ "step": 0, "entrant": 1, "passed": 2, "of": 3 }));
        assert_eq!(o["works"][1], json!({ "step": 3, "entrant": 0, "passed": 3, "of": 3 }));
        assert_eq!((o["works"][2]["passed"].clone(), o["works"][2]["invalid"].clone()), (json!(0), json!("a work module exports its memory")));
        // The same inputs give the same verdict, byte for byte.
        assert_eq!(ask(&c, TESTS, false), o);
    }

    #[test]
    fn a_tie_goes_to_the_earlier_seal_and_win_at_is_a_floor() {
        let a = boxed("onyx.testnet", &wasm(SHORT));
        let b = boxed("volt.testnet", &wasm(SHORT));
        let c = chain(
            vec![step(0, 2, "volt.testnet", "striker", Some(&b), None), step(1, 1, "onyx.testnet", "striker", Some(&a), None)],
            TESTS,
        );
        let o = ask(&c, TESTS, false);
        assert_eq!((o["winner"].clone(), o["counted"].clone(), o["fake"].clone()), (json!(2), json!([0, 1]), json!([])));

        let strict = TESTS.replace(r#""win_at":2"#, r#""win_at":3"#);
        let mut c = chain(vec![step(0, 1, "onyx.testnet", "striker", Some(&a), None)], &strict);
        c.job["terms"]["bar"] = bar(&strict, REVERSE);
        let o = ask(&c, &strict, false);
        assert_eq!((o["winner"].clone(), o["counted"].clone()), (Value::Null, json!([0])), "a real attempt below the floor");
    }

    /// Finding 1 of the second review: after the check the client swapped its test set and appealed, and the judge
    /// read the swapped set from the client's row, answered `shared`, and puppets took parts. Now the check keeps the
    /// set, every later run reads only that, and the contract names no secrets after the check: hiding or swapping the
    /// row changes nothing. A kept set that is gone is the judge's own failure: no verdict, never a share.
    #[test]
    fn after_the_check_the_judge_reads_only_the_set_it_kept() {
        let nova = boxed("nova.testnet", &wasm(REVERSE));
        let c = chain(
            vec![
                step(0, 1, "onyx.testnet", "striker", Some(&boxed("onyx.testnet", &wasm(SHORT))), None),
                step(1, 0, "nova.testnet", "striker", Some(&nova), None),
            ],
            TESTS,
        );
        let kept = kept(&c, TESTS);
        assert_eq!(kept.private(&format!("tests/jobs.testnet/job-1/{}", job::sha256_hex(TESTS.as_bytes()))).unwrap(), TESTS.as_bytes());
        let swapped = TESTS.replace("srawksam", "srawksaM");
        for (row, appeal) in [(None, false), (Some(swapped.as_str()), false), (Some(swapped.as_str()), true)] {
            let o = ask_with(&c, &secrets(row), &kept, appeal).output.unwrap();
            assert_eq!((o["winner"].clone(), o.get("shared")), (json!(0), None), "{o}");
        }
        let out = ask_with(&c, &secrets(Some(TESTS)), &Kept::default(), false);
        assert_eq!((out.success, out.error.as_deref()), (false, Some("the test set the check kept is not in the judge's storage")));
    }

    /// Finding 4: the client's material is checked before any mask starts. The set must be the published one and the
    /// bar's, and the client's own solution, sealed for this judge, must pass `win_at`: a set nobody can pass, or one
    /// the client cannot pass itself, never opens to masks.
    #[test]
    fn the_check_runs_the_client_s_own_solution_before_any_mask_starts() {
        let check = |c: &Canned, s: &Secrets| {
            let input = json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests", "appeal": false, "prior": null, "check": true });
            let out = answer(Some(input), &local(), s, &[c], &Kept::default());
            assert!(out.success && out.len() <= job::MAX_REPLY_BYTES, "{out:?}");
            out.output.unwrap()
        };
        let o = check(&chain(vec![], TESTS), &secrets(Some(TESTS)));
        assert_eq!(o, json!({ "job": "job-1", "judge": "tee_tests", "checked": true, "win_at": 2, "cases": 3, "fuel": 20000,
                              "reference": { "passed": 3, "of": 3 } }));
        // The client's solution passes 2 of 3; the set asks for 3.
        let strict = TESTS.replace(r#""win_at":2"#, r#""win_at":3"#);
        let mut c = chain(vec![], &strict);
        c.job["terms"]["bar"] = bar(&strict, SHORT);
        let o = check(&c, &secrets(Some(&strict)));
        assert_eq!((o["checked"].clone(), o["why"].as_str()), (json!(false), Some("the client's own solution passes 2 of 3 cases, below win_at 3")));
        // A solution sealed under another name, a set that is not in the secrets or not the bar's: refused.
        let mut c = chain(vec![], TESTS);
        c.job["terms"]["bar"]["reference"] = json!(boxed("mallory.testnet", &wasm(REVERSE)));
        assert!(check(&c, &secrets(Some(TESTS)))["why"].as_str().unwrap().starts_with("the client's solution is not a work this judge opens"));
        assert_eq!(check(&chain(vec![], TESTS), &secrets(None))["why"], "the client's test set is not in its secrets");
        let mut other_row = secrets(Some(TESTS));
        other_row.tests_owner = Some("mallory.testnet".into());
        assert_eq!(check(&chain(vec![], TESTS), &other_row)["why"], "the test set did not come from the client's own secrets for this job");
        let mut c = chain(vec![], TESTS);
        c.job["terms"]["bar"]["cases"] = json!(4);
        assert_eq!(check(&c, &secrets(Some(TESTS)))["checked"], false);
        // The contract holds the bar it can: a set this judge cannot run is refused here.
        let broken = r#"{"format":"maskwars-tests/v1","fuel":5,"win_at":1,"cases":[{"input":"a","expect":"a"}]}"#;
        assert!(check(&chain(vec![], broken), &secrets(Some(broken)))["why"].as_str().unwrap().starts_with("the client's test set cannot run here"));
    }

    #[test]
    fn work_sealed_for_another_mask_or_holding_no_module_is_fake() {
        // ONYX copies NOVA's box under its own name: the box names NOVA, so it does not open for ONYX.
        let nova = boxed("nova.testnet", &wasm(REVERSE));
        let c = chain(
            vec![
                step(0, 1, "onyx.testnet", "striker", Some(&nova), None),
                step(1, 2, "volt.testnet", "striker", Some(&format!("{}A", &nova[..nova.len() - 1])), None),
                step(2, 0, "kira.testnet", "scout", Some(&nova), None),
            ],
            TESTS,
        );
        let o = ask(&c, TESTS, false);
        assert_eq!((o["winner"].clone(), o["counted"].clone(), o["fake"].clone()), (Value::Null, json!([]), json!([0, 1, 2])));
        assert_eq!(o["works"][0]["invalid"], "the box is not for this judge, job and mask");
        assert!(o["works"][1]["invalid"].is_string());
    }

    #[test]
    fn an_appeal_runs_three_times_and_agrees_with_a_stable_first_verdict() {
        let nova = boxed("nova.testnet", &wasm(REVERSE));
        let onyx = boxed("onyx.testnet", &wasm(SHORT));
        let c = chain(
            vec![step(0, 1, "onyx.testnet", "striker", Some(&onyx), None), step(1, 0, "nova.testnet", "striker", Some(&nova), None)],
            TESTS,
        );
        let first = ask(&c, TESTS, false);
        let appeal = ask(&c, TESTS, true);
        assert_eq!((appeal["winner"].clone(), appeal["counted"].clone()), (first["winner"].clone(), first["counted"].clone()));
        assert_eq!(appeal["rule"], "tests, three runs");
        // NOVA, the best, ran the set three times and held; ONYX, which could win too, needed no recheck.
        assert_eq!(appeal["works"][1], json!({ "step": 1, "entrant": 0, "passed": 3, "of": 3, "runs": 3 }));
        assert_eq!(appeal["works"][0], first["works"][0]);
    }

    /// Decision 1 of the second review: the client gets the winner's work alone, and only once the job is paid. The
    /// verdict keeps the winner's boxes; a delivery before the job is paid is refused; after it, the work is sealed for
    /// the client's key, and nobody else's work is in it.
    #[test]
    fn the_winner_s_work_goes_to_the_client_alone_once_the_job_is_paid() {
        let nova_module = wasm(REVERSE);
        let c = chain(
            vec![
                step(0, 1, "onyx.testnet", "striker", Some(&boxed("onyx.testnet", &wasm(SHORT))), None),
                step(1, 0, "kira.testnet", "scout", Some(&text_box("kira.testnet", "finding: bytes")), None),
                step(2, 0, "nova.testnet", "striker", Some(&boxed("nova.testnet", &nova_module)), None),
            ],
            TESTS,
        );
        let client = x25519_dalek::StaticSecret::from([0xc1; 32]);
        let mut c = c;
        c.job["terms"]["client_key"] = json!(sealed::key_text(&x25519_dalek::PublicKey::from(&client)));
        let kept = kept(&c, TESTS);
        let o = ask_with(&c, &secrets(None), &kept, false).output.unwrap();
        assert_eq!(o["winner"], 0);
        assert!(kept.private("won/jobs.testnet/job-1/0").is_some(), "the winner's boxes are kept, privately");
        let deliver = |c: &Canned| {
            let input = json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests", "deliver": true });
            answer(Some(input), &local(), &secrets(None), &[c], &kept)
        };
        let out = deliver(&c);
        assert!(out.error.unwrap().ends_with("the winning work goes to the client once the job is paid"));
        c.job["status"] = json!({ "state": "paid", "winner": 0 });
        let o = deliver(&c).output.unwrap();
        assert_eq!(o["delivered"], "delivery/jobs.testnet/job-1");
        let boxed = String::from_utf8(kept.public("delivery/jobs.testnet/job-1").unwrap()).unwrap();
        assert_eq!(o["sha256"], json!(job::sha256_hex(boxed.as_bytes())));
        let work: Value = serde_json::from_slice(&sealed::open_delivery(&client, "jobs.testnet", "job-1", "dao.testnet", &boxed).unwrap()).unwrap();
        assert_eq!(work["entrant"], 0);
        assert_eq!(work["work"][0]["text"], "finding: bytes");
        assert_eq!(sealed::unb64url(work["work"][1]["module"].as_str().unwrap()).unwrap(), nova_module);
        assert!(!work.to_string().contains("onyx"), "work that did not win is never sealed for anyone");
        assert!(sealed::open_delivery(&x25519_dalek::StaticSecret::from([0x0e; 32]), "jobs.testnet", "job-1", "dao.testnet", &boxed).is_err());
    }

    #[test]
    fn the_key_comes_from_the_tee_seed_and_nothing_runs_without_it() {
        let out = answer(Some(json!({ "action": "key" })), &Caller::default(), &secrets(None), &[], &Kept::default());
        assert_eq!(out.output.unwrap()["key"], sealed::key_text(&public()));
        let out = answer(Some(json!({ "action": "key" })), &Caller::default(), &Secrets::default(), &[], &Kept::default());
        assert_eq!(out.error.as_deref(), Some("the judge has no key in this TEE"));
    }

    /// Third review, finding 2. The client's puppet ONYX knows the private set and wins with a work that passes all of
    /// it; NOVA and VOLT, who could not see the set, send works that load and run but pass no case. Before, both were
    /// fake and their bonds went to the winner: the puppet collected them. Now a work that loads is never fake for the
    /// cases it failed, and the contract would give a fake one's bond to the company anyway. A tie still goes to the
    /// earlier seal, which wins the reward and nothing more. Fourth review, finding 1: such a work is not counted either,
    /// and `counted` is how the judge tells the contract a seat gave the job something: NOVA's and VOLT's seats pay half
    /// their bonds there, so fifteen puppets with a module that loads and passes nothing no longer hold slots for free.
    #[test]
    fn a_work_that_loads_and_fails_the_private_set_is_never_fake() {
        let zero = r#"(module (memory (export "memory") 1)
          (func (export "alloc") (param i32) (result i32) (i32.const 64))
          (func (export "run") (param i32 i32) (result i64) (i64.const 0x0000008000000001)))"#;
        let c = chain(
            vec![
                step(0, 1, "onyx.testnet", "striker", Some(&boxed("onyx.testnet", &wasm(REVERSE))), None),
                step(1, 0, "nova.testnet", "striker", Some(&boxed("nova.testnet", &wasm(zero))), None),
                step(2, 2, "volt.testnet", "striker", Some(&boxed("volt.testnet", &wasm(zero))), None),
            ],
            TESTS,
        );
        let o = ask(&c, TESTS, false);
        assert_eq!((o["winner"].clone(), o["counted"].clone(), o["fake"].clone()), (json!(1), json!([0]), json!([])), "{o}");
        assert_eq!(o["works"][1], json!({ "step": 1, "entrant": 0, "passed": 0, "of": 3 }), "it ran: a work, not fake");
        assert!(!o["counted"].as_array().unwrap().iter().any(|s| s == 1 || s == 2), "and no step of a work that passes nothing counts");
        let appeal = ask(&c, TESTS, true);
        assert_eq!((appeal["winner"].clone(), appeal["fake"].clone()), (json!(1), json!([])), "the appeal agrees: {appeal}");
    }

    /// Third review, finding 3: the check kept the set under its sha256 alone, so any job naming the same hash read it.
    /// Now it is kept under the contract and the job it was checked for: another job's verdict, with the same hash, finds
    /// nothing to run and gives no verdict.
    #[test]
    fn a_set_kept_for_one_job_is_read_by_that_job_alone() {
        let nova = boxed("nova.testnet", &wasm(REVERSE));
        let c = chain(vec![step(0, 0, "nova.testnet", "striker", Some(&nova), None)], TESTS);
        let kept = kept(&c, TESTS);
        let mut other = Canned::new(c.job.clone(), c.entrants.clone(), c.steps.clone());
        other.job["id"] = json!("job-2");
        let input = json!({ "job": "job-2", "contract": "jobs.testnet", "kind": "tee_tests" });
        let out = answer(Some(input), &local(), &secrets(None), &[&other], &kept);
        assert_eq!(out.error.as_deref(), Some("the test set the check kept is not in the judge's storage"));
        assert_eq!(kept.0.borrow().keys().filter(|(_, k)| k.starts_with("tests/")).count(), 1);
    }

    /// Third review, findings 3 and 5: a contract that is not the one written into the judge gets nothing, even for a
    /// job that looks like ours; a job of ours pinned to another key gets no check, verdict or delivery.
    #[test]
    fn a_contract_not_written_in_or_a_job_pinned_to_another_key_gets_nothing() {
        let nova = boxed("nova.testnet", &wasm(REVERSE));
        let c = chain(vec![step(0, 0, "nova.testnet", "striker", Some(&nova), None)], TESTS);
        let kept = kept(&c, TESTS);
        let fake = json!({ "job": "job-1", "contract": "fake-jobs.testnet", "kind": "tee_tests", "check": true });
        let itself = Caller { predecessor: Some("fake-jobs.testnet".into()), project: None, served: vec!["jobs.testnet".into()] };
        let out = answer(Some(fake), &itself, &secrets(Some(TESTS)), &[&c], &kept);
        assert_eq!(out.error.as_deref(), Some("this judge serves only the jobs contract written into it"));
        let mut other = Canned::new(c.job.clone(), c.entrants.clone(), c.steps.clone());
        other.job["terms"]["judge"]["key"] = json!(sealed::key_text(&JudgePublic::from(&sealed::judge_secret(&[8; 32]))));
        for input in [
            json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests", "check": true }),
            json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests" }),
        ] {
            let out = answer(Some(input), &local(), &secrets(Some(TESTS)), &[&other], &kept);
            assert!(!out.success && out.error.unwrap().starts_with("the job pinned another judge key"));
        }
        other.job["status"] = json!({ "state": "paid", "winner": 0 });
        let input = json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests", "deliver": true });
        let out = answer(Some(input), &local(), &secrets(None), &[&other], &kept);
        assert!(out.error.unwrap().starts_with("the job pinned another judge key"));
    }
}
