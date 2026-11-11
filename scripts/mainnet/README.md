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
| `house.maskwars.near` | the house: opens the daily round and takes back what it leaves | full, in the owner's keychain; a second, hot one only if the owner adds it |
| `vault.house.maskwars.near` | the safe of the daily round: retires itself after the round and is made again under the same name | none |
| `nova.`, `onyx.`, `oracle.maskwars.near` | the arena's own masks; each runs `home`, which sends its winnings to the house and nowhere else | full in the owner's keychain; in a race, function-call keys made from a seed, one per safe and one for the bounty contract |
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
| The house's daily round | 1.93 NEAR in the vault, a deposit of 0.25 NEAR, a drain from 0.1 NEAR | `mainnet.json`, `round` |
| A safe and a deposit sent by hand | up to 2.5 and 1.1 NEAR | `limits.hand` |
| What the house holds | up to 3.5 NEAR | `limits.house_max` |
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

## The circle: a round every day on the house's vault

The season's treasury needs NEAR the arena does not hold yet. The circle runs a live round every day on what is already
there. The NEAR goes round: the house puts it into the vault and the round's bounty, the mask that wins takes it, and it
comes home to the house for the next round. A won round takes about 0.04 NEAR out of the circle (gas, the judge's fee,
the round's records).

- **The house** is a plain account, the team of the daily rounds. It has no say over the bounty contract, the judge or
  the masks.
- **The vault** is one safe with no key. Once its round is over it deletes its own account and gives its whole balance,
  the stake its code locked included, back to the house (`retire`, the house's call alone). The house makes it again
  under the same name the next day. The vault asks the bounty contract how the round ended before it goes: after a
  payout it retires once the round's deadline has passed, after a round nobody won once the bounty is refunded. While a
  round is on, nobody moves it.
- **`home`** ([`contracts/home`](../../contracts/home)) is a code of 1.3 KB on each of the arena's own masks, built
  without near-sdk. Its one method, `home()`, takes no arguments and anyone may call it: everything the mask holds
  above 0.4 NEAR and the stake of its own storage goes to `house.maskwars.near`, written into the code, and at or
  below that nothing goes. The masks' keys stay as they are and play rounds as before. Its code hash is `home_code` of
  `mainnet.json`, and the daily step calls it only on a mask that runs exactly that code.
- **The daily step** ([`packages/race/src/house.ts`](../../packages/race/src/house.ts)) first brings the masks' winnings
  home (`home()` on each mask that holds 0.01 NEAR or more above what it keeps, counted before the house checks it can
  pay), then ends yesterday's round
  (`settle` or `refund`; `unstick` for a claim the judge never answered), retires the vault, makes it again in one
  transaction that adds no key (create, fund, deploy, `new`) and opens today's round. Each part reads the chain first
  and repeats nothing, so a run that died is simply run again.
- **Checks.** Before the vault is made, the wasm must hash to `safe_code` of `mainnet.json` and the bounty contract must
  list that code. After, the account must run that code, hold no key, own itself and name the house as its team. A day
  that cannot open (yesterday's round is not over, the house cannot pay) is said plainly and skipped; a vault is never
  made without the NEAR to open its round.

### One round, step by step

| Step | Where the NEAR goes | NEAR |
| --- | --- | --- |
| `retire`, from the second day on | vault to house | about 1.68 after a won round, 1.93 after one nobody won |
| The vault, one transaction | house to vault | 1.93: about 1.65 is the stake of its code and state, 0.28 is what the masks race for |
| `open_safe` | house to the bounty contract | 0.25: about 0.11 is the bounty, about 0.114 of reserve comes back at the payout |
| A mask wins | vault and bounty contract to the mask | about 0.25 and 0.11 |
| `home()`, the next day's first step | mask to house | all the mask holds above 0.4 NEAR and its storage's stake |

### Setting it up, once

| # | Step | Script | Transactions |
| --- | --- | --- | --- |
| 1 | Let the bounty contract take the vault's code | `bounty-change.ps1 -Network mainnet -AllowSafe`, an hour later `-Apply`, then `-Show` | 2 |
| 2 | The house's account | `house.ps1 -Network mainnet` | 1 |
| 3 | The masks' spare NEAR to the house | `house.ps1 -Network mainnet -Collect` | 1 per mask |
| 3a | `home` on each mask, so its winnings go home every day with nobody signing | `node scripts/mainnet/home-deploy.mjs` prints three `near contract deploy` commands, one per mask, each signed by that mask's key from the keychain; it checks the file against `home_code` first. Each locks about 0.0135 NEAR of the mask's own balance for the code. Check: `near account view-account-summary nova.maskwars.near network-config mainnet now` shows as the contract's SHA-256 the one `home-deploy.mjs` prints, and `house.ps1 -Network mainnet -Show` names no mask whose winnings stay with it | 1 per mask |
| 4 | Each mask's key on the vault, good for every round | `season-keys.ps1 -Network mainnet -Safe vault.house.maskwars.near -SafeOnly -Allowance unlimited` | 1 per mask |
| 5 | Optional: a hot key for the house | `house.ps1 -Network mainnet -HotKey`, then the secret `HOUSE_KEY` of the environment `season-mainnet` | 1 |
| 6 | The repository variables `MASKWARS_NETWORK=mainnet`, `SEASON_LIVE=true` | | 0 |

`house.ps1 -Network mainnet -Show` reads the chain and prints what the house holds and which steps of the day are left.

### Every day

With the hot key the `Season` workflow does the whole day at 18:04 UTC and nobody signs. Without it the day is three
scripts and one run, each script reading the chain and sending only what is left:

| # | Script | What it sends |
| --- | --- | --- |
| 1 | `retire.ps1 -Network mainnet` | `home()` on each mask that holds winnings, `refund` or `settle` if yesterday's round needs one, then `retire` |
| 2 | `safe-deploy.ps1 -Network mainnet -House` | the vault, in one transaction |
| 3 | `open-safe.ps1 -Network mainnet -House` | `open_safe` with the deposit |
| 4 | Actions, `Season`, Run workflow | nothing: it finds the round open and races it |

Without `HOUSE_KEY` the workflow signs nothing and stays green: it lists the steps that wait for a signature and races
a round it finds open and sealing.

### What the hot key can do

A NEAR function-call key cannot make an account, deploy code or attach a deposit, so a day with nobody signing needs a
full key of the house's account. This is the one full key the workflows ever hold, and it is the owner's choice to add
it.

- Whoever holds `HOUSE_KEY` can spend what the house holds, about 3 NEAR. The scripts never bring the house above
  `limits.house_max`.
- It cannot change the bounty contract or the judge, touch a mask or its keys, or move the vault while a round is on:
  the vault holds no key and retires only once its round is over, and then only to the house.
- It lives in the environment `season-mainnet` (Deployment branches: `main` only), never among the repository's
  secrets; the workflow's `guard` job stops the run if it ever does.
- `house.ps1 -Network mainnet -DropHotKey` deletes it with one transaction signed by the key in the keychain.

## Stopping

| What | How | Takes effect |
| --- | --- | --- |
| Daily rounds | the repository variable `SEASON_LIVE=false` | at once |
| The house's hot key | `house.ps1 -Network mainnet -DropHotKey`, then delete the secret `HOUSE_KEY` | at once |
| The house's NEAR out of the circle | `retire.ps1 -Network mainnet` once the round is over, then a plain transfer from the house | at once |
| Every race on mainnet | the repository variable `MASKWARS_NETWORK=testnet` | at once |
| New rounds on a safe code | `bounty-change.ps1 -Network mainnet -DropSafe <hash>` | at once |
| Smaller sums | `season-change.ps1 -Network mainnet -Limits` | 1 hour |
| A sponsor's money out of the season | while a change that waits 72 hours is pending: `season-fund.ps1 -Network mainnet -Exit` | at once, not while a round is on its way |

## How a drain is judged on mainnet

The judge reads the drain through three RPC operators: the OutLayer worker's own, FastNEAR and dRPC. All three must
agree. If one is down the claim does not pass, and the mask repeats it for up to 12 hours after the deadline
(`claim-drain.ps1`). A season round is short, 4 hours, and a mask claims right after its drain, because a regular
FastNEAR node keeps about 17 hours of blocks.
