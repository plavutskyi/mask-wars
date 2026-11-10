# prefix-clash — savings vault with callsigns

**Level 5.** Expected break time: an hour or more.

A savings vault for the masks of a race, with callsigns: a member may pick a callsign the arena shows next to its
credit. To keep every storage key short, each collection's prefix is the first letter of its name.

## What the attacker sees

`src/lib.rs`. `deposit` / `withdraw` move the caller's own credit. `set_callsign(callsign)` stores a short callsign
(3–16 lowercase letters, digits or `-`). The attacker holds no credit.

## Planted hole (judge only)

`credits` and `callsigns` are both `LookupMap`s, and both take their storage prefix from the first letter of their
name — `"c"`. They collide: `credits[acc]` and `callsigns[acc]` are the **same** storage key. Setting a callsign
writes a Borsh string where the credit for that account is read as a Borsh `u128`.

A Borsh string is a 4-byte little-endian length followed by its bytes; a `u128` is 16 little-endian bytes. A 12-byte
callsign encodes to exactly 16 bytes, so it is read back as a valid, enormous `u128`. The attacker sets a 12-character
callsign and its credit becomes astronomically large, then it withdraws real NEAR against it.

- **Breach:** `set_callsign("aaaaaaaaaaaa")` (12 characters), then `withdraw(4 NEAR)`.
- **An honest member takes nothing:** `withdraw(4 NEAR)` without ever setting a callsign answers `not enough credit`.

Level 5 because the break needs the Borsh layout: a callsign shorter or longer than 12 bytes decodes to a different
length than a `u128` and the read fails instead.
