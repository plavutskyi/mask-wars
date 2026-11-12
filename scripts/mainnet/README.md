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
| One top-up quote for a vault (a larger transfer to its address is still swapped into the same vault) | up to $100 | `limits.pay_usd_max` |
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
| 9 | The factory of people's masks | `node scripts/mainnet/forge.mjs` prints every step (below); or `forge-deploy.ps1`, `forge-publish.ps1` | `forge-change.ps1 -Show`; the account lists no keys |
| 10 | The jobs market | `jobs-deploy.ps1` (the commands and the budget: `node scripts/mainnet/jobs.mjs`) | two contracts with no key; the site shows Jobs by itself |

The modules that run in a TEE are built by their `build.sh` (`services/judge`, `services/brain`, `services/judge-tests`,
`services/judge-review`), which gives the same bytes in any folder on any machine. The mainnet builds of the brain and
of the jobs judges (`build.sh --mainnet`) also serve the mainnet accounts above, so they are made only once
`maskwars.near` is registered: a name nobody holds yet is one anybody could take.

## Code that names its source (NEP-330)

Every contract answers `contract_source_metadata` with its version, a link to its source at the commit of the public
repository it was built from, and how to build the same bytes again (`contracts/README.md`, "Source on chain"). What
goes to mainnet is only that build, made in a clone of the public repository at a commit pushed there:

```bash
contracts/build-source.sh                      # out/source/<name>.wasm, each checked
node scripts/mainnet/source.mjs out/source     # checks them again, places them, prints the owner's steps
```

`source.mjs` puts the vault and home in `apps/web/public/contracts` under their sha256 (the house's day and
`home-deploy.mjs` read them there) and the rest in `.scratch\near-mainnet` under the names the scripts here read
(`maskwars_live_safe.wasm` for `bounty-change.ps1 -AllowSafe`, `maskwars_bounty.wasm` for `-Code`, ...), and writes the
house's terms with the vault's new code to `.scratch\near-mainnet\house-terms.json`. It signs nothing.

### The vault 1.6.0, step by step

The vault's code is pinned in three places that move together, or the day stops and says why: the bounty contract's
`safe_codes`, `safe_code` of `mainnet.json`, and, once the house runs its contract, the house's own terms. No step lands
in the round's window, 18:00 to 21:30 UTC, and a change waiting on the bounty contract at 18:04 holds the day's round.

| # | Who | What | When |
| --- | --- | --- | --- |
| 1 | `maskwars.near` | `bounty-change.ps1 -Network mainnet -AllowSafe`, an hour later `-Apply`, then `-Show` lists the new code | after 21:30 UTC, applied before 17:30 UTC |
| 2 | the repository | `node --use-env-proxy scripts/mainnet/source.mjs out/source --switch safe` (refuses until step 1 is on chain): `safe_code` and `round.stake`; merge, export the public copy | before 18:00 UTC |
| 3 | `house.maskwars.near` | only if it runs the house contract: `configure` with `house-terms.json` and 1 yoctoNEAR (the command `source.mjs` prints) | with step 2 |
| 4 | — | the next day the house retires yesterday's vault and makes it again with 1.6.0; `contract_source_metadata` of `vault.house.maskwars.near` names the commit | 18:04 UTC |

The old code stays on the bounty contract's list: a round already open on it is untouched.

## The forge: people's masks on mainnet

`node scripts/mainnet/forge.mjs` checks the two wasm files against the bytes this commit pins
([`forge-wasm.json`](forge-wasm.json)), reads mainnet and prints the exact NEAR and every command in order. It signs
nothing. What the commands send is in this folder: [`brain-project-args.json`](brain-project-args.json), the mind's
project on OutLayer, and [`forge-init-args.json`](forge-init-args.json), the factory's `new`: admin, keeper and treasury
`maskwars.near`, the arena `bounty.maskwars.near`, the teams `maskwars.near` and `house.maskwars.near` (so the keeper
arms a person's mask for the house's daily round), the catalog and the mask code's sha256. With
`--strategy-key x25519:<hex>`, the key the mind's TEE gives, the factory is born with it.

| NEAR | What |
| --- | --- |
| 3.55795 | the factory's storage, locked for good: 100 bytes of account, 355 216 of code (copying and view keys included), 479 of state after `new` (measured on chain with these very arguments) |
| 6.0229 | publishing the mask code once as a global contract: 60 229 bytes at 0.0001 NEAR, burnt |
| 0.02915 | left free on the factory, its margin for its own state (a change the admin proposes) |
| **9.61** | **what `masks.maskwars.near` gets** (`fund.factory`) |
| 0.0455 | gas paid up front at most for the four transactions; the unburnt part comes back |
| 0.0016 | the keeper's key on `maskwars.near`: 160 bytes, four method names |
| 0.02 | the mind's project on OutLayer (`create_project`) |
| 0.1 | kept on `maskwars.near` for the keeper's gas around each round |
| **9.7771** | **in all, from `maskwars.near`** |

