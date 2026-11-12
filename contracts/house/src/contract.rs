//! The contract on the house's account: each exported method reads the chain, applies the rules (rules.rs) and sends.
//! No SDK: NEAR's host functions directly, a bump allocator for the call's few allocations, and a panic that says only
//! what the rules say.

use crate::json;
use crate::rules::{self, Config, Day};
use alloc::string::String;
use alloc::vec::Vec;
use near_sys as sys;

// ---------------------------------------------------------------------------------------------------------------------
// Memory: one call allocates little and frees nothing; the memory goes with the call.

struct Bump;

static mut NEXT: usize = 0;
static mut END: usize = 0;

unsafe impl core::alloc::GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        let align = layout.align();
        let mut start = (NEXT + align - 1) & !(align - 1);
        if start == 0 || start + layout.size() > END {
            let pages = (layout.size() + align).div_ceil(65536) + 1;
            let at = core::arch::wasm32::memory_grow(0, pages);
            if at == usize::MAX {
                return core::ptr::null_mut();
            }
            if start == 0 || at * 65536 != END {
                NEXT = at * 65536;
            }
            END = (at + pages) * 65536;
            start = (NEXT + align - 1) & !(align - 1);
        }
        NEXT = start + layout.size();
        start as *mut u8
    }

    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: core::alloc::Layout) {}
}

#[global_allocator]
static ALLOC: Bump = Bump;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unsafe { sys::panic() }
}

// ---------------------------------------------------------------------------------------------------------------------
// The host

const REG: u64 = 0;
const CONFIG: &[u8] = b"config";
const DAY: &[u8] = b"day";

fn fail(why: &str) -> ! {
    unsafe { sys::panic_utf8(why.len() as u64, why.as_ptr() as u64) }
}

fn ok<T>(r: Result<T, &'static str>) -> T {
    r.unwrap_or_else(|why| fail(why))
}

fn register() -> Vec<u8> {
    unsafe {
        let len = sys::register_len(REG);
        if len == u64::MAX {
            return Vec::new();
        }
        let mut v = alloc::vec![0u8; len as usize];
        sys::read_register(REG, v.as_mut_ptr() as u64);
        v
    }
}

fn input() -> Vec<u8> {
    unsafe { sys::input(REG) };
    register()
}

fn text(v: Vec<u8>) -> String {
    String::from_utf8(v).unwrap_or_default()
}

fn current() -> String {
    unsafe { sys::current_account_id(REG) };
    text(register())
}

fn predecessor() -> String {
    unsafe { sys::predecessor_account_id(REG) };
    text(register())
}

fn now() -> u64 {
    unsafe { sys::block_timestamp() }
}

fn balance() -> u128 {
    let mut b = [0u8; 16];
    unsafe { sys::account_balance(b.as_mut_ptr() as u64) };
    u128::from_le_bytes(b)
}

fn attached() -> u128 {
    let mut b = [0u8; 16];
    unsafe { sys::attached_deposit(b.as_mut_ptr() as u64) };
    u128::from_le_bytes(b)
}

/// What the house holds beyond the NEAR its own storage locks.
fn free() -> u128 {
    let locked = rules::BYTE_COST * u128::from(unsafe { sys::storage_usage() });
    balance().saturating_sub(locked)
}

fn read(key: &[u8]) -> Option<Vec<u8>> {
    match unsafe { sys::storage_read(key.len() as u64, key.as_ptr() as u64, REG) } {
        1 => Some(register()),
        _ => None,
    }
}

fn write(key: &[u8], value: &[u8]) {
    unsafe {
        sys::storage_write(key.len() as u64, key.as_ptr() as u64, value.len() as u64, value.as_ptr() as u64, REG)
    };
}

fn log(parts: &[&str]) {
    let line = parts.concat();
    unsafe { sys::log_utf8(line.len() as u64, line.as_ptr() as u64) }
}

fn give(value: &str) {
    unsafe { sys::value_return(value.len() as u64, value.as_ptr() as u64) }
}

fn sha256(data: &[u8]) -> Vec<u8> {
    unsafe { sys::sha256(data.len() as u64, data.as_ptr() as u64, REG) };
    register()
}

fn config() -> Config {
    let raw = read(CONFIG).unwrap_or_else(|| fail("the house is not set up"));
    let o = ok(json::parse(&raw));
    ok(Config::read(&o, &current(), &[]))
}

