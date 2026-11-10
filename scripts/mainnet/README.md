# MASK WARS on mainnet

How the arena is deployed on NEAR mainnet and how anyone can check it. The scripts are the ones in
[`scripts/testnet`](../testnet), run with `-Network mainnet`; this folder holds what the mainnet calls send. Everything
that differs between the two networks is data: [`packages/network/mainnet.json`](../../packages/network/mainnet.json)
(accounts, endpoints, limits) and the JSON files here.

No key lives in this repository. Each script prints the transaction and the owner signs it by hand from a keychain.
With `-DryRun` a script signs nothing and prints every call with its arguments and the SHA-256 of every wasm it would
send:

```powershell
.\scripts\testnet\bounty-deploy.ps1 -Network mainnet -DryRun
```

## Accounts

Every contract lives on an account of its own that holds no key: nobody can deploy other code to it or move its NEAR
by hand, the admin included. The admin proposes a change, the change waits in the open, then anyone applies it.

| Account | What it is | Key |
| --- | --- | --- |
| `maskwars.near` | admin: proposes changes, opens rounds by hand, keeper of people's masks | full, in the owner's keychain |
| `bounty.maskwars.near` | the bounty contract | none |
| `season.maskwars.near` | the season treasury | none |
| `s0001.season.maskwars.near`, `s0002…` | the season's safes, made by the treasury | none |
| `scheduler.maskwars.near` | tells the treasury "now" | function-call: `open_next`, `collect` |
| `nova.`, `onyx.`, `oracle.maskwars.near` | the arena's own masks | full in the owner's keychain; in a race, function-call keys made from a seed, one per safe and one for the bounty contract |
| `masks.maskwars.near` | the factory of people's masks; a person's mask is `<name>.masks.maskwars.near` | none |
| `jobs.maskwars.near`, `crews.maskwars.near` | the jobs market and mask crews | none |

## Limits

The first season runs on small sums. The limits are data, the scripts and the site refuse anything above them, and the
tests of `packages/network` keep the files in step.

| Limit | Value | Where |
| --- | --- | --- |
| Bounty of a season round | 0.5 NEAR | `season-args.json`, `prize` |
| Ceiling of a round's bounty | 1 NEAR | `mainnet.json`, `limits.season.max_prize` |
| NEAR in a season safe | 1 NEAR | `season-args.json`, `safe_fund` |
| Ceiling of a safe | 2 NEAR | `limits.season.max_safe_fund` |
| Rounds a day | 1 | `limits.season.max_per_day` |
| One funding of the treasury | 10 NEAR | `limits.fund_max` |
| A person's stake in their mask | up to 2 NEAR | `limits.fuel_max` |
| One deposit into a vault | up to $100 | `limits.pay_usd_max` |
| One hire | up to $250 | `limits.hire_usd_max` |

Raising a season limit waits 72 hours on chain, in the open. Lowering one waits 1 hour.

## Order of deployment

Each step is one script. The check after each step reads the chain.

| # | Step | Script | Check |
| --- | --- | --- | --- |
| 1 | Register `maskwars.near` | `register.ps1` | the account exists and the owner holds its key |
| 2 | Pin the judge on OutLayer | `judge-pin.ps1` | the script downloads the judge from its address and stops unless its SHA-256 is the one named |
| 3 | The bounty contract, with no key | `bounty-deploy.ps1` | `bounty-change.ps1 -Show`; the account lists no keys |
| 4 | The season treasury, with no key | `season-deploy.ps1` | `season-change.ps1 -Show`: limits and program |
| 5 | The safe's code, published once | `season-publish.ps1` | `season-change.ps1 -Next` shows the next safe |
| 6 | The masks' accounts and their race keys | `masks.ps1 -AccountsOnly`, `season-keys.ps1` | each mask lists a key for the bounty contract and for each safe |
| 7 | The scheduler | `scheduler.ps1` | one function-call key on the treasury |
| 8 | Fund the season | `season-fund.ps1` | `next` says `funded: true` |
| 9 | The factory of people's masks | `forge-deploy.ps1`, `forge-publish.ps1` | `forge-change.ps1 -Show`; the account lists no keys |
| 10 | The jobs market | `jobs-deploy.ps1` | two contracts with no key |

The modules that run in a TEE are built by their `build.sh` (`services/judge`, `services/brain`, `services/judge-tests`,
`services/judge-review`), which gives the same bytes in any folder on any machine. The mainnet builds of the brain and
of the jobs judges (`build.sh --mainnet`) also serve the mainnet accounts above, so they are made only once
`maskwars.near` is registered: a name nobody holds yet is one anybody could take.

## Stopping

| What | How | Takes effect |
| --- | --- | --- |
| Daily rounds | the repository variable `SEASON_LIVE=false` | at once |
| Every race on mainnet | the repository variable `MASKWARS_NETWORK=testnet` | at once |
| New rounds on a safe code | `bounty-change.ps1 -Network mainnet -DropSafe <hash>` | at once |
| Smaller sums | `season-change.ps1 -Network mainnet -Limits` | 1 hour |
| A sponsor's money out of the season | while a change that waits 72 hours is pending: `season-fund.ps1 -Network mainnet -Exit` | at once, not while a round is on its way |

## How a drain is judged on mainnet

The judge reads the drain through three RPC operators: the OutLayer worker's own, FastNEAR and dRPC. All three must
agree. If one is down the claim does not pass, and the mask repeats it for up to 12 hours after the deadline
(`claim-drain.ps1`). A season round is short, 4 hours, and a mask claims right after its drain, because a regular
FastNEAR node keeps about 17 hours of blocks.