Beside the NEAR, the payment key for the minds' runs on OutLayer is paid in USDC: about $3 (step 2). First
`maskwars.near` registers on the token (`storage_deposit`, 0.00125 NEAR), then gets the USDC there, for example any
coin to USDC on NEAR at [maskwars.xyz/swap](https://maskwars.xyz/swap).

| # | Step | Signs |
| --- | --- | --- |
| 1 | The mind's project `maskwars.near/brain` on `outlayer.near`, the mainnet build of the source on `main`, `3e1b05b6…1434` (plays a copy with its author's sealed strategy, and the factory's masks for its keeper) | owner, near-cli |
| 2 | Its secrets (`PROTECTED_BRAIN_SEED` made inside the TEE, `NEAR_AI_API_KEY`), readable only by runs `maskwars.near` signs (`--access whitelist:maskwars.near`), one run `{"action":"key"}`, a payment key with $3 of USDC (`outlayer keys create`, then `outlayer keys topup <the key's number> --usd 3`). `outlayer login` keeps the full key of `maskwars.near` in plain text in `%USERPROFILE%\.outlayer\mainnet\credentials.json`: delete that file after the last `outlayer` command | owner, OutLayer CLI |
| 3 | The factory: create, fund, deploy, `new`, one transaction that adds no key | owner, near-cli |
| 4 | The keeper's seed (`KEEPER_SEED` of `live-race-mainnet`) and its key on `maskwars.near`: `arm`, `settle`, `note`, `share` on the factory only, the same key `keeper-key.ps1 -Network mainnet` adds | owner |
| 5 | The mask code, published once: the forge opens, and `maskwars.xyz/forge` with it | owner, near-cli |

The site needs no change for it: `/forge` and the menu's Forge ask the factory whether its mask code is published and
open by themselves (`apps/web/lib/forge.ts`).

## Guests in the daily round

Beside the arena's own masks the house lets into its daily round (`guests` in `mainnet.json`):

- **People's masks**, up to 3: every mask the factory lists that can race now (forged, not paused, not in a race, fuel
  for one whole race of its mind: its `race_limit`, at least 0.01 NEAR), fewest races first, then the oldest. The
  keeper arms each one in `Live race` (job `arm`): the factory checks with the bounty contract that one of its teams,
  here `house.maskwars.near`, opened the round and lists the mask. The mind thinks in its TEE on OutLayer; `settle`
  charges its tank what the tokens really cost.
- **Agents from outside: none on mainnet for now** (`guests.agents: 0`). They come back with an entry stake of their
  own; until then `/api/round/join` answers 403 with the reason and MCP offers no joining on mainnet. On testnet up to 2
  agents play: any account that signed up for the slot over MCP (`how_to_join_round`, then `join.mjs` signs one
  NEP-413 message with a full-access key of the account). The house checks every sign-up again against the chain and
  draws the seats among those that pass by the hash of the latest final block, named in the run's log.

Each guest adds 0.051 NEAR to the round's deposit, so the bounty stays what it is: 0.04 for the storage the bounty
contract keeps for one more mask (it comes back with the reserve at the payout), 0.01 for the judge's fee of the
guest's first claim, which the bounty pays, and the bytes of its account id in the round. Guests take only what the
house holds beyond the round itself (1.93 + 0.25 + 0.1 for gas): when it is short, the last of the list waits for
another day first, and a day is never skipped for a guest. `home` runs only on the arena's own masks: a guest keeps
what it wins. A factory or a site that does not answer lets nobody of its kind in, and the round opens all the same.

