//! MASK WARS · home. The code on each of the arena's own masks (NOVA, ONYX, ORACLE) that sends a round's winnings back
//! to the house, so the daily round goes on with the same NEAR: house, vault, the mask that wins, house.
//!
//! One method, `home()`, with no arguments. Anyone may call it, and it can do only one thing: everything the mask holds
//! above what it keeps goes to the house, whose name is written into this code. What the mask keeps is `KEEP`, 0.4 NEAR
//! for the gas its next claim buys up front, plus the NEAR its own storage locks (its code, its keys, its account), so
//! after a call the mask has exactly that and a sliver: the share of the call's gas that NEAR pays a contract. At or
//! below it nothing is sent. A deposit attached to the call adds to the balance and goes home with the rest.
//!
//! What it cannot do: send anywhere else (no argument is read, no other method exists), spend below `KEEP`, store
//! anything, or touch the mask's keys. The mask's own keys, the full one the owner holds and the function-call keys it
//! plays rounds with on the bounty contract and the vault, work as before: code on an account changes what calls *to*
//! it do, not what the account signs. The bounty contract and the vault pay a mask with plain transfers, which run no
//! code. If the transfer to the house fails (no such account), NEAR gives it back to the mask: nothing is lost.
//!
//! Built without near-sdk and without `std`, for a code of a few hundred bytes: the storage it locks on each mask is
//! well under 0.01 NEAR. Each network has its own build, with its own house: `--features mainnet` sends to
//! `house.maskwars.near`, `--features testnet` to `house.tinygif8324.testnet` (packages/network; a test keeps them the
//! same). build.sh gives the same bytes anywhere; their code hash is `home_code` in packages/network, and the house's
//! daily step calls `home()` only on a mask that runs exactly that code.

#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(not(any(feature = "mainnet", feature = "testnet")))]
compile_error!("the house is part of the code: build with --features mainnet or --features testnet");
#[cfg(all(feature = "mainnet", feature = "testnet"))]
compile_error!("one network per build: --features mainnet or --features testnet, not both");

#[cfg(feature = "mainnet")]
macro_rules! house {
    () => {
        "house.maskwars.near"
    };
}
#[cfg(not(feature = "mainnet"))]
macro_rules! house {
    () => {
        "house.tinygif8324.testnet"
    };
}

/// Where everything above `KEEP` goes. Nothing else is ever a receiver.
pub const HOUSE: &str = house!();
/// What the mask keeps besides its storage: 0.4 NEAR, `round.mask_keep` of packages/network.
pub const KEEP: u128 = 400_000_000_000_000_000_000_000;
/// What NEAR locks for every byte an account stores (`storage_amount_per_byte`).
pub const BYTE_COST: u128 = 10_000_000_000_000_000_000;

/// What goes home from an account that holds `balance` and stores `storage_usage` bytes: everything above `KEEP` and
/// the stake of its storage, or nothing.
pub const fn above(balance: u128, storage_usage: u64) -> u128 {
    let keep = KEEP.saturating_add((storage_usage as u128).saturating_mul(BYTE_COST));
    balance.saturating_sub(keep)
}

/// The event `home()` logs when it sends, in the NEP-297 form: `EVENT_JSON:` and then the JSON, the amount in yoctoNEAR.
const EVENT_HEAD: &str = concat!(
    "EVENT_JSON:{\"standard\":\"maskwars_home\",\"version\":\"",
    env!("CARGO_PKG_VERSION"),
    "\",\"event\":\"home\",\"data\":{\"to\":\"",
    house!(),
    "\",\"amount\":\""
);
const EVENT_TAIL: &str = "\"}}";
/// The longest event: the head, the 39 digits of the largest u128 and the tail.
pub const EVENT_MAX: usize = EVENT_HEAD.len() + 39 + EVENT_TAIL.len();
/// The line `home()` logs when nothing is above what the mask keeps.
pub const NOTHING: &str = "home: nothing above the 0.4 NEAR this mask keeps besides its storage";

/// Writes the event for `amount` into `out`; its length. The decimal digits come from long division of four 32-bit
/// limbs by ten with 64-bit arithmetic, which wasm does natively: dividing a u128 would add a kilobyte of code.
pub fn event(amount: u128, out: &mut [u8; EVENT_MAX]) -> usize {
    let mut limbs = [(amount >> 96) as u32, (amount >> 64) as u32, (amount >> 32) as u32, amount as u32];
    let mut digits = [0u8; 39];
    let mut first = digits.len();
    for d in digits.iter_mut().rev() {
        let mut rest = 0u64;
        for limb in limbs.iter_mut() {
            let n = (rest << 32) | u64::from(*limb);
            *limb = (n / 10) as u32;
            rest = n % 10;
        }
        *d = b'0' + rest as u8;
        first -= 1;
        if limbs == [0; 4] {
            break;
        }
    }
    let parts: [&[u8]; 3] = [EVENT_HEAD.as_bytes(), &digits[first..], EVENT_TAIL.as_bytes()];
    let mut at = 0;
    for byte in parts.iter().flat_map(|p| p.iter()) {
        if let Some(slot) = out.get_mut(at) {
            *slot = *byte;
            at += 1;
        }
    }
    at
}

