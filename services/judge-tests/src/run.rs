// Runs a work module on the test set: a WebAssembly interpreter inside the judge, so the same bytes give the same
// result on OutLayer, on a laptop and in the sandbox. Fuel stops a run (about one unit per Wasm instruction), NaNs
// are canonical, every case gets a fresh instance, and a module can import nothing: no clock, no randomness, no I/O.
//
// A module is validated whole when it loads and each function is translated the first time a case calls it. The
// translation is not charged to the case: a case burns the same fuel whichever case ran first, so a result never
// depends on the order of the cases. What translation costs the judge is bounded by the module's size
// (`MAX_MODULE`); the sandbox's budget test holds the worst judge run to OutLayer's instruction limit.
//
// What a work module is (any language that compiles to a WebAssembly core module):
//   (memory (export "memory") …)
//   (func (export "alloc") (param $len i32) (result i32))        where the judge may write `len` input bytes
//   (func (export "run") (param $ptr i32) (param $len i32) (result i64))
//                                                                 the output: (ptr << 32) | len, in the same memory
// Linear memory grows to 4 MiB at most; one table of 1024 elements at most.

use crate::suite::Suite;
use wasmi::{
    CompilationMode, Config, CustomFuelCosts, Engine, ExternType, Instance, Linker, Module, Store, StoreLimits,
    StoreLimitsBuilder, ValType,
};

/// The biggest work module the judge runs: what one sealed box carries.
pub const MAX_MODULE: usize = crate::sealed::MAX_INLINE;
pub const MAX_MEMORY_BYTES: usize = 4 << 20;
const MAX_TABLE_ELEMENTS: usize = 1024;
/// The deepest call stack a work may use.
const MAX_RECURSION: usize = 512;

/// One case: passed, or why not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Case {
    Pass,
    /// Ran and answered something else.
    Wrong,
    /// Trapped, ran out of fuel or memory, or broke the calling convention.
    Fail(&'static str),
}

/// A work on the whole test set, cases in the order given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub cases: Vec<Case>,
    /// Fuel the work burned over all its cases.
    pub fuel: u64,
}

impl Report {
    pub fn passed(&self) -> u32 {
        self.cases.iter().filter(|c| **c == Case::Pass).count() as u32
    }
}

struct Host {
    limits: StoreLimits,
}

pub fn engine() -> Engine {
    let mut config = Config::default();
    config
        .consume_fuel(true)
        .compilation_mode(CompilationMode::LazyTranslation)
        .fuel_cost(CustomFuelCosts { bytes_copied_per_fuel: 64, fuel_per_bytes_translated: 0, fuel_per_bytes_validated: 0 })
        .set_max_recursion_depth(MAX_RECURSION)
        .wasm_multi_memory(false)
        .wasm_custom_page_sizes(false);
    Engine::new(&config)
}

/// Checks a module once: at most `MAX_MODULE` bytes, valid, importing nothing, and exporting what every work exports:
/// its memory, `alloc(i32) -> i32` and `run(i32, i32) -> i64`. A module that fails any of these does not load: it is
/// objectively no work, whatever the test set, since no case could ever call it. One that loads is a work, even if it
/// passes no case of a private set.
pub fn load(engine: &Engine, bytes: &[u8]) -> Result<Module, &'static str> {
    if bytes.len() > MAX_MODULE {
        return Err("the work module is over 638 bytes");
    }
    let module = Module::new(engine, bytes).map_err(|_| "not a valid WebAssembly module")?;
    if module.imports().len() > 0 {
        return Err("a work module imports nothing");
    }
    let export = |name: &str| module.exports().find(|e| e.name() == name).map(|e| e.ty().clone());
    if !matches!(export("memory"), Some(ExternType::Memory(_))) {
        return Err("a work module exports its memory");
    }
    let func = |name: &str, params: &[ValType], results: &[ValType]| {
        matches!(export(name), Some(ExternType::Func(f)) if f.params() == params && f.results() == results)
    };
    if !func("alloc", &[ValType::I32], &[ValType::I32]) {
        return Err("a work module exports alloc(i32) -> i32");
    }
    if !func("run", &[ValType::I32, ValType::I32], &[ValType::I64]) {
        return Err("a work module exports run(i32, i32) -> i64");
    }
    Ok(module)
}