The payment key that pays the minds' runs on OutLayer is never refilled by anything but the owner. It holds dollars of
USDC, never NEAR: OutLayer's estimate for one run is 0.019 NEAR at most and a race asks a mind 5 times at most, so,
counted at NEAR's price, $3 runs at least four guests' races while NEAR costs less than $7.8. After each round
`Live race` writes what is left on it to its summary (`people's minds:`), with **Low**, a warning and the step when
less than a quarter of its first top-up is left. `maskwars.near` holds the USDC first (any coin to USDC on NEAR at
[maskwars.xyz/swap](https://maskwars.xyz/swap)), then `outlayer login` as `maskwars.near` and

```
outlayer keys topup <the key's number> --usd 3
```

`outlayer keys balance <the key's number>` shows the dollars. Then delete
`%USERPROFILE%\.outlayer\mainnet\credentials.json`.

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
| 3a | `home` on each mask, so its winnings go home every day with nobody signing | after `node scripts/mainnet/source.mjs out/source --switch home` names the reproducible build in `mainnet.json`, `node scripts/mainnet/home-deploy.mjs` prints three `near contract deploy` commands, one per mask, each signed by that mask's key from the keychain; it checks the file against `home_code` first. Each locks about 0.02 NEAR of the mask's own balance for the code (home 1.1.0, 1 925 bytes). Check: `near account view-account-summary nova.maskwars.near network-config mainnet now` shows as the contract's SHA-256 the one `home-deploy.mjs` prints, and `house.ps1 -Network mainnet -Show` names no mask whose winnings stay with it | 1 per mask |
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

## The jobs market

`node --use-env-proxy scripts/mainnet/jobs.mjs` signs nothing. It reads the chain, puts the code of both contracts in
`.scratch\near-mainnet` and prints every step with its NEAR. The code is read from `jobs.tinygif8324.testnet` and
`crews.tinygif8324.testnet` and kept only if its sha256 is what `contracts/jobs/build.sh` gives. So mainnet runs byte for
byte the contracts that paid a crew of masks on testnet ([contracts/jobs/README.md](../../contracts/jobs/README.md)).

| What | NEAR | Comes back |
| --- | --- | --- |
| `jobs.maskwars.near`: 568 619 bytes of code and its first state | 5.8 | stays as the contract's storage |
| `crews.maskwars.near`: 275 896 bytes of code and its first state | 2.85 | stays as the contract's storage |
| The masks' storage, sent before their keys go on: NOVA 0.004, ONYX 0.004, ORACLE 0.012. Two keys take 354 bytes (0.00354 NEAR) on each mask, and NOVA and ONYX hold their 0.4 NEAR and no more; ORACLE also pays the crew's record, 0.00781 | 0.02 | stays as the masks' storage |
| A first job of 1 NEAR on the house's round: reward 1, fuel 0.03, judge runs 0.08, the masks' storage 0.24, its record 0.044 | 1.394 | 0.385 to the client (0.037 at once, 0.348 at the payout); the reward goes to the masks that win it, less the 5% fee, which goes to `maskwars.near` |
| Three bonds of 0.01 NEAR and their records | 0.042 | 0.03 at the payout; the records' storage goes to the client |
| Gas: 2 deployments, 3 sends to the masks, the job, 3 bonds | at most 0.05 | — |
| **In all, from `maskwars.near`** | **10.156** | **0.414** |

The deployment alone is 8.65 NEAR. What comes back is what came back on testnet with the same code (job
`crew-drain-0001`). `maskwars.near` signs everything above and needs the sum on it first: with 0.139 NEAR on it now,
the top-up is 10.118 NEAR, and the script says it again from the chain. The crew is not in the sum: its captain ORACLE
signs `form` and attaches 0.05 NEAR of its own, and all but the crew's record (0.00781) comes back to it at once.

- **The fuel goes to `maskwars.near`.** It is the jobs contract's meter and treasury: the fuel of a counted step is paid
  to it, and it pays the masks' inference on NEAR AI Cloud.
- **No mask factory on the two contracts yet.** They went on chain before the forge, so both started with no factory.
  `masks.maskwars.near` is on chain since 12 Nov 2026 (`sections.forge: true`), and the `config` view of
  `jobs.maskwars.near` and of `crews.maskwars.near` still answers `"factories":[]`: no job can be open to forged masks
  until the admin proposes `{"kind":"factories"}` on both, which applies after an hour.
- **New code waits an hour while no job is live.** With a job live, new code for the jobs contract waits a week and no
  job opens meanwhile; with none live, it applies an hour after `maskwars.near` proposes it. Until the first job opens,
  the contract is only as safe as that key.
- **No judge for `tee_tests` and `ai_review`** (`jobs-args.json`): those kinds open only once their mainnet builds are
  published and recorded, as on testnet (`node scripts/testnet/jobs-judges.mjs`).
- **The first job is started by hand.** `--job` prints the job on the house's round of the day, while its commit
  window is open (18:04 to 18:49 UTC), and its bonds. Its work window is at most 40 minutes, and a scheduled run of
  GitHub often starts later than that: right after the bonds, start the `Jobs` workflow by hand
  (`gh workflow run jobs.yml --repo plavutskyi/mask-wars -f race=false`) and approve it in `live-race-hand`.

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
