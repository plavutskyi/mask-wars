//! Does the worst judge run fit OutLayer's instruction limit? The jobs contract asks OutLayer for 1e9 instructions a
//! run (`ask_judge`). Here the judge's own code (`judge_works`, built for a bare Wasm host by `../bench` with the
//! judge's release profile) runs inside a fuelled interpreter that counts every instruction it spends, the way
//! OutLayer meters the module: opening each box, loading each module, running every case. The interpreter here charges bulk memory operations per 64 bytes, OutLayer's metering per operation:
//! the count is on the high side.
//!
//! The worst job: 16 strikers, each with a 638-byte module (all a box holds) that reaches all its code, declares 4 MiB of memory and burns
//! every unit of fuel on every case; the test set at its limits. On appeal the works that could win run the set three
//! times, at most three of them.

use anyhow::{ensure, Context, Result};
use maskwars_judge_tests::run::MAX_MODULE;
use maskwars_judge_tests::suite::{MAX_CASES, MAX_SUITE_FUEL};
use maskwars_judge_tests::MAX_RECHECKS;
use serde_json::{json, Value};
use std::path::PathBuf;
use wasmi::{Config, Engine, Linker, Module, Store};

/// OutLayer's limit for a judge run, and the share of it the measured work may take: the rest is headroom for what is
/// not measured here (opening the test set, the verdict's JSON, OutLayer's own entry code).
const LIMIT: u64 = 1_000_000_000;
const SHARE: u64 = 85;
const WORKS: u32 = 16;

fn bench_wasm() -> Result<Vec<u8>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let target = root.join("target").join("bench");
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(&root)
        .env("CARGO_TARGET_DIR", &target)
        .env_remove("RUSTFLAGS")
        .args(["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "judge-tests-bench"])
        .status()
        .context("run cargo build")?;
    ensure!(status.success(), "the bench did not build");
    Ok(std::fs::read(target.join("wasm32-unknown-unknown/release/judge_tests_bench.wasm"))?)
}

/// Host instructions the judge spends on a job of `works` copies of `module`, and the winner it names.
fn judge(engine: &Engine, bench: &Module, module: &[u8], tests: &str, works: u32, appeal: bool) -> Result<(u64, i64)> {
    let mut store = Store::new(engine, ());
    let instance = Linker::<()>::new(engine).instantiate_and_start(&mut store, bench)?;
    let memory = instance.get_memory(&store, "memory").context("memory")?;
    let alloc = instance.get_typed_func::<u32, u32>(&store, "alloc")?;
    let run = instance.get_typed_func::<(u32, u32, u32, u32, u32, u32), i64>(&store, "judge")?;
    store.set_fuel(u64::MAX / 4)?;
    let m = alloc.call(&mut store, module.len() as u32)?;
    memory.write(&mut store, m as usize, module)?;
    let t = alloc.call(&mut store, tests.len() as u32)?;
    memory.write(&mut store, t as usize, tests.as_bytes())?;
    let before = store.get_fuel()?;
    let winner = run.call(&mut store, (m, module.len() as u32, t, tests.len() as u32, works, u32::from(appeal)))?;
    ensure!(winner >= -1, "the bench refused the job: {winner}");
    Ok((before - store.get_fuel()?, winner))
}

/// Host instructions to read one RPC answer to a view (0 `steps`, 1 `get`, 2 `entrants`), and the items it held.
fn parse(engine: &Engine, bench: &Module, body: &str, kind: u32) -> Result<(u64, i64)> {
    let mut store = Store::new(engine, ());
    let instance = Linker::<()>::new(engine).instantiate_and_start(&mut store, bench)?;
    let memory = instance.get_memory(&store, "memory").context("memory")?;
    let alloc = instance.get_typed_func::<u32, u32>(&store, "alloc")?;
    let rpc = instance.get_typed_func::<(u32, u32, u32), i64>(&store, "rpc")?;
    store.set_fuel(u64::MAX / 4)?;
    let b = alloc.call(&mut store, body.len() as u32)?;
    memory.write(&mut store, b as usize, body.as_bytes())?;
    let before = store.get_fuel()?;
    let n = rpc.call(&mut store, (b, body.len() as u32, kind))?;
    Ok((before - store.get_fuel()?, n))
}

/// A work of at most `MAX_MODULE` bytes that calls every function it has, then loops over its 4 MiB of memory until
/// `spin` rounds are done (or its fuel is), and answers `yes`.
fn worst(spin: u32) -> Result<Vec<u8>> {
    let head = format!(
        r#"(module (memory (export "memory") 64) (data (i32.const 0) "yes")
          (func (export "alloc") (param i32) (result i32) (i32.const 1024))
          (func (export "run") (param i32 i32) (result i64) (local $i i32) (local $x i32) CALLS
            (loop $l
              (i32.store (i32.add (i32.const 1024) (i32.and (i32.mul (local.get $i) (i32.const 4)) (i32.const 0x1ffffc))) (local.get $x))
              (local.set $x (i32.add (i32.mul (local.get $x) (i32.const 31)) (local.get $i)))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br_if $l (i32.lt_u (local.get $i) (i32.const {spin}))))
            (i64.const 3))"#
    );
    let func = |n: usize| {
        format!(
            "(func $f{n} (param $a i32) (result i32) {}(local.get $a))",
            "(local.set $a (i32.add (i32.mul (local.get $a) (i32.const 31)) (i32.const 7)))".repeat(6)
        )
    };
    let build = |n: usize| {
        let calls: String = (0..n).map(|i| format!("(local.set $x (call $f{i} (local.get $x)))")).collect();
        let funcs: String = (0..n).map(func).collect();
        wat::parse_str(format!("{}{funcs})", head.replace("CALLS", &calls)))
    };
    let mut n = 1;
    while build(n + 1)?.len() <= MAX_MODULE {
        n += 1;
    }
    Ok(build(n)?)
}