/// Runs every case of `suite`, in the order of `order` (indices into the cases); the report lists cases in the
/// suite's own order, so two orders compare case by case.
pub fn run(engine: &Engine, module: &Module, suite: &Suite, order: &[usize]) -> Report {
    let mut cases = vec![Case::Fail("not run"); suite.cases.len()];
    let mut fuel = 0;
    for &i in order {
        let (case, burned) = one(engine, module, suite.fuel, &suite.cases[i].input, &suite.cases[i].expect);
        cases[i] = case;
        fuel += burned;
    }
    Report { cases, fuel }
}

fn one(engine: &Engine, module: &Module, fuel: u64, input: &[u8], expect: &[u8]) -> (Case, u64) {
    let limits =
        StoreLimitsBuilder::new().memory_size(MAX_MEMORY_BYTES).table_elements(MAX_TABLE_ELEMENTS).instances(1).build();
    let mut store = Store::new(engine, Host { limits });
    store.limiter(|h| &mut h.limits);
    store.set_fuel(fuel).expect("fuel is on");
    let outcome = call(&mut store, module, input, expect.len()).map(|out| match out {
        Some(out) if out == expect => Case::Pass,
        _ => Case::Wrong,
    });
    let burned = fuel - store.get_fuel().unwrap_or(0);
    (outcome.unwrap_or_else(Case::Fail), burned)
}

/// The work's output, or `None` when it is not `expected` bytes long (it is not read then).
fn call(store: &mut Store<Host>, module: &Module, input: &[u8], expected: usize) -> Result<Option<Vec<u8>>, &'static str> {
    let linker = Linker::<Host>::new(store.engine());
    let instance: Instance = linker.instantiate_and_start(&mut *store, module).map_err(trap)?;
    let memory = instance.get_memory(&*store, "memory").ok_or("no exported memory")?;
    let alloc = instance.get_typed_func::<i32, i32>(&*store, "alloc").map_err(|_| "no alloc(i32) -> i32")?;
    let run = instance.get_typed_func::<(i32, i32), i64>(&*store, "run").map_err(|_| "no run(i32, i32) -> i64")?;
    let len = i32::try_from(input.len()).map_err(|_| "input too long")?;
    let ptr = alloc.call(&mut *store, len).map_err(trap)?;
    memory.write(&mut *store, ptr as u32 as usize, input).map_err(|_| "alloc gave memory out of bounds")?;
    let packed = run.call(&mut *store, (ptr, len)).map_err(trap)? as u64;
    let (out_ptr, out_len) = ((packed >> 32) as usize, (packed & 0xffff_ffff) as usize);
    if out_ptr.checked_add(out_len).is_none_or(|end| end > memory.data_size(&*store)) {
        return Err("the output is out of bounds");
    }
    if out_len != expected {
        return Ok(None);
    }
    let mut out = vec![0; out_len];
    memory.read(&*store, out_ptr, &mut out).map_err(|_| "the output is out of bounds")?;
    Ok(Some(out))
}

fn trap(e: wasmi::Error) -> &'static str {
    use wasmi::TrapCode::*;
    match e.as_trap_code() {
        Some(OutOfFuel) => "out of fuel",
        Some(StackOverflow) => "call stack exhausted",
        Some(_) => "trapped",
        None if e.to_string().contains("limit") => "over the memory or table limit",
        None => "could not start",
    }
}

