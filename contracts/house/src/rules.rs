//! The house's rules, with nothing of the chain in them: the terms and their checks, the schedule, the round ids, and
//! the exact arguments each step sends. The contract (contract.rs) only reads the chain, applies these and sends.

use crate::json::{self, Object, Writer};
use alloc::string::String;
use alloc::vec::Vec;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// What `contract_source_metadata` returns (NEP-330), as build.rs wrote it for this build.
pub const SOURCE_METADATA: &str = include_str!(concat!(env!("OUT_DIR"), "/nep330.json"));
pub const NS_PER_MINUTE: u64 = 60_000_000_000;
pub const TGAS: u64 = 1_000_000_000_000;
/// The masks may claim for 12 hours after a round's deadline (the bounty contract's `CLAIM_GRACE_HOURS`): a round is
/// over only then.
pub const CLAIM_GRACE_MINUTES: u64 = 12 * 60;
/// A mask's turn on a live safe (the bounty contract's `SAFE_TURN_MINUTES`).
pub const SAFE_TURN_MINUTES: u64 = 3;
/// The bounty contract's floor for a drain (`MIN_LOOT`).
pub const MIN_LOOT: u128 = 100_000_000_000_000_000_000_000;
/// The bounty contract's limits on a sealed round.
pub const MAX_ROUND_HOURS: u64 = 24;
pub const MAX_MASKS: usize = 16;
/// How far a round's number may run ahead of the last one: room for rounds opened by hand in between, never so far
/// that the day's search for the next free number (house.ts) runs away.
pub const MAX_ROUND_STEP: u32 = 100;
/// NEAR locks this much for each byte an account stores.
pub const BYTE_COST: u128 = 10_000_000_000_000_000_000;

/// Gas each step gives the call it passes on, besides what is left over: house.ts's numbers (`GAS`), less what the
/// house's own call takes.
pub const UNSTICK_GAS: u64 = 25 * TGAS;
pub const SETTLE_GAS: u64 = 40 * TGAS;
pub const REFUND_GAS: u64 = 25 * TGAS;
/// The vault's `retire`: the call, its question to the bounty contract (10 TGas) and its answer (10).
pub const RETIRE_GAS: u64 = 30 * TGAS;
pub const NEW_GAS: u64 = 30 * TGAS;
/// `open_safe`, the vault's `arm` (10 TGas) and the bounty contract's `on_armed` (15 TGas), with room.
pub const OPEN_SAFE_GAS: u64 = 70 * TGAS;
pub const ON_OPENED_GAS: u64 = 10 * TGAS;
pub const ON_MADE_GAS: u64 = 5 * TGAS;
/// `home()` on a mask (contracts/home): it burns about 2 TGas. Exactly this much, and none of what is left over: the
/// house pays for a mask's code it does not run itself, so the call is bounded.
pub const HOME_GAS: u64 = 10 * TGAS;

/// The fields of the terms, as `new` and `configure` take them.
pub const FIELDS: &[&str] = &[
    "bounty",
    "vault",
    "safe_code",
    "masks",
    "judge_version",
    "safe",
    "deposit",
    "min_loot",
    "gas",
    "hours",
    "commit_minutes",
    "reveal_minutes",
    "first_minute",
    "every_minutes",
    "safe_max",
    "deposit_max",
];

/// Everything the day runs on, pinned. Amounts in yoctoNEAR; `first_minute` and `every_minutes` as in packages/network
/// (`round`): slots fall at `first_minute + k * every_minutes` minutes since the Unix epoch.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub bounty: String,
    /// A direct sub-account of the house, so only the house can make it.
    pub vault: String,
    /// The vault's code as NEAR shows a code hash: base58 of the wasm's sha256.
    pub safe_code: String,
    pub masks: Vec<String>,
    /// The judge the house opens its rounds with: sha256 of its wasm, lowercase hex.
    pub judge_version: String,
    /// What the vault is made with, and the round's deposit.
    pub safe: u128,
    pub deposit: u128,
    pub min_loot: u128,
    /// What the house keeps beyond the vault and the deposit for the day's gas: no vault is made without it.
    pub gas: u128,
    pub hours: u64,
    pub commit_minutes: u64,
    pub reveal_minutes: u64,
    pub first_minute: u64,
    pub every_minutes: u64,
    /// The most the vault and the deposit may ever be (packages/network `limits.hand`).
    pub safe_max: u128,
    pub deposit_max: u128,
}

