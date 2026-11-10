//! A mask's work in the sandbox's `tee_tests` job, written in Rust and compiled to a WebAssembly module that imports
//! nothing: `run` answers `yes` when its input is a valid NEAR account id and `no` otherwise. The client's private
//! test set decides how good it is. `no_std` with one static buffer keeps it under the judge's 1 KiB.
#![no_std]

const MAX: usize = 4096;
static mut INPUT: [u8; MAX] = [0; MAX];

#[no_mangle]
pub extern "C" fn alloc(_len: i32) -> i32 {
    core::ptr::addr_of_mut!(INPUT) as i32
}

/// # Safety
/// The judge wrote `len` bytes at what `alloc` returned.
#[no_mangle]
pub unsafe extern "C" fn run(ptr: i32, len: i32) -> i64 {
    let input = core::slice::from_raw_parts(ptr as usize as *const u8, (len.max(0) as usize).min(MAX));
    let out: &'static [u8] = if valid(input) { b"yes" } else { b"no" };
    ((out.as_ptr() as usize as i64) << 32) | out.len() as i64
}

fn valid(id: &[u8]) -> bool {
    let sep = |c: &u8| b"-_.".contains(c);
    let chars = (2..=64).contains(&id.len()) && id.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || sep(c));
    if cfg!(feature = "sloppy") {
        return chars;
    }
    chars && !sep(&id[0]) && !sep(&id[id.len() - 1]) && !id.windows(2).any(|w| sep(&w[0]) && sep(&w[1]))
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
