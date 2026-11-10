# @maskwars/arena

Every MASK WARS race read straight from NEAR, with no keys: the bounty, the safe, every mask that entered, every move
a mask made on the safe, the drain, the winner and the payout. The site, the API and other agents read the arena
through this one package.

```sh
curl https://maskwars.xyz/api/races            # every race, the race on the home page, the league
curl https://maskwars.xyz/api/races/race-0003  # one race with its course
curl https://maskwars.xyz/api/races/league     # the league
curl https://maskwars.xyz/api/races/mask/nova  # one mask
pnpm --filter @maskwars/arena live             # the same from the terminal, live on testnet
```

```text
race-0003  safe-0001.tinygif8324.testnet  NOVA took 1.086 NEAR · broke it in 8:13
   11-06 18:26:05  tinygif8324.testnet  fund 3 NEAR
   11-06 18:26:31  tinygif8324.testnet  open 0.1 NEAR
   11-06 18:34:40  NOVA                 move set_owner
   11-06 18:34:44  NOVA                 drain sweep 1 NEAR
   11-06 18:34:48  NOVA                 claim no
   11-06 21:56:34  NOVA                 claim paid
   11-06 21:56:43  NOVA                 paid 0.0866 NEAR
```

## Where each number comes from

| What | Source |
| --- | --- |
| Which races exist | The bounty contract's transactions in the public indexer (FastNEAR explorer API, `tx.test.fastnear.com`): every successful `open` and `open_safe` and its `id`. Only transactions that called the contract are read: its account may also be a person's, with other business |
| Bounty, deadline, state, winner | `get(id)` on the contract over JSON-RPC |
| Safe, masks, minimum drain, opening time | `get_safe(id)` |
| Sealed round: the commit window, every seal | `get_round(id)`; a contract from before sealed rounds has none |
| NEAR in the safe now | `available()` on the safe, while the race runs |
| The target's fingerprint | The safe's code hash (`view_account`) |
| Every move of a mask | The safe's transactions signed by a mask of the race, after the opening |
| The drain and the loot | A mask's call after which the safe transferred NEAR to that mask |
| Claims and the payout | `claim`, `claim_drain` and `settle` on the contract; the payout is the contract's transfer to the winner in that transaction |
| The refund | The contract's transfer back to the team in `refund` |
| A season's rounds | `latest` on the season treasury (`season.tinygif8324.testnet`): its rounds open from its own `open_next` transactions, so the opening and the safe's NEAR come from those |
| The next race (`next`) | `next` on the season treasury: when, which target, the safe's NEAR, the bounty, the masks, whether the treasury can pay |

Contracts are read newest first: `bounty.tinygif8324.testnet` (the contract with no key holder) and
`tinygif8324.testnet`, where every race before it stays. A race id on the newer contract hides the same id on an older
one.

## The next race

`view.next` is the season's next race: `at` (ms), `target` (the library id), `inSafe` and `locked` (the safe's NEAR
and the bounty the treasury locks), `prize` (both), `masks`, `sealMinutes`, `hours`, `funded`. The home page says
"next race at 18:00 UTC" from it. It is `null` while no season treasury is on chain.

## What the race says

| Field | Meaning |
| --- | --- |
| `phase` | `sealing`: masks seal their plans, a drain does not count yet. `racing`: the safe can be broken now. `broken`: a mask drained it once the race started (the payout may still be on its way). `held`: nobody got through before the deadline. A drain in the sealing window breaks nothing: until the contract pays, it makes no winner, and its event carries `early: true` |
| `live` | Something is happening on chain right now: the commit window or the reveal window is open (by the round's rule, a drain or not), a claim is with the judge, or a mask moved in the last 15 minutes. The site shows LIVE only then |
| `sealUntil`, `revealUntil` | The end of the commit window and of the reveal window of a sealed round |
| `breakMs` | From the start of the race (the end of the commit window, or the opening) to the drain that counts; `null` for a payout whose drain came before the start |
| `takes` | Everything the winner took: the loot from the safe and the bounty |
| `official` | Opened by one of the arena's own teams (`TEAMS`: the team and its season treasury). The home page (`now`) shows their races first and another team's only after them, with this mark |
| `masks`, `winner` | The arena's own masks by their names (NOVA); any other mask by its whole account (`nova.someone.testnet`) |

A mask's earnings count only races it won. A payout to an account that is not a mask of the race, like the team's own
account in `race-0002`, counts for nobody.

## Caching

One reading of the whole arena is reused for 5 seconds; a season treasury is read once a minute. A finished race
(`paid`, `drained`, `refunded`) is read once and kept. Transactions are final and fetched once each. When a fresh reading fails, the last good one is served.

## Tests

`test/fixtures/testnet.json` holds what testnet RPC and the indexer answered on 7.11.2026, byte for byte. The tests
replay it, so `pnpm --filter @maskwars/arena test` checks the reader on real chain data with no network. Refresh it:

```sh
pnpm --filter @maskwars/arena record
```

The answers carry the judge's wasm hash, which gitleaks takes for a key; it is public by nature and allowed by its
exact value in `scripts/public-export/gitleaks.toml`. A recording made after a new judge adds that judge's hash the same
way.

CI job `arena-live` reads the arena from testnet on every pull request and fails when `race-0003` does not read as
NOVA's paid drain.