impl Config {
    /// Reads the terms from `o` (fields `FIELDS`, and the ones in `extra`, which the caller reads) and checks them
    /// for the house `house`.
    pub fn read(o: &Object, house: &str, extra: &[&str]) -> Result<Config, &'static str> {
        let mut known: Vec<&str> = FIELDS.to_vec();
        known.extend_from_slice(extra);
        o.only(&known)?;
        let c = Config {
            bounty: o.str("bounty")?.into(),
            vault: o.str("vault")?.into(),
            safe_code: o.str("safe_code")?.into(),
            masks: o.list("masks")?.iter().map(|m| String::from(*m)).collect(),
            judge_version: o.str("judge_version")?.into(),
            safe: o.u128("safe")?,
            deposit: o.u128("deposit")?,
            min_loot: o.u128("min_loot")?,
            gas: o.u128("gas")?,
            hours: o.u64("hours")?,
            commit_minutes: o.u64("commit_minutes")?,
            reveal_minutes: o.u64("reveal_minutes")?,
            first_minute: o.u64("first_minute")?,
            every_minutes: o.u64("every_minutes")?,
            safe_max: o.u128("safe_max")?,
            deposit_max: o.u128("deposit_max")?,
        };
        c.check(house)?;
        Ok(c)
    }

    /// The terms are refused when the bounty contract would refuse the round they make, or when they leave the
    /// circle open: a round nobody won must be over, its claim grace included, before the next slot.
    pub fn check(&self, house: &str) -> Result<(), &'static str> {
        let c = self;
        for a in [c.bounty.as_str(), c.vault.as_str()].into_iter().chain(c.masks.iter().map(String::as_str)) {
            if !is_account(a) {
                return Err("an account id is not a NEAR account id");
            }
        }
        let parent = c.vault.strip_suffix(house).and_then(|p| p.strip_suffix('.'));
        if !parent.is_some_and(|name| !name.is_empty() && !name.contains('.')) {
            return Err("the vault is a direct sub-account of the house");
        }
        if c.bounty == house || c.bounty == c.vault {
            return Err("the bounty contract is another account");
        }
        if !(1..=MAX_MASKS).contains(&c.masks.len()) {
            return Err("1 to 16 masks");
        }
        for (i, m) in c.masks.iter().enumerate() {
            if m == house || *m == c.vault || *m == c.bounty {
                return Err("a mask is none of the house, the vault and the bounty contract");
            }
            if c.masks[..i].contains(m) {
                return Err("each mask once");
            }
        }
        let b58 = |b: u8| b.is_ascii_alphanumeric() && !b"0OIl".contains(&b);
        if !(32..=44).contains(&c.safe_code.len()) || !c.safe_code.bytes().all(b58) {
            return Err("safe_code: a code hash in base58");
        }
        let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
        if c.judge_version.len() != 64 || !c.judge_version.bytes().all(hex) {
            return Err("judge_version: a sha256 in lowercase hex");
        }
        if c.safe == 0 || c.safe > c.safe_max {
            return Err("safe: more than 0 and at most safe_max");
        }
        if c.deposit == 0 || c.deposit > c.deposit_max {
            return Err("deposit: more than 0 and at most deposit_max");
        }
        if c.min_loot < MIN_LOOT || c.min_loot >= c.safe {
            return Err("min_loot: at least 0.1 NEAR and less than the vault holds");
        }
        if !(1..=MAX_ROUND_HOURS).contains(&c.hours) {
            return Err("hours: 1 to 24");
        }
        let minutes = c.hours * 60;
        if c.commit_minutes < 1 || c.commit_minutes >= minutes {
            return Err("commit_minutes: at least 1 and less than the round");
        }
        let turns = SAFE_TURN_MINUTES * (c.masks.len() as u64 + 1);
        if c.reveal_minutes < turns || c.commit_minutes + c.reveal_minutes > minutes {
            return Err("reveal_minutes: 3 for each mask's turn and 3 more, and both windows within the round");
        }
        if c.every_minutes == 0 || minutes + CLAIM_GRACE_MINUTES >= c.every_minutes {
            return Err("every_minutes: a round and its claim grace end before the next slot");
        }
        if c.first_minute.checked_mul(NS_PER_MINUTE).is_none() {
            return Err("first_minute: minutes since the Unix epoch");
        }
        Ok(())
    }

    /// The terms as the contract keeps them and `config` shows them.
    pub fn to_json(&self) -> String {
        Writer::new()
            .str("bounty", &self.bounty)
            .str("vault", &self.vault)
            .str("safe_code", &self.safe_code)
            .list("masks", &self.masks)
            .str("judge_version", &self.judge_version)
            .big("safe", self.safe)
            .big("deposit", self.deposit)
            .big("min_loot", self.min_loot)
            .big("gas", self.gas)
            .num("hours", self.hours.into())
            .num("commit_minutes", self.commit_minutes.into())
            .num("reveal_minutes", self.reveal_minutes.into())
            .num("first_minute", self.first_minute.into())
            .num("every_minutes", self.every_minutes.into())
            .big("safe_max", self.safe_max)
            .big("deposit_max", self.deposit_max)
            .done()
    }

    /// `new` on the vault: it owns itself, lets in the round's masks, is armed only by the bounty contract and takes
    /// only the house's rounds (house.ts `vaultInit`).
    pub fn vault_init(&self, house: &str) -> String {
        Writer::new()
            .str("owner", &self.vault)
            .list("masks", &self.masks)
            .str("arbiter", &self.bounty)
            .str("team", house)
            .done()
    }

    /// `open_safe` on the bounty contract for round `id` (house.ts `roundArgs`).
    pub fn round_args(&self, id: &str) -> String {
        Writer::new()
            .str("id", id)
            .str("safe", &self.vault)
            .list("masks", &self.masks)
            .big("min_loot", self.min_loot)
            .num("hours", self.hours.into())
            .num("commit_minutes", self.commit_minutes.into())
            .num("reveal_minutes", self.reveal_minutes.into())
            .str("safe_code", &self.safe_code)
            .str("judge_version", &self.judge_version)
            .done()
    }

    /// The schedule at `now_ns`.
    pub fn window(&self, now_ns: u64) -> Window {
        let slot = slot_at(self.first_minute, self.every_minutes, now_ns);
        let every = self.every_minutes.max(1) * NS_PER_MINUTE;
        let next = slot.map_or(self.first_minute * NS_PER_MINUTE, |s| s + every);
        let run = (self.hours * 60 + CLAIM_GRACE_MINUTES) * NS_PER_MINUTE;
        Window { slot, next, open_until: slot.map(|_| next - run) }
    }

    /// Whether round `id` may open at `now_ns` after `day`: its number, and the slot it takes. Only on a vault
    /// `make_vault` made in this very slot: the bounty contract takes the deposit even for a vault that will not arm
    /// (yesterday's, still armed, or none at all) and gives it back only later, in `on_armed`, so the house could not
    /// tell such a round from a real one and the slot would be gone.
    pub fn may_open(&self, day: &Day, id: &str, now_ns: u64) -> Result<(u32, u64), &'static str> {
        let n = round_no(id).ok_or("the round's id is race-<n>")?;
        if n <= day.last_round {
            return Err("the round's number must come after the last round's");
        }
        if n - day.last_round > MAX_ROUND_STEP {
            return Err("the round's number runs too far ahead of the last round's");
        }
        let w = self.window(now_ns);
        let slot = w.slot.ok_or("no slot has come yet")?;
        if day.last_slot_ns == slot {
            return Err("this slot has its round");
        }
        if now_ns > w.open_until.unwrap_or(0) {
            return Err("too late in the slot: the round would run into the next one");
        }
        if day.made_slot_ns != slot {
            return Err("no vault made in this slot: make_vault first");
        }
        Ok((n, slot))
    }

    /// Whether `mask` is one of the round's masks: the only accounts `home` calls.
    pub fn is_mask(&self, mask: &str) -> bool {
        self.masks.iter().any(|m| m == mask)
    }
}

