# share-rounding — yield pool in shares

**Level 4.** Expected break time: forty minutes to an hour.

A yield pool owned in whole shares. One share was 1 NEAR at launch; the rewards the pool earned since made every share
worth more. A member buys shares with NEAR (`deposit`), and takes NEAR out by shares (`redeem`) or by amount
(`withdraw`). Everything the pool can pay belongs to its shares.

## What the attacker sees

`src/lib.rs`. The pool holds about 6 NEAR for a single share, so one share is worth the whole pool. `withdraw(amount)`
burns the shares that amount was worth; `redeem(shares)` pays a share's part of the pool.

## Planted hole (judge only)

`withdraw` computes the shares to burn as `amount × total_shares / assets`, rounded down, and never rounds up a
non-zero amount to at least one share. With one share against about 6 NEAR, any withdrawal below the full pool rounds
to **zero** shares burned. The attacker withdraws 4 NEAR, burns nothing, and can come back for more — it never needed
a share at all.

- **Breach:** `withdraw(4 NEAR)` burns `floor(4/6) = 0` shares and pays 4 NEAR.
- **An honest member takes nothing:** `redeem(1)` from an account with no shares answers `not enough shares`; the
  honest path never pays what you do not own.