fn day() -> Day {
    read(DAY).and_then(|b| Day::from_bytes(&b)).unwrap_or_default()
}

/// A promise of one call on `to`, with nothing attached unless `deposit`, `gas` of its own and, with `weight` 1, a
/// share of what is left; with 0, exactly `gas`.
fn call(to: &str, method: &str, args: &[u8], deposit: u128, gas: u64, weight: u64) -> u64 {
    unsafe {
        let p = sys::promise_batch_create(to.len() as u64, to.as_ptr() as u64);
        let amount = deposit.to_le_bytes();
        sys::promise_batch_action_function_call_weight(
            p,
            method.len() as u64,
            method.as_ptr() as u64,
            args.len() as u64,
            args.as_ptr() as u64,
            amount.as_ptr() as u64,
            gas,
            weight,
        );
        p
    }
}

/// A callback `method` on the house itself after promise `p`, with `args` and `gas`; returns the callback's promise.
fn then_self(p: u64, method: &str, args: &[u8], gas: u64) -> u64 {
    let me = current();
    unsafe {
        let cb = sys::promise_batch_then(p, me.len() as u64, me.as_ptr() as u64);
        let zero = 0u128.to_le_bytes();
        sys::promise_batch_action_function_call(
            cb,
            method.len() as u64,
            method.as_ptr() as u64,
            args.len() as u64,
            args.as_ptr() as u64,
            zero.as_ptr() as u64,
            gas,
        );
        cb
    }
}

/// Whether this call is the callback of one promise, and that promise went through. Anything else stops the call:
/// a callback is never called by hand.
fn callback_ok(name: &str) -> bool {
    if unsafe { sys::promise_results_count() } != 1 {
        let why = [name, " is a callback only"].concat();
        fail(&why);
    }
    // 1: the call went through; 2: it failed. Nothing of the answer is read.
    unsafe { sys::promise_result(0, REG) == 1 }
}

/// The day's steps and the owner's calls come from the house's own account: its keys, nobody else.
fn only_house() {
    if predecessor() != current() {
        fail("only the house's own keys");
    }
}

/// The id a day's step names, as the bounty contract takes it: any id a NEAR call could carry, printable ASCII.
fn id_arg(o: &json::Object) -> String {
    let id = ok(o.str("id"));
    if id.is_empty() || id.len() > 64 {
        fail("id: 1 to 64 characters");
    }
    id.into()
}

// ---------------------------------------------------------------------------------------------------------------------
// Set up

/// Once, by the owner's full key, in the transaction that deploys the code: the terms (`rules::FIELDS`) and
/// `last_round`, the number of the house's last round so far.
#[no_mangle]
pub extern "C" fn new() {
    only_house();
    if read(CONFIG).is_some() {
        fail("the house is set up already");
    }
    let raw = input();
    let o = ok(json::parse(&raw));
    let c = ok(Config::read(&o, &current(), &["last_round"]));
    let last_round = ok(o.u32("last_round"));
    write(CONFIG, c.to_json().as_bytes());
    write(DAY, &Day { last_round, ..Day::default() }.to_bytes());
    log(&["the house is set up: ", &c.vault, " on ", &c.bounty]);
}

