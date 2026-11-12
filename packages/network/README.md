# @maskwars/network

Where MASK WARS lives on each NEAR network, and the limits of the money it moves there. There is one file per network,
`mainnet.json` and `testnet.json`. `src/index.ts` checks both files with `parseNetwork` as it loads them, so a fault in
either one stops every process that imports the package.

## Who reads it

The site and its API (`apps/web`), the arena reader (`packages/arena`), the race and the house's day
(`packages/race`, run by the workflows in `.github/workflows`), the MCP server (`apps/mcp`), MASK CHECK
(`packages/check`), and the owner's scripts in `scripts/testnet` and `scripts/mainnet`. Rust tests read the same files:
`contracts/home` checks its compiled house and its 0.4 NEAR against `house` and `round.mask_keep`, and the sandbox
test `contracts/challenges/runner/tests/home.rs` takes the house and `mask_keep` from them.

## Which network: `MASKWARS_NETWORK`

`networkOf` reads the variable. Unset or empty means `testnet`, and the only other accepted value is `mainnet`. Anything
else throws, even with padding around it, so a typo stops the process instead of quietly reading testnet. `NET` is the
chosen file and `NETWORK_ID` its id. maskwars.xyz is built with `MASKWARS_NETWORK=mainnet`, and the workflows take it
from the repository variable of the same name.

## On mainnet: the `round` block

The house's daily round, as `mainnet.json` gives it. Amounts are NEAR, written as decimal strings.

| Field | Value | What it is |
| --- | --- | --- |
| `live` | `true` | The round runs on schedule, so the site tells when the next one opens |
| `judge` | `1f8e1aca…f86f7` | The judge's sha256 the house opens rounds with; a test holds it equal to `scripts/mainnet/judge-args.json` |
| `first_minute`, `every_minutes` | `1080`, `1440` | Slots counted in minutes since the Unix epoch: the 18:00 UTC slot, every day |
| `safe` | `1.93` | What the house puts into the vault |
| `stake` | `1.65` | About how much of that the vault's code and state lock; the rest is what a mask can take |
| `deposit` | `0.25` | The round's deposit on the bounty contract: the bounty and the storage it reserves |
| `min_loot`, `gas` | `0.1`, `0.1` | The least a drain must take; what the house keeps free for gas |
| `mask_keep` | `0.4` | What a mask keeps, besides its storage, when its winnings go home; `contracts/home` keeps exactly this |
| `hours` | `4` | The round's length |
| `commit_minutes` | `45` | The commit window, in which masks seal their plans |
| `reveal_minutes` | `60` | The reveal window: at least 3 minutes for each mask's turn, and 3 more |

The same file names the accounts (`bounty.maskwars.near`, `house.maskwars.near`, `vault.house.maskwars.near`, the three
masks, `jobs`, `crews`, and the factory `masks.maskwars.near`, on chain with no key since 12 Nov 2026). It also names
the vault's code (`safe_code`), the code of `home` on the masks (`home_code`), and OutLayer (`outlayer.near`). It sets
the RPCs (FastNEAR, then dRPC), the fees of Get NEAR and Swap (`get_near`, `swap`), the guests of the round (`guests`)
and the `limits` the owner's scripts refuse to exceed. `sections` is the team's statement of which parts are on chain
on this network, not a reading of the chain; on mainnet `arena` and `forge` are `true`, and `jobs` is still `false`
though `jobs.maskwars.near` is deployed, with no job yet.

The fee: `fee_bps` is 25, what the site asks 1Click to give `maskwars.near` in `appFees` (`swapRequest` and
`nearRequest` in `packages/pay`). What a person pays is what 1Click's quote lists, and the pages show that sum
(`feeBps`). In the two swaps recorded on 12 Nov 2026 the quote listed 13 bps to `maskwars.near`, not 25, and a second
entry to the account `5880ad2b…47dd`, which the site names NEAR Intents: 20 bps on USDC to NEAR, so 33 bps in all
(0.33% on the page), and 13 bps on USDC to USDC, so 26 in all.

## What `parseNetwork` refuses

An account that is not on its network. An arena account (bounty, season, scheduler, house, factory, jobs, crews, a
mask) that is not a sub-account of `admin`. A vault that is not a direct sub-account of the house. A code hash that is
not base58. A Get NEAR or Swap fee above 100 bps. And a `round` that breaks its own arithmetic: a `safe` below `stake`
plus twice `min_loot`; a round or its guests above `limits.house_max`; windows that do not fit in `hours` or give a
mask less than its 3-minute turn; or a round that, with its 12-hour claim grace, would still be open when the next
slot comes.

## Run its tests

```bash
pnpm --filter @maskwars/network test        # vitest: both files, refusals of parseNetwork, slots, MASKWARS_NETWORK
pnpm --filter @maskwars/network typecheck
```

## Key files

| File | What it does |
| --- | --- |
| `mainnet.json` | NEAR mainnet: accounts, code hashes, the round, fees, limits |
| `testnet.json` | NEAR testnet, the same shape |
| `src/index.ts` | Types, `parseNetwork`, `networkOf`, `NET`, `yocto`, `slotAt`, `codeHashHex`, `whereIs` |
| `test/network.test.ts` | The checks on both files and on the code above |
