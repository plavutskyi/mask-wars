//! The judge's work runner as a bare Wasm module, so `sandbox/tests/budget.rs` can run it inside a fuelled
//! interpreter and count the instructions a judge run spends, the way OutLayer meters the judge.

use maskwars_judge_tests::job::{Entrant, Job, Member, Read, Role, Status, Step, Terms};
use maskwars_judge_tests::sealed;
use maskwars_judge_tests::{judge_works, suite};

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len as usize);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Judges a job of `works` strikers, each with `module` sealed for the judge in its step, on the test set `tests`, as
/// a first verdict or an appeal. Returns the winner (or -1), -2 if the set is refused.
///
/// # Safety
/// Both ranges were written by the host through `alloc`.
#[no_mangle]
pub unsafe extern "C" fn judge(module: *const u8, module_len: u32, tests: *const u8, tests_len: u32, works: u32, appeal: u32) -> i64 {
    let module = std::slice::from_raw_parts(module, module_len as usize);
    let tests = std::str::from_utf8(std::slice::from_raw_parts(tests, tests_len as usize)).unwrap_or("");
    let Ok(set) = suite::parse(tests) else { return -2 };
    let judge = sealed::judge_secret(&[7; 32]);
    let public = sealed::JudgePublic::from(&judge);
    let (mut entrants, mut steps) = (vec![], vec![]);
    for i in 0..works {
        let mask = format!("mask-{i}.masks.testnet");
        let content = sealed::seal(&public, "jobs.testnet", "job-1", &mask, module, [i as u8 + 1; 32], [1; 12]).unwrap();
        entrants.push(Entrant { crew: None, members: vec![Member { mask: mask.clone(), role: Role::Striker }] });
        steps.push(Step { seq: i, entrant: i, mask, role: Role::Striker, content: Some(content), copy_of: None });
    }
    let read = Read {
        job: Job {
            id: "job-1".into(),
            client: "dao.testnet".into(),
            terms: Terms {
                kind: "tee_tests".into(),
                brief: "b".into(),
                spec: "a".repeat(64),
                rubric: None,
                judge: None,
                secrets: None,
                bar: None,
                client_key: None,
            },
            status: Status { state: "judging".into(), winner: None },
            entrants: works,
            steps: works,
        },
        entrants,
        steps,
        block: 1,
        time_ns: 0,
    };
    judge_works(&read, "jobs.testnet", appeal == 1, &set, &judge).winner.map_or(-1, i64::from)
}

/// Reads one RPC answer to a view with the judge's own code (`job::decode`): `kind` 0 is `steps`, 1 `get`, 2
/// `entrants`. Returns how many items it read.
///
/// # Safety
/// The range was written by the host through `alloc`.
#[no_mangle]
pub unsafe extern "C" fn rpc(body: *const u8, len: u32, kind: u32) -> i64 {
    use maskwars_judge_tests::job::decode;
    let body = std::str::from_utf8(std::slice::from_raw_parts(body, len as usize)).unwrap_or("");
    match kind {
        0 => decode::<Vec<Step>>(body).map_or(-1, |s| s.len() as i64),
        1 => decode::<Job>(body).map_or(-1, |_| 1),
        _ => decode::<Vec<Entrant>>(body).map_or(-1, |e| e.len() as i64),
    }
}
