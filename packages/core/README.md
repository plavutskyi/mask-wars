# @maskwars/core

The league core of the first design of MASK WARS (1 to 2 Nov 2026): market duels between two masks, parimutuel books
on each fight, seals, and Elo ratings. It is pure TypeScript, with no network, no clock and no randomness of its own.
All money is bigint USDC in minimal units (6 decimals).

## Status

This package does not run in the arena today; the live arena is the sealed round of `packages/race` and
`contracts/bounty`. It stays because `packages/media` imports its ids and types (`CoreError`, `assertFightId`,
`assertMaskId`, `Side`). The vectors named below pin its rules byte for byte.

## Book

One parimutuel pool over outcomes `0..n-1` (`src/book.ts`). A fight has a `main` book and a `last_call` book, with two
outcomes each. The season pool, WHO'S UNDER, is a 6-outcome book bound to a mask, not to a fight.

```text
T = all stakes, W = stakes on the winner
VOID if W == 0 or W == T
rake = min(floor(T * rake_bps / 10000), T - W)
D = T - rake
payout = floor(D * stake / W)          per back (per op_id)
dust = D - sum of payouts              goes to the rake
```

Since rake is at most T - W, D is at least W, so every winning back gets at least its stake. `rake_bps` defaults to 500.
The house keeps rake + dust, and `mask_share = min(floor(T * 100 / 10000), house)` of it is credited to the winning
mask. A void book (`empty`, `no_winner_backs`, `one_sided`, `fight_void`) refunds every back exactly. A repeated
`op_id` with the same content changes nothing, and one with other content is refused. Vectors: `vectors/books.json`.

## Score

```text
score_bp = floor((final_usdc - start_usdc) * 10000 / start_usdc) + (25 if call == the rival's effective primary)
```

`floor` rounds toward minus infinity for any sign (`floorDiv`, `src/math.ts`). The bigger `score_bp` wins, and an equal
score voids the fight (`scoreBp`, `src/market-duel.ts`). Vectors: `vectors/score.json`, from `start_usdc`,
`final_usdc` and `called_it` to `score_bp`.

## Seal

Hashes that commit to a hidden choice (`src/seal.ts`). The fields are UTF-8 strings joined by one `0x00` byte, and no
field may contain `0x00`. `salt32` is 32 random bytes written as 64 lower-case hex characters and hashed as that text.

```text
seal     = sha256("maskwars.seal.v1"     00 fight_id 00 mask_id 00 primary 00 backup 00 call 00 salt32)
identity = sha256("maskwars.identity.v1" 00 mask_id 00 identity 00 salt32)
strategy = sha256("maskwars.strategy.v1" 00 mask_id 00 text 00 salt32)
```

`fight_id` looks like `f-<season>-<number>`, and `mask_id` is lower-case letters and hyphens (`src/ids.ts`).
`sealMatches` compares two digests in constant shape. Vectors: `vectors/seals.json`, with the domain, the fields in
order, the exact `preimage_hex` and the `sha256`.

## Market Duel v1

The first discipline (`src/market-duel.ts`), plugged into the fight through `src/discipline.ts`.

- The basket is BTC, ETH, SOL, NEAR and ZEC. Before the bell each mask seals `primary`, `backup` (not `primary`) and
  `call`, its guess of the rival's coin.
- If both seal the same primary, the low bit of the first byte of `sha256(fight_id)` names the side that takes its
  backup: 0 is the left corner, 1 the right. Vectors: `vectors/same-primary.json`.
- At 1:00, 2:00, 3:00 and 4:00 each side calls HOLD or ROTATE to another coin; ROTATE is allowed once a fight.
- The bells are 5 minutes apart, and the main book closes 30 s before the first. LAST CALL opens at 2:30 and closes at
  3:30; a back in its last 30 s is sealed, counted in full but left off the screen until the bell.
- The bigger `score_bp` wins; an equal score is VOID.

## Fight and rating

- `src/fight.ts` is the state machine for every discipline: `OPEN -> CLOSED -> SEALED -> LIVE -> RESULT -> PAID`, with
  `VOID` from any state before `PAID`. A step the state does not allow throws `IllegalTransitionError`; time is the
  `now` the caller passes in.
- `src/rating.ts` keeps an Elo rating per discipline: start 1200, `E = 1 / (1 + 10^((opponent - rating) / 400))`, K of
  48 for the first 10 fights, then 32. It also keeps a 95% interval, Call%, the Model Index (the same Elo for the
  models under the masks) and weight classes by the NEAR in a mask's vault. A VOID fight moves no rating.

## Run its tests

```bash
pnpm --filter @maskwars/core test        # vitest, including a check that vectors/*.json match the generator
pnpm --filter @maskwars/core typecheck
pnpm --filter @maskwars/core vectors     # regenerates vectors/*.json from the core
```

## Key files

| File | What it does |
| --- | --- |
| `src/book.ts`, `src/market-duel.ts`, `src/seal.ts` | Books, Market Duel v1, seals |
| `src/fight.ts`, `src/rating.ts` | The fight's state machine; Elo, Call%, the Model Index |
| `src/vectors.ts`, `scripts/gen-vectors.ts` | Build and write `vectors/*.json` |