fn set(fuel: u64, cases: usize) -> String {
    let cases: Vec<_> = (0..cases).map(|i| json!({ "input": format!("case {i}"), "expect": "yes" })).collect();
    json!({ "format": "maskwars-tests/v1", "fuel": fuel, "cases": cases }).to_string()
}

#[test]
fn the_worst_judge_run_fits_outlayer_s_instruction_limit() -> Result<()> {
    let mut config = Config::default();
    config.consume_fuel(true);
    let engine = Engine::new(&config);
    let bench = Module::new(&engine, bench_wasm()?)?;
    ensure!(bench.imports().len() == 0, "the bench is a bare module");
    let fuel = MAX_SUITE_FUEL / MAX_CASES as u64;
    let tests = set(fuel, MAX_CASES);

    // Burns every unit of fuel on every case: the most a work costs in one pass.
    let burner = worst(u32::MAX)?;
    let (one, _) = judge(&engine, &bench, &burner, &tests, 1, false)?;
    let (all, winner) = judge(&engine, &bench, &burner, &tests, WORKS, false)?;
    ensure!(winner == -1, "a work that never answers passes nothing");
    println!("a {}-byte work burning all {MAX_SUITE_FUEL} fuel of {MAX_CASES} cases: {one} instructions", burner.len());
    println!("{WORKS} such works, first verdict: {all} instructions");

    // Passes every case with as little fuel to spare as it can: on appeal it runs the set twice more.
    let passes = |spin: u32| -> Result<bool> { Ok(judge(&engine, &bench, &worst(spin)?, &set(fuel, 1), 1, false)?.1 == 0) };
    let (mut lo, mut hi) = (1u32, 1u32 << 20);
    ensure!(passes(lo)? && !passes(hi)?, "the search brackets the most a passing work can spin");
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if passes(mid)? {
            lo = mid
        } else {
            hi = mid
        }
    }
    let passer = worst(lo)?;
    let (first, _) = judge(&engine, &bench, &passer, &tests, 1, false)?;
    let (again, winner) = judge(&engine, &bench, &passer, &tests, 1, true)?;
    ensure!(winner == 0, "the passing work wins its appeal");
    let recheck = again - first;
    println!("a work passing every case on its last units of fuel: {first} instructions; two more runs: {recheck}");
    let runner = all + MAX_RECHECKS as u64 * recheck;

    // Reading the job from each of two sources: the biggest `steps` answer (64 steps, each a 1024-byte reveal), the
    // biggest `entrants` (16 crews of 8) and the biggest job's view (its bar carries the client's sealed solution), each
    // as the RPC returns it, a byte array.
    let body = |view: Value| {
        json!({ "jsonrpc": "2.0", "id": "judge",
                "result": { "result": serde_json::to_vec(&view).unwrap(), "logs": [], "block_height": 1, "block_hash": "x" } })
        .to_string()
    };
    let steps: Vec<Value> = (0..64)
        .map(|i| json!({ "seq": i, "entrant": i / 4, "mask": format!("mask-{i}.masks.maskwars.testnet"), "role": "striker",
                         "hash": "a".repeat(64), "at_ns": "1762646400000000000", "content": "m".repeat(1024),
                         "digest": "b".repeat(64), "copy_of": null }))
        .collect();
    let crew = |c: usize| json!({ "crew": format!("crew-{c}"), "version": 1, "split": { "scout": 2000, "striker": 6000, "verifier": 2000 },
        "members": (0..8).map(|m| json!({ "mask": format!("mask-{c}-{m}.masks.maskwars.testnet"), "role": "striker" })).collect::<Vec<_>>() });
    let entrants: Vec<Value> = (0..16).map(crew).collect();
    let job = json!({ "id": "job-0001", "client": "dao.maskwars.testnet", "status": { "state": "judging", "height": "1", "run": 1 },
        "terms": { "kind": "tee_tests", "brief": "b".repeat(280), "spec": "a".repeat(64), "rubric": "b".repeat(64),
                   "judge": { "kind": "tee_tests", "project": "maskwars.near/tests", "version": "c".repeat(64) },
                   "secrets": { "profile": "p".repeat(64), "account_id": "dao.maskwars.testnet" },
                   "bar": { "win_at": 32, "cases": 32, "fuel": "15625", "reference": "r".repeat(1024) } },
        "masks": 16, "entrants": 16, "steps": 64, "runs": 1, "phase": "judging" });
    let mut read_one = 0;
    for (kind, view, n) in [(0, json!(steps), 64), (1, job, 1), (2, json!(entrants), 16)] {
        let (cost, got) = parse(&engine, &bench, &body(view), kind)?;
        ensure!(got == n, "the bench read view {kind}: {got}");
        read_one += cost;
    }
    let reading = 2 * read_one;
    println!("reading the job: {read_one} instructions for its three biggest views, {reading} from two sources");

    let worst_run = runner + reading;
    println!(
        "worst judge run: {WORKS} works {all} + {MAX_RECHECKS} rechecks × {recheck} + reading {reading} = {worst_run} of {LIMIT} ({}%)",
        worst_run * 100 / LIMIT
    );
    ensure!(worst_run <= LIMIT * SHARE / 100, "a judge run may take {SHARE}% of the limit: {worst_run}");
    Ok(())
}
