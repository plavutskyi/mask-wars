# pause-bypass — paused rewards pool

**Level 1.** Expected break time: a few minutes.

A rewards pool for the masks of a race. The team funded it and allotted each member a share. After an incident the
owner paused the pool, and it stays paused until its members move to v2. While it is paused, no reward is meant to
leave it.

## What the attacker sees

`src/lib.rs`. The pool is paused (`is_paused` → true). `claim(amount)` sends part of the caller's own allotted
rewards to the caller; `claim_for(member, amount)` does the same for a member, so a member with no NEAR for gas can
still be paid. `pause` / `unpause` are the owner's.

## Planted hole (judge only)

`claim` checks the pause (`when_running`), `claim_for` does not. The pause is the only thing meant to hold the pool
shut, so a member calls `claim_for(itself, its allotment)` and walks its reward out of a pool that is supposed to be
frozen.

- **Breach:** `claim_for("attacker", 3 NEAR)` — the attacker's own allotment, paid out while the pool is paused.
- **An honest member takes nothing:** `claim(amount)` answers `the pool is paused`.

Everything each claim pays is still capped at the member's allotment, so this is a pure pause bypass, not an
over-payout.