/// The case orders a run uses. The first verdict runs the cases in order; an appeal runs them three times, in order,
/// backwards and shuffled by the job, and a work whose results differ between runs does not win.
pub fn orders(n: usize, appeal: bool, job: &str) -> Vec<Vec<usize>> {
    let forward: Vec<usize> = (0..n).collect();
    if !appeal {
        return vec![forward];
    }
    let backward: Vec<usize> = (0..n).rev().collect();
    // Fisher–Yates on a splitmix64 stream seeded by the job's sha256: the same job, the same order, anywhere.
    let seed = crate::job::sha256_hex(job.as_bytes());
    let mut state = u64::from_str_radix(&seed[..16], 16).unwrap_or(0);
    let mut next = || {
        state = state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    };
    let mut shuffled = forward.clone();
    for i in (1..n).rev() {
        shuffled.swap(i, (next() % (i as u64 + 1)) as usize);
    }
    vec![forward, backward, shuffled]
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::suite::{Case as Test, Suite};

    /// A module that reverses its input: allocates after its own data, writes the reversed bytes after the input.
    pub const REVERSE: &str = r#"(module
      (memory (export "memory") 1)
      (global $top (mut i32) (i32.const 1024))
      (func (export "alloc") (param $len i32) (result i32)
        (local $p i32)
        (local.set $p (global.get $top))
        (global.set $top (i32.add (global.get $top) (local.get $len)))
        (local.get $p))
      (func (export "run") (param $ptr i32) (param $len i32) (result i64)
        (local $i i32) (local $out i32)
        (local.set $out (global.get $top))
        (block $done (loop $next
          (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
          (i32.store8
            (i32.add (local.get $out) (local.get $i))
            (i32.load8_u (i32.sub (i32.add (local.get $ptr) (local.get $len)) (i32.add (local.get $i) (i32.const 1)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $next)))
        (i64.or (i64.shl (i64.extend_i32_u (local.get $out)) (i64.const 32)) (i64.extend_i32_u (local.get $len)))))"#;

    pub fn wasm(wat: &str) -> Vec<u8> {
        wat::parse_str(wat).unwrap()
    }

    fn suite(fuel: u64, cases: &[(&str, &str)]) -> Suite {
        Suite {
            fuel,
            win_at: 1,
            cases: cases.iter().map(|(i, e)| Test { input: i.as_bytes().to_vec(), expect: e.as_bytes().to_vec() }).collect(),
        }
    }

    #[test]
    fn a_work_passes_the_cases_it_answers_right() {
        let e = engine();
        let m = load(&e, &wasm(REVERSE)).unwrap();
        let s = suite(10_000, &[("abc", "cba"), ("near", "raen"), ("x", "y"), ("", "")]);
        let r = run(&e, &m, &s, &[0, 1, 2, 3]);
        assert_eq!(r.cases, vec![Case::Pass, Case::Pass, Case::Wrong, Case::Pass]);
        assert_eq!(r.passed(), 3);
        assert!(r.fuel > 0);
        // The same bytes, the same report, in any order.
        assert_eq!(run(&e, &m, &s, &[3, 1, 0, 2]), r);
    }

    #[test]
    fn fuel_memory_and_stack_stop_a_work() {
        let e = engine();
        let spin = wasm(r#"(module (memory (export "memory") 1)
            (func (export "alloc") (param i32) (result i32) (i32.const 0))
            (func (export "run") (param i32 i32) (result i64) (loop $l (br $l)) (i64.const 0)))"#);
        let r = run(&e, &load(&e, &spin).unwrap(), &suite(5_000, &[("a", "a")]), &[0]);
        assert_eq!((r.cases[0].clone(), r.fuel), (Case::Fail("out of fuel"), 5_000));

        let grow = wasm(r#"(module (memory (export "memory") 1)
            (func (export "alloc") (param i32) (result i32) (i32.const 0))
            (func (export "run") (param i32 i32) (result i64)
              (if (i32.eq (memory.grow (i32.const 100)) (i32.const -1)) (then unreachable)) (i64.const 0)))"#);
        let r = run(&e, &load(&e, &grow).unwrap(), &suite(5_000, &[("a", "")]), &[0]);
        assert_eq!(r.cases[0], Case::Fail("trapped"), "4 MiB is 64 pages: growing by 100 fails");

        let deep = wasm(r#"(module (memory (export "memory") 1)
            (func (export "alloc") (param i32) (result i32) (i32.const 0))
            (func $f (param i32) (result i32) (call $f (local.get 0)))
            (func (export "run") (param i32 i32) (result i64) (drop (call $f (i32.const 0))) (i64.const 0)))"#);
        let r = run(&e, &load(&e, &deep).unwrap(), &suite(1_000_000, &[("a", "")]), &[0]);
        assert_eq!(r.cases[0], Case::Fail("call stack exhausted"));

        let out_of_bounds = wasm(r#"(module (memory (export "memory") 1)
            (func (export "alloc") (param i32) (result i32) (i32.const 0))
            (func (export "run") (param i32 i32) (result i64) (i64.const 0x0000fff000000100)))"#);
        let r = run(&e, &load(&e, &out_of_bounds).unwrap(), &suite(5_000, &[("a", "")]), &[0]);
        assert_eq!(r.cases[0], Case::Fail("the output is out of bounds"));
    }

    #[test]
    fn a_module_that_imports_anything_or_breaks_the_convention_is_not_a_work() {
        let e = engine();
        let clock = wasm(r#"(module (import "wasi_snapshot_preview1" "clock_time_get" (func (param i32 i64 i32) (result i32)))
            (memory (export "memory") 1))"#);
        assert_eq!(load(&e, &clock).unwrap_err(), "a work module imports nothing");
        assert_eq!(load(&e, b"\0asm\x02").unwrap_err(), "not a valid WebAssembly module");
        let big = [b"\0asm\x01\0\0\0".as_slice(), &[0; MAX_MODULE]].concat();
        assert_eq!(load(&e, &big).unwrap_err(), "the work module is over 638 bytes");
        let no_run = wasm(r#"(module (memory (export "memory") 1) (func (export "alloc") (param i32) (result i32) (i32.const 0)))"#);
        assert_eq!(load(&e, &no_run).unwrap_err(), "a work module exports run(i32, i32) -> i64");
        let wrong_run = wasm(r#"(module (memory (export "memory") 1) (func (export "alloc") (param i32) (result i32) (i32.const 0))
            (func (export "run") (param i32) (result i64) (i64.const 0)))"#);
        assert_eq!(load(&e, &wrong_run).unwrap_err(), "a work module exports run(i32, i32) -> i64");
        let no_memory = wasm(r#"(module (func (export "alloc") (param i32) (result i32) (i32.const 0))
            (func (export "run") (param i32 i32) (result i64) (i64.const 0)))"#);
        assert_eq!(load(&e, &no_memory).unwrap_err(), "a work module exports its memory");
        assert_eq!(load(&e, b"\0asm\x01\0\0\0").unwrap_err(), "a work module exports its memory", "an empty module");
    }

    #[test]
    fn an_appeal_runs_the_cases_three_ways_the_same_for_the_same_job() {
        assert_eq!(orders(4, false, "job-1"), vec![vec![0, 1, 2, 3]]);
        let o = orders(6, true, "job-1");
        assert_eq!((o[0].clone(), o[1].clone()), (vec![0, 1, 2, 3, 4, 5], vec![5, 4, 3, 2, 1, 0]));
        let mut sorted = o[2].clone();
        sorted.sort_unstable();
        assert_eq!(sorted, vec![0, 1, 2, 3, 4, 5]);
        assert_eq!(orders(6, true, "job-1"), o);
        assert_ne!(orders(6, true, "job-2")[2], o[2]);
    }
}