/// `unstick` on the bounty contract, as house.ts sends it: the claim's number as a string (`U64`).
pub fn unstick_args(id: &str, claim: u64) -> String {
    Writer::new().str("id", id).big("claim", claim.into()).done()
}

/// `settle` and `refund` on the bounty contract.
pub fn id_args(id: &str) -> String {
    Writer::new().str("id", id).done()
}

/// Where the schedule stands at a moment. Times in ns.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Window {
    /// The latest slot at or before the moment; None before the first.
    pub slot: Option<u64>,
    pub next: u64,
    /// The last moment a round may open in this slot: one opened later could still be open at the next slot.
    pub open_until: Option<u64>,
}

/// The day as the contract keeps it: the last round it opened, the slot it opened it in, and the slot the vault that
/// stands now was made in.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Day {
    /// The number of the last round opened here (`race-<n>`), or of the house's last round before the contract.
    pub last_round: u32,
    /// The start of the slot that round was opened in, ns; 0 before any.
    pub last_slot_ns: u64,
    /// The start of the slot in which `make_vault` last made the vault, ns; 0 when no vault made here stands: a
    /// `retire` and a change of the terms clear it.
    pub made_slot_ns: u64,
}

impl Day {
    pub fn to_bytes(self) -> [u8; 20] {
        let mut b = [0u8; 20];
        b[..4].copy_from_slice(&self.last_round.to_le_bytes());
        b[4..12].copy_from_slice(&self.last_slot_ns.to_le_bytes());
        b[12..].copy_from_slice(&self.made_slot_ns.to_le_bytes());
        b
    }

