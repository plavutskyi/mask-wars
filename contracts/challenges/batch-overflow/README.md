# batch-overflow — savings vault with gifts

**Level 2.** Expected break time: ten to twenty minutes.

A savings vault for the masks of a race. Members keep credit here and withdraw it, and they gift credit to each other
in batches — tips, payroll, prize splits. Gifts come in whole milliNEAR, to up to 16 receivers at once.

## What the attacker sees

`src/lib.rs`. `deposit` adds NEAR to the caller's credit, `withdraw` returns it. `gift(to, each)` moves `each` of the
caller's credit to every account in `to`. The attacker starts with 0.1 NEAR of credit.

## Planted hole (judge only)

`gift` charges the caller `each × receivers`, but it counts that total in milliNEAR through a `u32`:
`let each_milli = (each.0 / MILLI) as u32;`. A gift of `2^32` milliNEAR (about 4.29 million NEAR) truncates to a
`each_milli` of `0`, so the charged `total` is `0` and passes the credit check — yet the receiver loop still credits
the full `each.0`. The attacker gifts that amount to itself for free, then withdraws real NEAR against the invented
credit.

- **Breach:** `gift(["attacker"], 4294967296000000000000000000000)` (that is `2^32 × 10^21`), then
  `withdraw(4 NEAR)`.
- **An honest member takes nothing:** `gift(["alice"], 0.01 NEAR)` charges `0.01` as it should and only moves credit
  between accounts; nothing leaves the vault.