/// Changes the terms; with `last_round`, the number the next round follows; with `last_slot_ns`, the slot that counts
/// as having its round (0: none). New terms take a vault made under them: the one standing no longer opens a round.
/// One yoctoNEAR attached: a function-call key cannot attach any, so only a full key of the house gets here.
#[no_mangle]
pub extern "C" fn configure() {
    only_house();
    if attached() != 1 {
        fail("attach exactly one yoctoNEAR: a full key of the house only");
    }
    let raw = input();
    let o = ok(json::parse(&raw));
    let c = ok(Config::read(&o, &current(), &["last_round", "last_slot_ns"]));
    let mut d = day();
    if c != config() {
        d.made_slot_ns = 0;
    }
    if o.get("last_round").is_some() {
        d.last_round = ok(o.u32("last_round"));
    }
    if o.get("last_slot_ns").is_some() {
        d.last_slot_ns = ok(o.u64("last_slot_ns"));
    }
    write(CONFIG, c.to_json().as_bytes());
    write(DAY, &d.to_bytes());
    log(&["the house's terms changed"]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The day's steps

/// Step 0: `home()` on `mask`, one of the round's masks: a mask that runs contracts/home sends the house everything
/// it holds above what it keeps, and nothing else. Nothing attached, and exactly `HOME_GAS`.
#[no_mangle]
pub extern "C" fn home() {
    only_house();
    let c = config();
    let raw = input();
    let o = ok(json::parse(&raw));
    let mask = ok(rules::home_mask(&c, &o));
    let p = call(mask, "home", rules::HOME_ARGS, 0, rules::HOME_GAS, 0);
    unsafe { sys::promise_return(p) }
}

/// Drops a claim on round `id` the judge never answered: the bounty contract's `unstick`, which anyone may call.
#[no_mangle]
pub extern "C" fn unstick() {
    only_house();
    let c = config();
    let raw = input();
    let o = ok(json::parse(&raw));
    ok(o.only(&["id", "claim"]));
    let id = id_arg(&o);
    let claim = ok(o.u64("claim"));
    let args = rules::unstick_args(&id, claim);
    let p = call(&c.bounty, "unstick", args.as_bytes(), 0, rules::UNSTICK_GAS, 1);
    unsafe { sys::promise_return(p) }
}

fn pass_on(method: &str, gas: u64) {
    only_house();
    let c = config();
    let raw = input();
    let o = ok(json::parse(&raw));
    ok(o.only(&["id"]));
    let id = id_arg(&o);
    let args = rules::id_args(&id);
    let p = call(&c.bounty, method, args.as_bytes(), 0, gas, 1);
    unsafe { sys::promise_return(p) }
}

/// Pays round `id`'s confirmed winner: the bounty contract's `settle`, which anyone may call.
#[no_mangle]
pub extern "C" fn settle() {
    pass_on("settle", rules::SETTLE_GAS)
}

/// Round `id`'s bounty, which nobody won, back to the house: the bounty contract's `refund`.
#[no_mangle]
pub extern "C" fn refund() {
    pass_on("refund", rules::REFUND_GAS)
}

/// The vault deletes itself and gives the house its whole balance. The vault itself refuses while its round can
/// still be played; a vault that took no round goes at once. From the call on, the vault that stood is no longer
/// one `make_vault` made in this slot: a round opens only on the next one it makes.
#[no_mangle]
pub extern "C" fn retire() {
    only_house();
    let c = config();
    let mut d = day();
    if d.made_slot_ns != 0 {
        d.made_slot_ns = 0;
        write(DAY, &d.to_bytes());
    }
    let p = call(&c.vault, "retire", b"{}", 0, rules::RETIRE_GAS, 1);
    unsafe { sys::promise_return(p) }
}

/// Makes the vault in one transaction that adds no key: the account, the pinned NEAR, the code and `new`. The call's
/// input is the vault's wasm itself, and it must hash to the pinned `safe_code`. Only while the house keeps the
/// round's deposit and the day's gas after it: a vault is never made without the NEAR to open its round. Once the
/// vault stands, `on_made` records the slot it was made in: `open_round` opens only on it, in that slot. The call's
/// result is the vault's transaction's own.
#[no_mangle]
pub extern "C" fn make_vault() {
    only_house();
    let c = config();
    let code = input();
    if code.is_empty() {
        fail("the call's input is the vault's wasm");
    }
    if rules::base58(&sha256(&code)) != c.safe_code {
        fail("the wasm is not the vault's code: its hash differs");
    }
    if free() < c.safe.saturating_add(c.deposit).saturating_add(c.gas) {
        fail("the house cannot pay the vault and its round's deposit");
    }
    let init = c.vault_init(&current());
    // Until the answer, no vault counts as made: a `retire` or new terms in between leave it so.
    let mut d = day();
    let made = rules::made_args(&c, now(), d.made_slot_ns);
    d.made_slot_ns = rules::MAKING;
    write(DAY, &d.to_bytes());
    log(&["the house makes ", &c.vault]);
    let p = unsafe {
        let p = sys::promise_batch_create(c.vault.len() as u64, c.vault.as_ptr() as u64);
        sys::promise_batch_action_create_account(p);
        let amount = c.safe.to_le_bytes();
        sys::promise_batch_action_transfer(p, amount.as_ptr() as u64);
        sys::promise_batch_action_deploy_contract(p, code.len() as u64, code.as_ptr() as u64);
        let zero = 0u128.to_le_bytes();
        let new = "new";
        sys::promise_batch_action_function_call(
            p,
            new.len() as u64,
            new.as_ptr() as u64,
            init.len() as u64,
            init.as_ptr() as u64,
            zero.as_ptr() as u64,
            rules::NEW_GAS,
        );
        p
    };
    // The call's result is the vault's own: a failure when it was not made. `on_made` records it either way.
    let _ = then_self(p, "on_made", made.as_bytes(), rules::ON_MADE_GAS);
    unsafe { sys::promise_return(p) }
}

/// The answer to `make_vault`, and nothing else: a vault made, its `new` included, records the slot it was made in.
/// One that was not (the name was taken, `new` failed) leaves what stood before, and its NEAR came back to the house.
/// Either way only while nothing cleared the record since `make_vault` (`retire`, new terms).
#[no_mangle]
pub extern "C" fn on_made() {
    only_house();
    let made = callback_ok("on_made");
    let raw = input();
    let o = ok(json::parse(&raw));
    let (slot, before) = ok(rules::read_made(&o));
    let mut d = day();
    if d.made_slot_ns == rules::MAKING {
        d.made_slot_ns = if made { slot } else { before };
        write(DAY, &d.to_bytes());
    }
    if !made {
        log(&["the vault was not made: the house holds its NEAR again"]);
    }
    give(if made { "true" } else { "false" });
}

/// Opens round `id` on the vault: `open_safe` on the bounty contract with every term pinned and the pinned deposit,
/// once per slot, in the slot's window, on a vault made in the slot (`Config::may_open`). The slot is taken at once,
/// so no second call slips in before the answer; an `open_safe` the bounty contract refuses gives the deposit back,
/// and `on_opened` gives the slot back. The call's result is `open_safe`'s own.
#[no_mangle]
pub extern "C" fn open_round() {
    only_house();
    let c = config();
    let raw = input();
    let o = ok(json::parse(&raw));
    ok(o.only(&["id"]));
    let id = ok(o.str("id"));
    let before = day();
    let (n, slot) = ok(c.may_open(&before, id, now()));
    if free() < c.deposit {
        fail("the house cannot pay the round's deposit");
    }
    write(DAY, &Day { last_round: n, last_slot_ns: slot, made_slot_ns: before.made_slot_ns }.to_bytes());
    log(&["the house opens ", id, " on ", &c.vault]);
    let args = c.round_args(id);
    let p = call(&c.bounty, "open_safe", args.as_bytes(), c.deposit, rules::OPEN_SAFE_GAS, 1);
    let back = before.to_json();
    let _ = then_self(p, "on_opened", back.as_bytes(), rules::ON_OPENED_GAS);
    unsafe { sys::promise_return(p) }
}

/// The bounty contract's answer to `open_round`, and nothing else: a refused `open_safe` gives the slot and the
/// round's number back, so the day can try again. Called only as the callback of `open_round`.
#[no_mangle]
pub extern "C" fn on_opened() {
    only_house();
    let opened = callback_ok("on_opened");
    if !opened {
        let raw = input();
        let o = ok(json::parse(&raw));
        let back = ok(Day::read(&o));
        // The round's number and its slot go back; whether a vault made in the slot stands is as it is now.
        let mut d = day();
        d.last_round = back.last_round;
        d.last_slot_ns = back.last_slot_ns;
        write(DAY, &d.to_bytes());
        log(&["the bounty contract refused the round: the slot is free again"]);
    }
    give(if opened { "true" } else { "false" });
}

// ---------------------------------------------------------------------------------------------------------------------
// Views

#[export_name = "config"]
pub extern "C" fn config_view() {
    give(&config().to_json())
}

#[export_name = "day"]
pub extern "C" fn day_view() {
    give(&day().to_json())
}

/// Where the schedule stands now: the slot, whether it has its round, until when one may open, the next round's id.
#[export_name = "now"]
pub extern "C" fn now_view() {
    give(&rules::now_json(&config(), day(), now(), free()))
}

#[no_mangle]
pub extern "C" fn version() {
    give(&["\"", rules::VERSION, "\""].concat())
}

/// NEP-330: the code's version, where its source is, and, when the build ran in its pinned image, how to build it again
/// (build.rs writes the JSON at build time).
#[no_mangle]
pub extern "C" fn contract_source_metadata() {
    give(rules::SOURCE_METADATA)
}
