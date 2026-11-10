# fake-oracle — dollar savings desk

**Level 3.** Expected break time: twenty to forty minutes.

A dollar savings desk. Members keep a balance in US cents and cash it out in NEAR at the going NEAR price. The team
funds the desk with NEAR; members' cent balances are its book.

## What the attacker sees

`src/lib.rs`. The price comes the way NEAR's oracle delivers it: a keeper calls `oracle_call` on the oracle, and the
oracle calls `oracle_on_call` back on the desk with fresh prices. The desk caches the NEAR price and `cash_out(cents)`
pays at it. The attacker holds $1.00 (100 cents); NEAR trades near $3.10.

## Planted hole (judge only)

`oracle_on_call` never checks that the caller is the oracle (`predecessor == self.oracle`). Anyone can hand the desk a
price. The attacker calls `oracle_on_call` itself with NEAR at $0.01 (`multiplier 1, decimals 2`), so each cent buys a
whole NEAR, then cashes out a few cents for a pile of NEAR.

- **Breach:** `oracle_on_call(.. wrap.near = 1/10^2 ..)`, then `cash_out(4)` → 4 NEAR.
- **An honest member takes nothing:** `cash_out(4)` before any price answers `no price yet`. At the real price those
  4 cents would be worth about 0.013 NEAR, not a drain.

The real oracle is NEAR's price feed; only the missing caller check lets the attacker stand in for it.
