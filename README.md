<p align="center"><a href="https://maskwars.xyz"><img src="brand/art/web/site-home.jpg" alt="maskwars.xyz after round 3 on NEAR mainnet: the mask ORACLE broke the vault in 0:14 and took 0.351 NEAR; below it, the free pick for the next round" width="100%"></a></p>

<h1 align="center">MASK WARS</h1>

<h3 align="center">AI masks break a vault of real NEAR, live on NEAR mainnet.<br>The contract pays the winner.</h3>

<p align="center">
  <a href="https://github.com/plavutskyi/mask-wars/actions/workflows/ci.yml"><img src="https://github.com/plavutskyi/mask-wars/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  &nbsp;·&nbsp;
  <a href="https://maskwars.xyz"><b>maskwars.xyz</b></a>
  &nbsp;·&nbsp;
  <a href="JUDGE-PATH.md">Judge path</a>
  &nbsp;·&nbsp;
  <a href="RULES.md">Rules</a>
</p>

**The problem.** AI agents are starting to hold money and pay contracts on their own. Nothing tells an agent which
contract will take its money and never give it back, and nobody is paid to find that out before the money is gone.

**What MASK WARS does.** It turns breaking a contract into a daily contest for real NEAR, and every break into a
signal other agents read before they pay.

Every day at 18:04 UTC a house account on NEAR mainnet puts real NEAR in a fresh vault with a planted hole and opens
a sealed round on it. Three AI masks, each its own NEAR account thinking on a NEAR AI Cloud model inside a TEE, attack
a private copy of the vault in a sandbox, and a mask a person forged takes a seat beside them: this part runs off
chain, in a public CI run linked from every round in
[Rounds on mainnet](#rounds-on-mainnet). The first mask to break the copy puts the hash of its plan on the bounty
contract. When the window closes it plays that exact plan on the real vault with its own function-call key and takes
what it drained; a judge in a TEE confirms the break from the chain, and a bounty contract that nobody holds a key to
pays the winner on top. What a mask then holds above the 0.4 NEAR it keeps goes back to the house and funds the next
round. Every break becomes data: before an agent pays an account, MASK CHECK answers `block` if a mask has broken it.

**For a person, on [maskwars.xyz](https://maskwars.xyz):** call the round before it opens, free and with no wallet (which mask
breaks the vault, or does it hold), and climb the callers' board in the league; forge your own mask and fuel its mind;
post a paid job for a crew of masks; get NEAR from 20 networks in one step.

**Live so far, as of 13 Nov.** Four rounds, four breaks. ORACLE took the first three, 1.45538 NEAR in all. On 13 Nov
NOVA sealed first, broke the vault 9 s after the window closed and took 0.22246 NEAR. The same evening the first job
posted from a person's wallet went from posting to payout in 1 h 14 min with no manual step: a crew of the three
masks took it and the contract paid each 0.158333 NEAR. What that does and does not show is in
[Honest limits](#honest-limits).

<p align="center">
  <a href="https://maskwars.xyz/race/race-0003"><img src="brand/art/web/site-race.jpg" alt="The page of round 3: ORACLE broke the vault, 0.351 NEAR in 0:14, and the round step by step from the chain" width="49%"></a>
  <a href="https://maskwars.xyz/forge"><img src="brand/art/web/site-forge.jpg" alt="The forge: make your own mask, the first of six steps" width="49%"></a>
</p>
<p align="center">
  <a href="https://maskwars.xyz/near"><img src="brand/art/web/site-get-near.jpg" alt="Get NEAR: 25 dollars of USDC on Arbitrum become 7.33 NEAR in your own account" width="49%"></a>
  <a href="https://maskwars.xyz/league"><img src="brand/art/web/site-league.jpg" alt="The league: three masks, three rounds, ORACLE first with 1.455 NEAR taken" width="49%"></a>
</p>

<p align="center"><a href="packages/media/shots/race-0001/break/break.mp4"><b>Watch the break of round 1</b></a> (15 s)</p>

## Live on mainnet

Only what runs on NEAR mainnet or on maskwars.xyz, which reads mainnet, today.

| What | On chain | Code |
| --- | --- | --- |
| **The daily round.** At 18:04 UTC the house makes a fresh vault with 1.93 NEAR and no key on it, and opens a sealed round on the bounty contract for the arena's masks and the forged masks that are ready | `house.maskwars.near`, the vault `vault.house.maskwars.near` ([race-0004 opened](https://nearblocks.io/txns/AZYQFW3RxjboGLD9eDd9KKcQfakFQztGjthAjsTUf9VJ)) | `packages/race/src/house.ts`, `packages/race/src/house-guests.ts`, `.github/workflows/season.yml`, `contracts/challenges/live-safe` |
| **Bounty contract with no key.** Holds the bounty and the seals, pays the earliest confirmed seal itself. Its admin can propose a change, which waits in the open before it applies; the one thing it can do at once is take a vault code off the list, which stops new rounds on that code and touches no open round | `bounty.maskwars.near`, 0 keys | `contracts/bounty` |
| **Judge in a TEE.** OutLayer runs the judge's wasm, pinned by its sha256 `1f8e1aca…`; it reads the drain from three RPC sources that must agree. Claim, verdict and payout are one transaction | `outlayer.near`, 5.6 s on race-0001, 4.8 s on race-0002, 5.6 s on race-0003, 5.6 s on race-0004 | `services/judge` |
| **The masks.** NOVA, ONYX and ORACLE: each its own account, with function-call keys for the vault, the bounty contract, jobs and crews. Their contract, `home`, sends what a mask holds above 0.4 NEAR and its storage back to the house | `nova.maskwars.near`, `onyx.maskwars.near`, `oracle.maskwars.near` | `packages/race/src/live.ts`, `contracts/home` |
| **Minds in a TEE.** ONYX thinks with GLM 5.3 Flash, NOVA with DeepSeek V4.1 Flash, ORACLE with Qwen 3.8 27B Abliterated, all NEAR AI Cloud Private TEE models, attested with a fresh nonce | [/api/verified](https://maskwars.xyz/api/verified): `"outcome":"pass"` | `packages/mind/src/attestation.ts`, `packages/race/src/minds.ts` |
| **MASK CHECK.** `allow`, `warn` or `block` before an agent pays, with reasons read from the chain and from the arena's breaks. Since 13 Nov the answer is read and signed inside a TEE on OutLayer; if OutLayer does not answer, the site reads the chain itself and says `"signed":false` | [/api/check](https://maskwars.xyz/api/check?account=safe-0001.maskwars.near): `"verdict":"block"` and `"tee":{"signed":true`; the module is `maskwars.near/check` on `outlayer.near` | `packages/check`, `services/check`, `apps/web/app/api/check`, `apps/web/lib/check-tee.ts` |
| **MASK CHECK for hire.** Listed on NEAR AI Agent Market as the agent `maskwars`: 0.10 USDC a call over A2A, paid with x402. Listed 13 Nov; no paid hire as of 13 Nov | [the agent's card](https://maskwars.market.near.ai/.well-known/agent-card.json); [/api/market/hook](https://maskwars.xyz/api/market/hook): `"open":true` | `packages/market`, `apps/web/app/api/market/hook` |
| **MCP server, 20 read-only tools.** Races, masks, the league, the rules, MASK CHECK, the house's round, the jobs board | [/mcp](https://maskwars.xyz/mcp) | `apps/mcp` |
| **Jobs market and crews.** A client locks NEAR on a job, masks take it alone or as a crew, and the contract pays by the crew's split with a 5% fee. First job, 13 Nov: `race-0004-w7k5e4`, 0.5 NEAR from a person's wallet (the author's second wallet), taken by the crew `arena-trio` in 3 min 28 s; ORACLE, NOVA and ONYX got 0.158333 NEAR each, 1 h 14 min from posting to payout, with no manual step | `jobs.maskwars.near`, `crews.maskwars.near`, both 0 keys ([posted](https://nearblocks.io/txns/2vscdTWKdf94GMcJHt6GCKPh222B2tRCPZLrJv2UHbrK) · [paid](https://nearblocks.io/txns/8mMiMgDRhJeYTwm9SgQgpABqVbToWm5a3oXXvvhYnjSE)); [/api/jobs](https://maskwars.xyz/api/jobs): `"phase":"paid"` | `contracts/jobs`, `contracts/crews`, `apps/web/app/jobs`, `.github/workflows/jobs.yml` |
| **Get NEAR.** Any coin from 20 networks to native NEAR on any NEAR account, through NEAR Intents 1Click, with the app's fee to `maskwars.near` in the quote. First swap, 12 Nov: 32 USDC on Arbitrum to 8.893919 NEAR, 40 s from quote to NEAR, fee 13 bps | [native_withdraw to maskwars.near](https://nearblocks.io/txns/526NjD9FC9Dt9XXjZ4RXYh5CJzdFFkpz5n9JRb9WRJHR) | `apps/web/app/near`, `packages/pay` |
| **Swap.** 62 mainstream coins on 21 networks, coin to coin, through 1Click, the same fee path, deposit addresses open. First swap, 12 Nov: 3 USDC on Arbitrum to 2.992147 USDC on NEAR ([NEAR Intents explorer](https://explorer.near-intents.org/transactions/0x848834Ba6789472589D9C3d58060152bEe6ECE78)) | [/swap](https://maskwars.xyz/swap) | `apps/web/app/swap`, `packages/pay` |
| **The Forge.** Anyone makes their own mask on the site: a face, a style, a Private TEE model and NEAR for its mind. The factory has no key, the mask's code is a global contract published once, and the mind's key came out of an OutLayer TEE (`x25519:0d4c67bf…a126c82c`), so nobody reads a strategy, the team included. Opened 12 Nov. On 13 Nov the keeper armed the first forged mask, DMYTRO (the team's own), for round 4 and the house seated it beside the arena's three: the first `arm` on mainnet. Its mind did not answer in that round ([Honest limits](#honest-limits)). Its author opened it for copying at a 20% share; no copy as of 13 Nov | `masks.maskwars.near`, 0 keys ([created](https://nearblocks.io/txns/ERCKD5caKsZdumuQoZ4Gdk6UfxHpqRsS15vAi3LJXURB) · [mask code published](https://nearblocks.io/txns/AyatyS7ABSKTrVpKgqHsFQFukBpXtjhWpE3x9Zc5qJdf) · [DMYTRO armed](https://nearblocks.io/txns/25WvBVuM1efHRf3WBEjmhcoQaDvyFhkMkiycy1XVgChA)); [/api/forge](https://maskwars.xyz/api/forge): `"open":true` | `contracts/masks`, `packages/forge`, `services/brain`, `packages/race/src/keeper.ts`, `apps/web/app/forge` |
| **Wallet.** A person's own balance in NEAR Intents, opened by a passkey or a NEAR wallet: top it up with a coin from another network and cash out to any network through 1Click, and with a NEAR wallet fuel a forged mask's mind from it. Only the person holds its key. Deposits opened 13 Nov | [/wallet](https://maskwars.xyz/wallet); [/api/pay/live](https://maskwars.xyz/api/pay/live): `"deposits":true,"fuel":true` | `packages/pay`, `apps/web/app/wallet` |
| **Contract pages.** For every contract the arena raced on: its standing and every race's outcome with its proof, read from the chain | [/api/contract/vault.house.maskwars.near](https://maskwars.xyz/api/contract/vault.house.maskwars.near): `"standing":"broken"` (`"under_fire"` while the day's round is open and no mask is through yet, from about 18:05 UTC to the break, 18:50 on 12 and on 13 Nov) | `packages/dossier`, `apps/web/app/contract` |
| **The site.** The countdown, the race pages, the 3D arena, the league and the masks, all read from mainnet | [maskwars.xyz](https://maskwars.xyz) | `apps/web`, `packages/arena` |

### Rounds on mainnet

Amounts in NEAR. The winner's time counts from the moment the commit window closed.

| Round | Day | Opened by, on | Winner | Drained | Paid by the contract | Transactions |
| --- | --- | --- | --- | --- | --- | --- |
| [race-0001](https://maskwars.xyz/race/race-0001) | 10 Nov | `maskwars.near` by hand, on `safe-0001.maskwars.near` | ORACLE in 0:15 | 0.54 | 0.21186 | [open](https://nearblocks.io/txns/3KutM1kRv5ukkEoTZczZbZjfEJjEvjpmVodEj4iRbyhC) · [drain](https://nearblocks.io/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM) · [paid](https://nearblocks.io/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM) · [the race in CI](https://github.com/plavutskyi/mask-wars/actions/runs/42842359569) |
| [race-0002](https://maskwars.xyz/race/race-0002) | 11 Nov | `house.maskwars.near`, on `vault.house.maskwars.near` | ORACLE in 0:15 | 0.24 | 0.11176 | [open](https://nearblocks.io/txns/BtAiy98VEUdc9zWBMCnZBhvRJ2xfisijfCNBjXTqNJU8) · [drain](https://nearblocks.io/txns/Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc) · [paid](https://nearblocks.io/txns/BdUN85L7g32uCPx7a8PDqJn5cAZgyzvUv3dFYf3v864y) · [the race in CI](https://github.com/plavutskyi/mask-wars/actions/runs/43081259474) |
| [race-0003](https://maskwars.xyz/race/race-0003) | 12 Nov | `house.maskwars.near`, its day started by the site's cron (GitHub labels the run "Manually triggered": the cron starts it through `workflow_dispatch`), on `vault.house.maskwars.near` | ORACLE in 0:14 | 0.24 | 0.11176 | [open](https://nearblocks.io/txns/BqnPTYkcoBfmDLQc4Dtu7ZBAynL8PcqdNbuUrXSKbiib) · [drain](https://nearblocks.io/txns/3cDxNjTxszeQ2qBkHxesAgR3J6Ak5pNeTYfYYkPUj5Vy) · [paid](https://nearblocks.io/txns/AgFhn2YuHWjhC318MSwqG6QUcxmcWXA3Ey5Vnnjix9wJ) · [the race in CI](https://github.com/plavutskyi/mask-wars/actions/runs/43276033812) |
| [race-0004](https://maskwars.xyz/race/race-0004) | 13 Nov | `house.maskwars.near`, its day started by the site's cron, on `vault.house.maskwars.near`; four masks named, the forged mask DMYTRO among them | NOVA in 0:09 | 0.1 | 0.12246 | [open](https://nearblocks.io/txns/AZYQFW3RxjboGLD9eDd9KKcQfakFQztGjthAjsTUf9VJ) · [drain](https://nearblocks.io/txns/69KZoEDAmArzH8TA9AbhwbxTnNXDCpuFV24irFxE3E4L) · [paid](https://nearblocks.io/txns/J8sDDzvRVwan1TZRQf6cBhuXaP1F4Z7jaaSkHLkRkPPV) · [the race in CI](https://github.com/plavutskyi/mask-wars/actions/runs/43479031121) |

NOVA's sealed plan swept 0.1 NEAR, the least a break of round 4 had to take (`min_loot`), so it took 0.22246 NEAR in
all; ORACLE's plans swept more.

In each run's log the `race` job prints the board of the sandbox race: "Live safe · ONYX vs NOVA vs ORACLE · 5 attempts
each" (round 4 adds "vs DMYTRO"), then who broke the copy and on which attempt (GitHub shows a log to a signed-in
reader).

The same from the chain: `get` on `bounty.maskwars.near` with `{"id":"race-0002"}` answers `"state":"drained"` and the
winner ([JUDGE-PATH](JUDGE-PATH.md#60-seconds-nothing-to-install)).

## See it in two minutes

Nothing to install but `curl`. Every line only reads.

| Do | You see, and what it means |
| --- | --- |
| `curl -s https://maskwars.xyz/api/races/race-0002` | `"winner":{"account":"oracle.maskwars.near"`: ORACLE broke the house's vault on day 2 ([the round](https://maskwars.xyz/race/race-0002)) |
| the same | `"payout":{"amount":"111760000000000000000000"`: the bounty contract paid it 0.11176 NEAR (in yoctoNEAR) |
| `curl -s https://maskwars.xyz/api/races/race-0004` | `"winner":{"account":"nova.maskwars.near"`: NOVA broke the vault on day 4, the first winner other than ORACLE ([the round](https://maskwars.xyz/race/race-0004)) |
| the same | `"takes":"222460000000000000000000"`: 0.1 NEAR out of the vault plus 0.12246 NEAR from the bounty contract, 0.22246 NEAR |
| `curl -s https://maskwars.xyz/api/check -G -d account=safe-0001.maskwars.near` | `"verdict":"block"`: MASK CHECK stops a payment to the safe ORACLE broke on day 1 |
| `curl -s https://maskwars.xyz/mcp` | `"tools":["get_live_race"`: 20 read-only tools for any agent, and the one line that connects Claude Code or Codex |
| `curl -s https://maskwars.xyz/api/jobs` | `"contract":"jobs.maskwars.near","deployed":true`: the jobs market is on mainnet ([the board](https://maskwars.xyz/jobs)) |
| the same | `"phase":"paid"`: the first job, 0.5 NEAR posted from a person's wallet on 13 Nov, taken by a crew of three masks and paid by the contract |
| `curl -s https://1click.chaindefuser.com/v0/status -G -d depositAddress=0x9291F7f918FAEA302f0D89cB08De4aBf387322f3` | `"recipient":"maskwars.near","fee":13`: NEAR Intents' record of the first swap through [Get NEAR](https://maskwars.xyz/near), with this app's fee |
| the same | `"amountOutFormatted":"8.893919362827321244422"`: 32 USDC on Arbitrum became 8.893919 NEAR |

Nobody holds a key to the bounty contract: `view_access_key_list` on `bounty.maskwars.near` answers `"keys":[]`.
[JUDGE-PATH.md](JUDGE-PATH.md) has that read and every command here with its full answer, the transaction logs and the
code to read.

## Tracks

The rules let a project name every track it fits. One line each: what answers it, and one thing to check.

| Track | What answers it | Check it |
| --- | --- | --- |
| `swarms` AI Swarms | Masks on their own sub-accounts, coordinated by a contract in sealed rounds (seal a hash, play after the window, reveal); on mainnet, the jobs and crews contracts where masks take work as a crew with roles and a fixed split: on 13 Nov the crew `arena-trio` took a paid job, each mask signed its own step, and the contract split 0.475 NEAR three ways | `list_crews` on `crews.maskwars.near` answers the crew `arena-trio` with `"ready":true` and its first job ([JUDGE-PATH](JUDGE-PATH.md#60-seconds-nothing-to-install)) |
| `agents` Agent Economy | Agents with their own NEAR accounts earn from contracts with no hand in the payout: as of 13 Nov ORACLE has taken 1.45538 NEAR and NOVA 0.22246 NEAR in the four rounds above, and the three masks 0.475 NEAR more for the first paid job. Any agent reads the arena and asks MASK CHECK over MCP, or hires it on NEAR AI Agent Market for 0.10 USDC a call (no paid hire as of 13 Nov) | [/api/races/league](https://maskwars.xyz/api/races/league): `"earned":"1455380000000000000000000"` and `"earned":"222460000000000000000000"` as of 13 Nov, more with every round a mask wins; one round, fixed: [/api/races/race-0004](https://maskwars.xyz/api/races/race-0004) says `"takes":"222460000000000000000000"` |
| `security` AI Security & Defense | MASK CHECK stops a payment to an account a mask broke, and its answer is signed inside a TEE; masks sign only with function-call keys scoped to one contract; the bounty, jobs, crews and masks contracts have no key at all | [/api/check](https://maskwars.xyz/api/check?account=safe-0001.maskwars.near): `"verdict":"block"` |
| `defi` Unstoppable DeFi | Get NEAR and Swap: cross-chain swaps that settle through NEAR Intents 1Click with the app's fee in the quote; a person's own balance in NEAR Intents, topped up from other networks, with a key only the person holds; the site never holds the coins | 1Click's record of the first swap: `"recipient":"maskwars.near","fee":13` |
| `privacy` Privacy & Private AI | Minds only on NEAR AI Cloud Private TEE models: each model is attested with a fresh nonce as a race begins, and every answer's TEE signature is checked against the attested nodes (an answer that does not pass counts as not verified); the judge and MASK CHECK in OutLayer's TEE; a forged mask's strategy sealed for a key that came out of a TEE; plans sealed until the window closes | [/api/verified](https://maskwars.xyz/api/verified): `"outcome":"pass"` |
| `games` Games With Real Economies | AI masks with wallets fight every day for real NEAR, anyone can forge a mask of their own, a league ranks masks and models, and the masks' contract sends winnings back to the house that funds the next round (first on mainnet 12 Nov: [home](https://nearblocks.io/txns/14MzcJbMmib7H7fYDNYmYHGfNFpwXvXGS7oJ6pce2YS), [retire](https://nearblocks.io/txns/DkwjrCpu7BE3c5FhgR27Cwy7Pegm66xuNjAzmRuRHngy)) | [maskwars.xyz/league](https://maskwars.xyz/league) |
| `open` Open Innovation | AI agents earn NEAR by breaking contracts in a live race, and every break becomes data other agents read before they pay | [maskwars.xyz](https://maskwars.xyz) |

Not claimed: `thesis`, `business`, `realworld`, `nfts`, `memecoins`, `social`.

## Not live yet

<details>
<summary><b>Testnet, simulated or not open yet</b>: a person's mind answering in a round, a copy, outside agents, job judges, the season treasury, the house contract, Hire</summary>

**LIVE testnet**: deployed on NEAR testnet and run there with test NEAR · **SIMULATED**: code with tests in this
repository that runs in a local sandbox or on recorded answers, not deployed · **NOT BUILT**: not in this repository.

| What | Code | Status | Where it stands |
| --- | --- | --- | --- |
| A forged mask's mind answering from its TEE in a round | `services/brain`, `packages/race/src/brain.ts`, `packages/race/src/keeper.ts` | SIMULATED | on testnet the people's masks BLAZE and EMBER raced a house round on 11 Nov, armed and charged by the keeper, with their models asked from outside the mind's module; on mainnet the keeper armed DMYTRO for round 4 and settled it after, and each of its five asks ended before the model was asked, so nothing was charged. The fixed build of the mind, `5bb8bb26…0cb5`, is the active version on OutLayer since the evening of 13 Nov; no round has been played on it yet ([Honest limits](#honest-limits)) |
| Confidential copying of a sealed strategy, view keys | `contracts/masks/factory` | LIVE testnet | a copy won `copy-59801-01` and its author got 20%; on mainnet copying is open on DMYTRO at a 20% author's share and no copy has been forged: `get_mask` on `masks.maskwars.near` says `"copyable":true,"author_bps":2000,"copies":0` |
| Outside agents in the house round | `apps/web/app/api/round` | LIVE testnet | on mainnet [/api/round/guests](https://maskwars.xyz/api/round/guests) says `"agents":0` |
| Jobs paid by role: a scout, a striker and a verifier with their own shares | `contracts/jobs`, `contracts/crews`, `packages/race/src/work.ts` | LIVE testnet | three paid jobs: one taken by masks alone on 10 Nov, two by crews with roles on 11 Nov ([contracts/jobs](contracts/jobs/README.md#live-on-testnet-a-crew-of-masks-paid-by-role)); the one job paid on mainnet had a crew of three strikers and an even split |
| Season treasury with no key | `contracts/season` | LIVE testnet | opened two rounds, neither won |
| House contract: the day's steps for a function-call key | `contracts/house` | SIMULATED | runs on a local node in tests; the house signs with a full key today |
| The vault 1.7.0: `about`, its source on chain (NEP-330) and three kinds of vault, each with another planted hole and another plan | `contracts/challenges/live-safe`, `contracts/build-source.sh`, `contracts/challenges/runner/tests/variants.rs` | SIMULATED | built reproducibly; each kind broken, judged and paid on a local node with the real bounty contract and judge; rounds 2 to 4 on mainnet ran 1.5.0 (`GBcgJ4RA…`). Version 1.6.0 (`7aPN6FvA…`, adds `about` and its source on chain) is on the bounty contract's list of allowed vault codes since 13 Nov; as of 13 Nov no round has run on it |
| Job judges in a TEE: a client's private tests, an AI review | `services/judge-tests`, `services/judge-review` | SIMULATED | built and served by their sha256 ([judge-tests](https://maskwars.xyz/outlayer/maskwars-judge-tests-fa96e527b73de238a0aa94a43f8ad2d4fdd63e4bc67cda34684dd399cdbeed0e.wasm), [judge-review](https://maskwars.xyz/outlayer/maskwars-judge-review-c28711aa0c01ca4bfbb7331163bf1b3c407cd71ecf1e3b8ece721feac0652a07.wasm)), the jobs contract has `"judges":[]` |
| Contract pages written by a model in a TEE | `packages/dossier/src/write.ts` | SIMULATED | two pages written on NEAR AI Cloud are in `packages/dossier/test/fixtures/written`; the site shows the facts, and the API answers `"page":{"status":"off","text":null,"written":null}` |
| Hire the swarm, a button other apps embed | `packages/hire`, `apps/web/app/hire` | SIMULATED | page up, deposits closed |
| Vault for winning breaks on OutLayer | `services/vault` | SIMULATED | not called yet |
| A round with scripted masks, ten more targets | `contracts/challenges/runner`, `contracts/challenges` | SIMULATED | `pnpm demo` below |

</details>

## Run it on your machine

No keys, no wallet. Linux (x86_64 or arm64) or macOS on Apple silicon; on Windows use WSL (the NEAR sandbox the round runs in is built for these three only). Node 22.21 or newer, pnpm (`corepack enable`) and Rust through [rustup](https://rustup.rs): the
repository pins 1.97.0. The first run builds the Rust sandbox runner, about 7 minutes on 4 cores.

```bash
git clone https://github.com/plavutskyi/mask-wars
cd mask-wars
pnpm install --frozen-lockfile
pnpm demo
```

| Do | You see, verbatim |
| --- | --- |
| `pnpm demo` | `NOVA wins the round` |
| `pnpm demo:round` | `VOLT seals × the commit window is closed` |
| the same | `ORACLE set_owner × only a mask that sealed a plan moves the safe` |
| the same | `NOVA claims ✓ the judge confirmed the drain` |
| `pnpm demo:check` | `→ BLOCK. The payment is stopped. Nothing was signed.` |
| the same | `Mainnet live: treasury.intents.near BLOCK (no such account)` |
| `pnpm demo:contracts` | `a_peeked_plan_does_not_match_an_earlier_seal - should panic ... ok` |
| the same | `every_source_must_agree ... ok` |

<details>
<summary>What <code>pnpm demo:round</code> plays</summary>

Five scripted masks and no models. The bounty contract, the live safe and the judge are the real code; only OutLayer
is a local stand-in. Seal hashes change on every run.

```text
TEAM    opens      ✓ 1.000 NEAR on safe.test.near for 5 masks
ONYX    seals      ✓ seal #0 286952a70755
JINX    seals      ✓ seal #1 26a8065978ee
JINX    set_owner  × the safe is locked until the commit window closes
JINX    sweep      × the safe is locked until the commit window closes
NOVA    seals      ✓ seal #2 fe8f5715dd40
—— the commit window closes ——
VOLT    seals      × the commit window is closed
NOVA    set_owner  × an earlier seal goes first
NOVA    set_owner  ✓
NOVA    sweep      ✓
ONYX    set_owner  × another mask has its turn on the safe
ONYX    set_owner  ✓
ONYX    sweep      ✓
ORACLE  set_owner  × only a mask that sealed a plan moves the safe
ORACLE  sweep      × only a mask that sealed a plan moves the safe
ONYX    reveals    × the plan does not match the seal
ONYX    reveals    ✓ 1 call
JINX    reveals    ✓ 2 calls
NOVA    reveals    ✓ 2 calls
ORACLE  reveals    × this mask sealed no plan
JINX    asks       ✓ the claim is with the judge, request 0
ONYX    asks       ✓ the claim is with the judge, request 1
ONYX    claims     × the judge refused: sandbox: the plan did not start the mask's own turn on the safe
NOVA    asks       ✓ the claim is with the judge, request 2
NOVA    claims     ✓ the judge confirmed the drain
ORACLE  claims     × no drain to claim
JINX    claims     × the judge refused: sandbox: the drain happened outside the race
NOVA    PAID       ✓ 0.761 NEAR for seal #2

NOVA wins the round
```

NOVA found the hole and sealed its plan. JINX tried to empty the safe inside the commit window, but the safe stays
locked until it closes, and its junk claim waits with the judge while the others claim. ONYX sealed a guess, then
borrowed NOVA's move after NOVA's turn. ORACLE copied NOVA off the chain with no seal, and the safe does not let it in.
VOLT found the hole after the window. Only NOVA's sealed plan, played on its own turn, is paid. `pnpm demo:check` is
MASK CHECK stopping a prompt-injected payment agent on testnet and on mainnet; it holds no key. If a step stops,
[JUDGE-PATH.md](JUDGE-PATH.md#if-a-step-stops) has the fixes.

</details>

## How a round works

1. **Open.** The house (or any team) calls `open_safe` on the bounty contract with the bounty attached and names the
   vault, the masks, the commit window and the deadline. The contract locks the vault to the round.
2. **Seal.** A mask that finds the break calls `commit` with the sha256 of its plan, a salt and its own account.
3. **Play.** After the window closes, the mask sends the vault exactly the calls it sealed, signed with its own key.
4. **Reveal and claim.** `reveal` shows the plan and the contract checks it against the seal; `claim_drain` asks the
   judge.
5. **Paid.** The judge on OutLayer reads the plan's transactions from RPC sources that must agree and confirms that it
   broke the untouched vault. The contract pays the earliest confirmed seal; with no winner, the bounty goes back.

The vault's `set_owner` and `sweep` are open to the round's masks on purpose, so a scanner that reads its code calls it
critical: it is the arena's target. On chain it names its team (`house.maskwars.near`) and its arbiter
(`bounty.maskwars.near`), and only the round's masks get through, in the order of their seals. Every rule and edge
case: [RULES.md](RULES.md). The contract: [contracts/bounty](contracts/bounty/README.md).

<details>
<summary><b>What NEAR does here</b>: named sub-accounts, function-call keys, accounts with no key, yield and resume, NEAR AI Cloud, NEAR Intents, global contracts</summary>

- **Named sub-accounts.** Every mask is its own account, like `oracle.maskwars.near`, so every move on chain traces
  back to one agent. `packages/race/src/live.ts`
- **Function-call access keys.** A mask races with keys tied to one contract and a list of methods each. By protocol
  rule such a key cannot move NEAR, attach a deposit, add a key or call another contract. `packages/race/src/keys.ts`
- **Accounts with no access key.** `bounty.maskwars.near`, `jobs.maskwars.near`, `crews.maskwars.near` and every vault
  were made and deployed with no key added, so nobody can redeploy them or move their NEAR by hand.
  `contracts/bounty/src/admin.rs`
- **Yield and resume, with OutLayer.** `claim_drain` asks `outlayer.near` to run the judge. The call stays a yielded
  promise while OutLayer runs the pinned wasm in a TEE; the callback pays. `contracts/bounty/src/lib.rs`
- **NEAR AI Cloud.** The masks think only on Private TEE models; each race attests them with a fresh nonce and checks
  every answer's TEE signature, and prices each answer from NEAR AI's bill. `packages/mind`, `packages/race/src/minds.ts`
- **NEAR Intents, 1Click.** Get NEAR and Swap quote and settle cross-chain swaps through 1Click, with `appFees` paying
  `maskwars.near`; what arrives is native NEAR from `intents.near`. `packages/pay`, `apps/web/app/near`
- **Global contracts.** The season safe's code is published once by its hash and every season safe points at it.
  `contracts/season/src/lib.rs`
- **NEP-330.** Every contract can name its own source and reproducible build on chain. `contracts/README.md`

</details>

## Honest limits

- **Four rounds as of 13 Nov, small sums.** See [Rounds on mainnet](#rounds-on-mainnet). Each time one mask broke the
  vault and took between 0.22 and 0.75 NEAR.
- **One target, two winners so far.** The vault runs the same code with the same planted hole every day, and the break
  is two calls (`set_owner`, then `sweep`). ORACLE broke the copy first in rounds 1 to 3, on its first attempt. In
  round 4 NOVA broke it on its second attempt and sealed first, but that round was no clean duel: NOVA's model was the
  only one that answered. ORACLE's three calls and ONYX's two calls to NEAR AI Cloud came back with no answer (the
  run's `minds` job prints it). ONYX has never broken the copy first, so it has never sealed or played on a vault;
  what it has signed in the arena on mainnet is its seat in the crew and its step and reveal in the job of 13 Nov.
  Ten other targets are in `contracts/challenges` and run in the local demo; none of them is a house vault on mainnet
  yet. The vault's own code in this repository, 1.7.0, holds two more kinds of vault, each with another planted hole
  and another plan (`limit`, three calls; `pause`, two other calls). Both are played to a paid break on a local node
  with the real bounty contract and judge (`contracts/challenges/runner/tests/variants.rs`); neither has run on
  mainnet yet, where rounds 2 to 4 ran one code, 1.5.0. Version 1.6.0 is on the bounty contract's list of allowed
  vault codes; as of 13 Nov no round has run on it.
- **The first person's mask did not think.** DMYTRO was armed and seated in round 4, and each of its five asks ended
  before its model was asked: the mind's module wrote its request in one piece, and the host takes 4096 bytes a
  write. The source is fixed (`services/brain/src/http.rs` sends the body in pieces) and the new build,
  `5bb8bb26…0cb5`, is the project's active version on OutLayer since the evening of 13 Nov ([tx](https://nearblocks.io/txns/E8Sxes5h7hqZnYA4ypRnADv7dnr3jWbhLGVVHwyxvHRz); `get_project`
  on `outlayer.near` for `maskwars.near/brain` says `"active_version":"5bb8bb26…0cb5"`). No person's mind has
  answered from its TEE in a round yet, on mainnet or on testnet, where the people's masks' models were asked from
  outside the module. The mask was charged nothing (`"spent":"0"`).
- **The first customers are the team.** DMYTRO belongs to `maskwars.near`, the team's account, and it is the only
  mask forged on mainnet. The client of the first job is the author's second wallet, not an outside customer. That
  job was a `drain` job: the crew is paid when the round it follows pays one of the crew's masks, so the three masks
  shared 0.475 NEAR for a break NOVA made. Of the 1.14 NEAR the client locked, 0.63388 NEAR came back.
- **Listed, not hired; open, not copied.** As of 13 Nov MASK CHECK is on NEAR AI Agent Market and has had no paid
  hire, and copying is open on DMYTRO and no copy has been forged. No outside agent has entered a round, and Hire
  takes no deposits.
- **The money is the house's own.** The bounty and the vault are funded by `house.maskwars.near`, the masks are the
  arena's, and winnings above 0.4 NEAR go back to the house. No outside team has put up a bounty.
- **The holes are planted.** These are training targets; no third party's contract has been attacked.
- **The race is not in a TEE.** It runs on GitHub Actions; the models and the judge run in TEEs. This repository pins
  the judge's wasm by hash and reads OutLayer's answer on chain; it does not verify OutLayer's own attestation.
- **The team still holds keys.** The house has two full-access keys: the author's, and the one the daily workflow
  signs with. Each mask has a full-access key beside its function-call keys; the race signs with the function-call
  keys only. `maskwars.near` is the admin of the bounty, jobs and crews contracts: it can propose a change, which waits
  in the open before it applies, and on the bounty contract it can take a vault code off the list at once (new rounds
  on that code stop; open rounds go on). It is also the keeper of people's masks: a function-call key of its own
  (`arm`, `settle`, `note`, `share` only) arms a forged mask for a round and settles it after.
- **The daily round is new.** Day 2 was started by hand when GitHub's schedule did not fire; since then a Vercel cron
  calls `/api/season/tick` at 18:04 UTC and starts the day (`apps/web/vercel.json`, `apps/web/app/api/season/tick/route.ts`). GitHub
  labels such a run "Manually triggered" by the repository owner, because the cron starts the workflow through GitHub's
  API (`workflow_dispatch`) with that account's token; nobody is at the keyboard. Day 3, 12 Nov, started by itself at 18:04:34 UTC and
  opened its round at 18:05:31, and the vault's `retire` and the masks' `home` ran on mainnet for the first time as its first steps ([home](https://nearblocks.io/txns/14MzcJbMmib7H7fYDNYmYHGfNFpwXvXGS7oJ6pce2YS),
  [retire](https://nearblocks.io/txns/DkwjrCpu7BE3c5FhgR27Cwy7Pegm66xuNjAzmRuRHngy)). Day 4, 13 Nov, did the same: started at 18:04:34, opened its round at 18:05:12
  ([home](https://nearblocks.io/txns/7uSnNS1SyaCUib8Yjp312FJVZebMCgD4rzXe7CzXUhB7), [retire](https://nearblocks.io/txns/C7iVXHNzfRTmzv68VGPMMYjJ6siv8yrWJUEfbVDXU6ST)). Two days in a row is not a record yet.
- **One job on mainnet, of one kind.** A `drain` job carries no work of its own: each mask's step is a fixed line and
  the round it follows is the work. The crew jobs on testnet replayed a plan ORACLE's mind had already revealed; no
  model ran in them. Jobs with a TEE judge of their own (a client's private tests, an AI review) are not open on
  mainnet: the jobs contract says `"judges":[]`.
- **MASK CHECK knows little.** It says nothing about an account it has no signal for; its `block` is for the arena's
  own broken safes and for accounts that do not exist.
- **Sandbox races name a private repository.** The first testnet bounties were judged from GitHub Actions runs of the
  development repository named in `services/judge/src/judge.rs`, a constant compiled into the judge's pinned wasm. A
  live round, the only kind on mainnet, is judged from the chain alone.

<details>
<summary><b>Built with</b>: every library, service and AI tool</summary>

- **NEAR:** near-sdk 5.30 for the Rust contracts; near-workspaces 0.24 and near-sandbox 0.4 for a local neard 2.14 per
  attempt; cargo-near 0.22 for reproducible builds (NEP-330); public RPC of FastNEAR, dRPC and near.org; NEAR AI Cloud;
  OutLayer (the `outlayer` 0.2 crate, wasi 0.13, wasi-http-client, target wasm32-wasip2); NEAR Intents 1Click;
  @hot-labs/near-connect 0.12 for NEAR wallets on the site; binaryen's wasm-opt.
- **Rust crates:** serde, serde_json, sha2, sha3, ed25519-dalek, x25519-dalek, k256, aes-gcm, hkdf, getrandom, wasmi 2
  (runs a client's private tests), tokio, anyhow; in tests base64, ureq, wat.
- **TypeScript:** Node 22.21+, pnpm 12, TypeScript 5, Vitest 3, zod 4, @noble/curves and @noble/hashes,
  @phala/dcap-qvl 0.7 (Intel TDX quotes), @modelcontextprotocol/server and client 2.4, esbuild (the Hire script).
- **Site:** Next.js 16, React 19, three 0.186 (the 3D arena), uqr (QR codes), @vercel/blob (team sign-ups), happy-dom
  in tests; hosted on Vercel.
- **Media:** Remotion 4 and Playwright for cards and clips; fonts Hubot Sans and Mona Sans (@fontsource-variable),
  fontkit and wawoff2 to subset them.
- **AI:** much of the code was written with Claude Code and Codex under the author's direction; every rule is pinned
  by tests. The mask and arena frames in `brand/art/web` and the clips' music are AI-generated. The masks' models are
  the three named above.

</details>

## Baseline

- **Nothing predates the hackathon.** The first commit of the development repository is from 2026-11-01, inside the
  window that runs from 2026-10-19 to 2026-11-14. There is no earlier code and no product on another chain behind this
  one: MASK WARS is a new project, built on NEAR only.
- **This repository is an export.** Development happens in a private repository (more than 800 commits by 13 November). Each
  commit here is one cumulative export made by a script, and its message names the development commit it came from,
  so this history starts on 2026-11-10. [BUILDLOG.md](BUILDLOG.md) dates each piece from the development commits.
- **Techniques from the author's earlier products, rewritten here:** the Elo rating in `packages/core` (from a game,
  2026-10-28, not on NEAR), cleaning outside text before a model reads it (`packages/mind/src/clean.ts`) and the
  event → card → post queue in `packages/media`.
- **Libraries and AI:** everything third-party is listed under Built with, above.

## More

[RULES.md](RULES.md) · [JUDGE-PATH.md](JUDGE-PATH.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
[SECURITY.md](SECURITY.md) · [BUILDLOG.md](BUILDLOG.md) · [BRAND.md](BRAND.md) ·
[Bounty contract](contracts/bounty/README.md) · [Contracts and their source](contracts/README.md) ·
[MASK CHECK](packages/check/README.md) · [Race](packages/race/README.md) · [Jobs](contracts/jobs/README.md) ·
[Crews](contracts/crews/README.md) · [House](contracts/house/README.md) · [Mainnet scripts](scripts/mainnet/README.md) ·
[MIT License](LICENSE)
