//! MASK WARS house: the daily round's steps on the house's own account (`house.maskwars.near`), and nothing else.
//!
//! The house opens one sealed round a day on one safe, the vault (packages/race/src/house.ts, RULES.md). Until now the
//! daily run signed each step with a full key of the house kept in GitHub (`HOUSE_KEY`): whoever held it could spend
//! everything the house holds. With this contract on the house's account the run holds a function-call key instead,
//! for this account and for these seven methods alone, and each method does exactly one step of the day:
//!
//! - `home {mask}`: `home()` on one of the round's masks (contracts/home), which sends the house everything the mask
//!   holds above what it keeps, and nowhere else; nothing attached, exactly 10 TGas;
//! - `unstick {id, claim}`, `settle {id}`, `refund {id}`: the bounty contract's own calls, which anyone may make; the
//!   house only passes them on, with nothing attached;
//! - `retire`: the vault's `retire`, which only the house (its team) may call and which the vault itself refuses
//!   while its round can still be played; the vault's whole balance comes back to the house;
//! - `make_vault`: the vault made again in one transaction that adds no key, with the code the terms pin (the call's
//!   input is the wasm itself and must hash to `safe_code`), the NEAR the terms pin and `new` with the arguments the
//!   terms pin. Only while the house keeps enough after it to open the round. Once the vault stands, `on_made` records
//!   the slot it was made in;
//! - `open_round {id}`: `open_safe` on the bounty contract with every term pinned and the pinned deposit, for a round
//!   `race-<n>` after the last, once per slot of the schedule, only on a vault `make_vault` made in that same slot,
//!   and only while a round opened now is over, its claim grace included, before the next slot. The bounty contract
//!   takes the deposit even for a vault that will not arm and gives it back only later: a round on yesterday's vault,
//!   or on none, would cost the day its slot.
//!
//! NEAR leaves the house only to the vault (the pinned sum, when it is made) and to the bounty contract (the pinned
//! deposit, when a round opens). Both come back: the vault's balance when it retires, the deposit to the winner or,
//! refunded, to the house. A function-call key never attaches NEAR, so it cannot reach `configure`, which wants one
//! yoctoNEAR and so a full key: the owner's, kept off GitHub. The full key can also deploy new code here, as on any
//! account.
//!
//! The arguments, gas and deposits are the ones house.ts sends (`vaultInit`, `roundArgs`, `stepTx`): house.ts sees
//! this contract on the house and sends each step to the house (`houseStepTx`) instead of signing it as the house.
//!
//! The crate is two halves: the rules (rules.rs, json.rs), plain Rust tested natively; and the contract (contract.rs),
//! which speaks to NEAR through its host functions with no SDK, so the code the house's account locks NEAR for stays
//! at 38 KB, 0.38 NEAR of storage, where the same contract on near-sdk built to 172 KB.

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

pub mod json;
pub mod rules;

#[cfg(target_arch = "wasm32")]
mod contract;

#[cfg(test)]
mod tests;