    pub fn from_bytes(b: &[u8]) -> Option<Day> {
        if b.len() != 20 {
            return None;
        }
        let mut r = [0u8; 4];
        let mut s = [0u8; 8];
        let mut m = [0u8; 8];
        r.copy_from_slice(&b[..4]);
        s.copy_from_slice(&b[4..12]);
        m.copy_from_slice(&b[12..]);
        Some(Day {
            last_round: u32::from_le_bytes(r),
            last_slot_ns: u64::from_le_bytes(s),
            made_slot_ns: u64::from_le_bytes(m),
        })
    }

    pub fn to_json(self) -> String {
        Writer::new()
            .num("last_round", self.last_round.into())
            .big("last_slot_ns", self.last_slot_ns.into())
            .big("made_slot_ns", self.made_slot_ns.into())
            .done()
    }

    /// The day as `on_opened` gets it back.
    pub fn read(o: &Object) -> Result<Day, &'static str> {
        o.only(&["last_round", "last_slot_ns", "made_slot_ns"])?;
        Ok(Day {
            last_round: o.u32("last_round")?,
            last_slot_ns: o.u64("last_slot_ns")?,
            made_slot_ns: o.u64("made_slot_ns")?,
        })
    }
}

/// `home()` on a mask: no arguments; contracts/home reads none.
pub const HOME_ARGS: &[u8] = b"{}";

/// The `home` step's argument: `{"mask"}`, one of the round's masks.
pub fn home_mask<'a>(c: &Config, o: &Object<'a>) -> Result<&'a str, &'static str> {
    o.only(&["mask"])?;
    let mask = o.str("mask")?;
    if !c.is_mask(mask) {
        return Err("home: only one of the round's masks");
    }
    Ok(mask)
}