#[cfg(target_arch = "wasm32")]
mod near {
    // The NEAR host functions this code uses, and nothing else: no state, no keys, no arguments.
    #[link(wasm_import_module = "env")]
    extern "C" {
        fn account_balance(balance_ptr: u64);
        fn storage_usage() -> u64;
        fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
        fn promise_batch_action_transfer(promise_index: u64, amount_ptr: u64);
        fn log_utf8(len: u64, ptr: u64);
    }

    /// Sends everything above what the mask keeps to the house; below it, nothing.
    #[no_mangle]
    pub extern "C" fn home() {
        let mut balance = [0u8; 16];
        // SAFETY: each host function reads or writes only the memory it is given, of the size NEAR defines.
        unsafe {
            account_balance(balance.as_mut_ptr() as u64);
            let send = super::above(u128::from_le_bytes(balance), storage_usage());
            if send == 0 {
                log_utf8(super::NOTHING.len() as u64, super::NOTHING.as_ptr() as u64);
                return;
            }
            let to = super::HOUSE.as_bytes();
            let promise = promise_batch_create(to.len() as u64, to.as_ptr() as u64);
            let amount = send.to_le_bytes();
            promise_batch_action_transfer(promise, amount.as_ptr() as u64);
            let mut line = [0u8; super::EVENT_MAX];
            let len = super::event(send, &mut line);
            log_utf8(len as u64, line.as_ptr() as u64);
        }
    }

    #[panic_handler]
    fn panic(_: &core::panic::PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    #[test]
    fn the_mask_keeps_exactly_the_threshold_and_its_storage() {
        // A mask that stores 1 000 bytes keeps 0.4 NEAR and the 0.01 NEAR those bytes lock.
        let keep = 4 * NEAR / 10 + NEAR / 100;
        assert_eq!(above(keep + 3 * NEAR, 1_000), 3 * NEAR);
        assert_eq!(above(keep + 1, 1_000), 1);
        assert_eq!(above(keep, 1_000), 0, "at the threshold nothing goes");
        assert_eq!(above(keep - 1, 1_000), 0, "below it nothing goes");
        assert_eq!(above(0, 1_000), 0);
        assert_eq!(above(KEEP, 0), 0);
        assert_eq!(above(KEEP + 7, 0), 7);
        // Every byte of storage stays covered.
        assert_eq!(above(keep + 3 * NEAR, 1_001), 3 * NEAR - BYTE_COST);
    }

    #[test]
    fn no_balance_or_storage_overflows() {
        assert_eq!(above(u128::MAX, 0), u128::MAX - KEEP);
        assert_eq!(above(u128::MAX, u64::MAX), u128::MAX - KEEP - u128::from(u64::MAX) * BYTE_COST);
        assert_eq!(above(0, u64::MAX), 0);
    }

    fn event_text(amount: u128) -> String {
        let mut out = [0u8; EVENT_MAX];
        let n = event(amount, &mut out);
        String::from_utf8(out[..n].to_vec()).expect("utf-8")
    }

    #[test]
    fn the_event_names_the_house_and_the_amount() {
        let expect = |amount: &str| {
            format!(
                "EVENT_JSON:{{\"standard\":\"maskwars_home\",\"version\":\"1.0.0\",\"event\":\"home\",\"data\":{{\"to\":\"{HOUSE}\",\"amount\":\"{amount}\"}}}}"
            )
        };
        assert_eq!(event_text(0), expect("0"));
        assert_eq!(event_text(7), expect("7"));
        assert_eq!(event_text(1_234_567_890 * NEAR), expect("1234567890000000000000000000000000"));
        assert_eq!(event_text(u128::MAX), expect(&u128::MAX.to_string()));
        assert_eq!(event_text(u128::MAX).len(), EVENT_MAX);
        let json = event_text(NEAR).strip_prefix("EVENT_JSON:").map(str::to_string).expect("prefix");
        assert!(json.starts_with('{') && json.ends_with('}') && json.matches('"').count().is_multiple_of(2), "{json}");
    }

    /// The string value of `"key": "..."` in a network file of packages/network.
    fn field<'a>(json: &'a str, key: &str) -> &'a str {
        let at = json.find(&format!("\"{key}\": \"")).unwrap_or_else(|| panic!("{key} in the network file"));
        let rest = &json[at + key.len() + 5..];
        &rest[..rest.find('"').expect("closing quote")]
    }

    /// NEAR as a decimal string ("0.4") → yoctoNEAR.
    fn yocto(near: &str) -> u128 {
        let (whole, frac) = near.split_once('.').unwrap_or((near, ""));
        whole.parse::<u128>().expect("whole") * NEAR + format!("{frac:0<24}").parse::<u128>().expect("fraction")
    }

    #[test]
    fn the_house_and_the_threshold_are_the_ones_of_packages_network() {
        #[cfg(feature = "mainnet")]
        let file = include_str!("../../../packages/network/mainnet.json");
        #[cfg(not(feature = "mainnet"))]
        let file = include_str!("../../../packages/network/testnet.json");
        assert_eq!(HOUSE, field(file, "house"));
        assert_eq!(KEEP, yocto(field(file, "mask_keep")));
        assert_eq!(yocto("0.4"), KEEP);
        assert!(NOTHING.contains("0.4 NEAR"));
    }
}