/// `made_slot_ns` while `make_vault` waits for its answer: no slot starts at it, so no round opens on it.
pub const MAKING: u64 = u64::MAX;

/// What `make_vault` hands `on_made`: the slot at `now_ns` (`slot_at`; 0 before the first) the vault counts for once
/// it stands, and `before_ns`, what stood before, kept when it was not made.
pub fn made_args(c: &Config, now_ns: u64, before_ns: u64) -> String {
    Writer::new().big("slot_ns", c.window(now_ns).slot.unwrap_or(0).into()).big("before_ns", before_ns.into()).done()
}

/// `on_made`'s arguments: the slot, and what stood before.
pub fn read_made(o: &Object) -> Result<(u64, u64), &'static str> {
    o.only(&["slot_ns", "before_ns"])?;
    Ok((o.u64("slot_ns")?, o.u64("before_ns")?))
}

/// The latest slot at or before `now_ns`, ns; None before the first (packages/network `slotAt`).
pub fn slot_at(first_minute: u64, every_minutes: u64, now_ns: u64) -> Option<u64> {
    let minute = now_ns / NS_PER_MINUTE;
    if minute < first_minute {
        return None;
    }
    let every = every_minutes.max(1);
    Some((first_minute + (minute - first_minute) / every * every) * NS_PER_MINUTE)
}

/// `race-<n>`, `n` in four to nine decimal digits: the number; else None.
pub fn round_no(id: &str) -> Option<u32> {
    let digits = id.strip_prefix("race-")?;
    if !(4..=9).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut n: u32 = 0;
    for b in digits.bytes() {
        n = n * 10 + u32::from(b - b'0');
    }
    Some(n)
}

/// `race-0007`: four digits at least, as house.ts names rounds.
pub fn round_id(n: u32) -> String {
    let digits = json::decimal(n.into());
    let mut id = String::from("race-");
    for _ in digits.len()..4 {
        id.push('0');
    }
    id.push_str(&digits);
    id
}

/// A NEAR account id: 2 to 64 characters, lowercase letters, digits and `-`, `_`, `.` between parts.
pub fn is_account(a: &str) -> bool {
    let b = a.as_bytes();
    if !(2..=64).contains(&b.len()) {
        return false;
    }
    let mut prev_sep = true;
    for &c in b {
        let sep = matches!(c, b'-' | b'_' | b'.');
        if sep {
            if prev_sep {
                return false;
            }
        } else if !(c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return false;
        }
        prev_sep = sep;
    }
    !prev_sep
}

/// A code hash as NEAR shows it: base58 of 32 bytes.
pub fn base58(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::with_capacity(48);
    for &byte in bytes {
        let mut carry = u32::from(byte);
        for d in digits.iter_mut() {
            carry += u32::from(*d) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        out.push('1');
    }
    for d in digits.iter().rev() {
        out.push(ALPHABET[*d as usize] as char);
    }
    out
}

/// What `now` shows.
pub fn now_json(c: &Config, day: Day, now_ns: u64, free: u128) -> String {
    let w = c.window(now_ns);
    let mut out = Writer::new().big("now_ns", now_ns.into());
    out = match w.slot {
        Some(s) => out.big("slot_ns", s.into()),
        None => out.null("slot_ns"),
    };
    out = out.big("next_slot_ns", w.next.into());
    out = match w.open_until {
        Some(u) => out.big("open_until_ns", u.into()),
        None => out.null("open_until_ns"),
    };
    let opened = w.slot.is_some_and(|s| s == day.last_slot_ns);
    let made = w.slot.is_some_and(|s| s == day.made_slot_ns);
    out.bool("opened", opened)
        .bool("vault_made", made)
        .bool("may_open", !opened && made && w.open_until.is_some_and(|u| now_ns <= u))
        .num("last_round", day.last_round.into())
        .str("next_round", &round_id(day.last_round.saturating_add(1)))
        .big("free", free)
        .done()
}
