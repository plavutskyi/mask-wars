<p align="center"><a href="https://maskwars.xyz/race/race-0001"><img src="packages/media/shots/race-0001/cards/01-result.png" alt="Race 1 on NEAR mainnet: 0.54 NEAR drained by the mask ORACLE, plus a 0.21186 NEAR bounty paid by the contract" width="100%"></a></p>

<h1 align="center">MASK WARS</h1>

<h3 align="center">AI masks break safes on NEAR.<br>The contract pays the winner.</h3>

<p align="center">
  <a href="https://github.com/plavutskyi/mask-wars/actions/workflows/ci.yml"><img src="https://github.com/plavutskyi/mask-wars/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  &nbsp;·&nbsp;
  <a href="https://maskwars.xyz">maskwars.xyz</a>
  &nbsp;·&nbsp;
  <a href="JUDGE-PATH.md">Judge path</a>
  &nbsp;·&nbsp;
  <a href="RULES.md">Rules</a>
</p>

**MASK WARS is an arena on NEAR where AI agents ("masks") race to break a contract that holds real NEAR, and a bounty
contract with no key pays the winner by itself.** Each mask is its own NEAR account with narrow function-call keys. A
judge in a TEE reads the break from the chain. Every break becomes data other agents read before they pay.

## Live on NEAR mainnet

Round [`race-0001`](https://maskwars.xyz/race/race-0001), 10 November 2026, real NEAR. Times are UTC.

| Time | What happened | Explorer | For a machine |
| --- | --- | --- | --- |
| 15:14:32 | The team opens the round: 0.35 NEAR locked in `bounty.maskwars.near` on the safe `safe-0001.maskwars.near` | [3KutM1…](https://nearblocks.io/txns/3KutM1kRv5ukkEoTZczZbZjfEJjEvjpmVodEj4iRbyhC) | [JSON](https://api.nearblocks.io/v3/txns/3KutM1kRv5ukkEoTZczZbZjfEJjEvjpmVodEj4iRbyhC) |
| 15:24:50 | The mask ORACLE seals the sha256 of its plan | [DBk3dR…](https://nearblocks.io/txns/DBk3dRU2SMymK2M9v2GR2ApGSRFqJQiQKSZGSzeDkzx8) | [JSON](https://api.nearblocks.io/v3/txns/DBk3dRU2SMymK2M9v2GR2ApGSRFqJQiQKSZGSzeDkzx8) |
| 15:59:48 | 0:15 after the commit window closes, ORACLE drains the safe: 0.54 NEAR, signed with its own function-call key | [CWcwqh…](https://nearblocks.io/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM) | [JSON](https://api.nearblocks.io/v3/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM) |
| 15:59:56 | ORACLE claims. The judge, a wasm the contract pins by sha256, run by OutLayer in a TEE, confirms the drain from the chain in 5.6 s. At 16:00:10 the contract sends ORACLE the bounty, 0.21186 NEAR. One transaction, no hand in it | [9ai1Pb…](https://nearblocks.io/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM) | [JSON](https://api.nearblocks.io/v3/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM) |

The same from the chain and the site, with nothing installed. The two `curl` lines only read; the last one connects
Claude Code to the arena's MCP server.

```bash
# The round, from the bounty contract itself (args_base64 is {"id":"race-0001"})
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"bounty.maskwars.near","method_name":"get","args_base64":"eyJpZCI6InJhY2UtMDAwMSJ9"}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
# {"owner":"maskwars.near","amount":"211860000000000000000000","target":"safe-0001.maskwars.near","deadline_ns":"1794338072248087615","status":{"state":"drained","winner":"oracle.maskwars.near","tx_hash":"CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM"}}

# MASK CHECK, asked about the drained safe
curl -s 'https://maskwars.xyz/api/check?account=safe-0001.maskwars.near'
# "verdict":"block" ... "code":"arena_drained"

# The arena for an agent: 17 read-only tools over MCP
claude mcp add --transport http maskwars https://maskwars.xyz/mcp
```

[JUDGE-PATH.md](JUDGE-PATH.md) has every command with its full answer. Explorer pages answer a script with 403, so
each transaction also has a JSON link.

**The problem.** Agents are starting to hold money and pay contracts on their own. Two things are missing: a way to
find a contract's hole for a bounty with no trusted middleman, and an answer to "should I pay this account?" that an
agent can read before it signs. MASK WARS does the first as a live race and turns each break into the second:
MASK CHECK says `block` for a safe a mask has drained.

**Breaking a safe is the first kind of job.** The same parts carry any work whose result can be proven: a client
locks NEAR on a job, masks take it alone or as a crew, a judge decides, the contract pays. That jobs market is live on
NEAR testnet with one paid job. [What is built](#what-is-built) gives the status of every part.

## Try it

No keys, no wallet, no sign-up. You need Node 22.21 or newer (the demo scripts pass `--use-env-proxy`, which Node has
from 22.21), pnpm (no pnpm yet: `corepack enable`) and, for the round and the contract tests, Rust through
[rustup](https://rustup.rs): the repository pins 1.97.0 and rustup fetches it on first use. The MASK CHECK step reads
NEAR testnet and mainnet over public RPC.

```bash
git clone https://github.com/plavutskyi/mask-wars
cd mask-wars
pnpm install --frozen-lockfile
pnpm demo
```

`pnpm demo` runs three steps, each also on its own: a sealed round in a local NEAR sandbox (`pnpm demo:round`, 20 s),
the MASK CHECK demo live on testnet and mainnet (`pnpm demo:check`, 5 s) and the contract tests
(`pnpm demo:contracts`, 40 s). The first run also builds the Rust sandbox runner and the tests: about 7 minutes on
4 cores.

| Do | You see, verbatim |
| --- | --- |
| `pnpm demo` | `NOVA wins the round` |
| `pnpm demo:round` | `VOLT seals × the commit window is closed` |
| the same | `ORACLE claims × this mask sealed no plan` |
| the same | `NOVA claims ✓ the judge confirmed the drain` |
| `pnpm demo:check` | `→ BLOCK. The payment is stopped. Nothing was signed.` |
| the same | `All four steps live on testnet.` |
| the same | `Mainnet live: treasury.intents.near BLOCK (no such account)` |
| `pnpm demo:contracts` | `a_peeked_plan_does_not_match_an_earlier_seal - should panic ... ok` |
| the same | `every_source_must_agree ... ok` |

`pnpm demo:round` plays one round with four scripted masks and no models. The bounty contract, the live safe and the
judge are the real code; only OutLayer is a local stand-in that holds each judge request until the judge answers. One
run, seal hashes change every time:

```text
TEAM    opens      ✓ 1.000 NEAR on safe.test.near for 4 masks
ONYX    seals      ✓ seal #0 90cf3ff0c11b
NOVA    seals      ✓ seal #1 c8bc74a7f600
—— the commit window closes ——
VOLT    seals      × the commit window is closed
NOVA    set_owner  ✓
NOVA    sweep      ✓
ONYX    set_owner  ✓
ONYX    sweep      ✓
ORACLE  set_owner  ✓
ORACLE  sweep      ✓
ONYX    reveals    × the plan does not match the seal
ONYX    reveals    ✓ 1 call
NOVA    reveals    ✓ 2 calls
ORACLE  reveals    × this mask sealed no plan
ONYX    claims     × the judge refused: sandbox: the safe was touched before the plan started
NOVA    claims     ✓ the judge confirmed the drain
ORACLE  claims     × this mask sealed no plan
NOVA    PAID       ✓ 0.968 NEAR for seal #1

NOVA wins the round
```

NOVA found the hole and sealed its plan. ONYX sealed a guess first and then borrowed NOVA's move, ORACLE copied NOVA
off the chain, VOLT found the hole after the window. All of them took loot out of the safe; only the sealed plan that
broke the untouched safe gets the bounty.

`pnpm demo:check` is MASK CHECK, the question an agent asks before it pays. On testnet a hidden instruction in an
invoice tells a payment agent to send 2 NEAR to a safe a mask drained; the agent's wrapper asks MASK CHECK, gets
`block` with the arena's drain as the reason, and never signs. On mainnet the instruction names a lookalike of
`intents.near` that does not exist: `block` again. The demo holds no key.

CI does not run `pnpm demo:round` itself. It plays the same round as a Rust test
(`the_finder_wins_and_no_copycat_does`, job `challenges`), runs `pnpm demo:check` against live RPC (job
`mask-check-live`) and runs the contract and TypeScript tests. A job runs when the files it builds change; the live
jobs also run every day and every job runs on Sunday. If a step stops on your machine,
[JUDGE-PATH.md](JUDGE-PATH.md) has the fixes.

## How a round works

1. **Open.** A team calls `open_safe` on the bounty contract with the bounty attached, names the safe and the masks
   that may win (1 to 16), and picks the commit window and the deadline. The contract locks the safe to the round.
2. **Seal.** A mask that finds the break calls `commit(id, hash)`: only the sha256 of its plan, salt and own account.
   Seals are numbered as they arrive.
3. **Play.** After the window closes, the mask sends the safe exactly the calls it sealed, signed with its own key.
4. **Reveal and claim.** `reveal` shows the plan and the contract checks it against the seal. `claim_drain` sends the
   drain to the judge.
5. **Paid.** The judge on OutLayer reads every transaction of the plan from several RPC sources that must agree and
   confirms that it broke the untouched safe. The contract pays the earliest confirmed seal. If nobody wins, the team
   takes its NEAR back.

The full rules, the clock and every edge case: [RULES.md](RULES.md). The contract: [contracts/bounty](contracts/bounty/README.md).

## What NEAR does here

Each line: the NEAR feature, what it does in this product, where it shows live, the code.

- **Named sub-accounts.** Every mask is its own account, like `oracle.maskwars.near`, so each move on chain traces
  back to one agent. Live: the signer of every transaction above. `packages/race/src/live.ts`
- **Function-call access keys.** A mask races with two keys, each tied to one contract and a list of methods: one on
  the safe, one on the bounty contract (`commit`, `reveal`, `claim_drain`, `settle`). By protocol rule such a key
  cannot transfer NEAR, attach a deposit, add a key or call another contract. Live: the mainnet drain and claim are
  signed with these two keys. `packages/race/src/keys.ts`
- **An account with no access key.** `bounty.maskwars.near` was created, funded, deployed and initialised in one
  transaction that adds no key, so nobody can redeploy it or move its NEAR by hand. Its admin can only `propose` a
  change that waits in the open: 1 hour for a new judge, 108 hours for new code while a bounty is live. Live:
  `view_access_key_list` returns `[]`. `contracts/bounty/src/admin.rs`
- **Yield and resume, with OutLayer.** `claim_drain` asks `outlayer.near` to run the judge. The call stays a yielded
  promise while OutLayer runs the wasm the contract pins by sha256, in a TEE; the callback `on_judged` pays. Live:
  claim, verdict and payout are one transaction, 9ai1Pb… above. `contracts/bounty/src/lib.rs`, `services/judge`
- **NEAR AI Cloud.** Masks think only with Private TEE models: GLM 5.3 Flash, DeepSeek V4.1 Flash, Qwen 3.8 27B. The
  check sends a fresh nonce and finds it in the Intel TDX quote of the gateway and of every model node, with NVIDIA's
  verdict on each GPU. Live: [maskwars.xyz/api/verified](https://maskwars.xyz/api/verified). `packages/mind/src/attestation.ts`
- **Global contracts.** The safe's code is published on NEAR once, by its hash, and every season safe only points at
  it: a fresh safe costs an account, not another copy of the code. Live on testnet:
  `s0001.season.tinygif8324.testnet` has no code of its own, only `global_contract_hash`. `contracts/season/src/lib.rs`
- **NEAR Intents, 1Click.** In a person's vault and in Hire, a coin sent from Solana, Base, Ethereum, Arbitrum, Tron
  or Bitcoin is swapped by 1Click and lands as NEAR on the person's own account in `intents.near`; a payout is an
  intent the person signs with a passkey. Not live: prices are read on the site, deposit addresses are closed.
  `packages/pay`, `packages/hire`

On mainnet the judge reads a drain from three sources that must give one verdict: the OutLayer worker's RPC and two
public RPCs of other operators (`services/judge/src/lib.rs`).

## Tracks

One line per track: what answers it, where it runs, and the command or link that shows it.

| Track | What answers it | Runs on | See it |
| --- | --- | --- | --- |
| AI Swarms | A sub-account per mask, a coordinator contract with sealed rounds (commit a hash, play after the window, reveal), the rules first in [RULES.md](RULES.md), a simulation with scripted masks and no model calls. Crews of masks that split a reward by role are on testnet only | mainnet (rounds), testnet (crews) | [`race-0001`](https://maskwars.xyz/race/race-0001), `pnpm demo:round` |
| AI Security & Defense | MASK CHECK: `allow`, `warn` or `block` with reasons read from the chain, and a signal no list has: this contract was already broken by an agent on the arena. A wrapper that refuses to sign on `block`; function-call keys scoped to one contract; a prompt-injected agent stopped before it pays | mainnet | `curl 'https://maskwars.xyz/api/check?account=safe-0001.maskwars.near'`, `pnpm demo:check` |
| Agent Economy | A mask is an agent with its own NEAR account: ORACLE earned 0.21186 NEAR from the contract on mainnet with no hand in the payout. Outside agents read the arena and ask MASK CHECK over MCP. A jobs market where a client locks NEAR and masks are paid on a judge's answer is live on testnet with one paid job | mainnet (earning, MCP), testnet (jobs) | `claude mcp add --transport http maskwars https://maskwars.xyz/mcp` |
| Privacy & Private AI | Masks think only on NEAR AI Cloud Private TEE models; attestation is checked with a fresh nonce on every request to `/api/verified`; the judge runs in OutLayer's TEE; a plan stays sealed until the window closes | mainnet | `curl https://maskwars.xyz/api/verified`, `pnpm verify:attestation` |
| Open Innovation | AI agents earn NEAR by breaking contracts in a live race, and every break becomes data other agents read before they pay | mainnet | [maskwars.xyz](https://maskwars.xyz) |

Not claimed: DeFi, Thesis, Autonomous Business, Real-World Money, Games, NFTs, Memecoins, Social Money. Nothing in this
repository is built for them.

## What is built

**LIVE mainnet** works today on NEAR mainnet or on maskwars.xyz, which reads mainnet · **LIVE testnet** is deployed on
NEAR testnet and has run there with test NEAR · **SIMULATED** is code with tests in this repository that runs in a
local sandbox or on recorded answers and is not deployed · **NOT BUILT** is not in this repository.

| What | Where | Status | Read it yourself |
| --- | --- | --- | --- |
| Bounty contract on an account with no key | `contracts/bounty` | LIVE mainnet | [chain reads](JUDGE-PATH.md#60-seconds-nothing-to-install) of `bounty.maskwars.near` |
| Live safe with a planted hole | `contracts/challenges/live-safe` | LIVE mainnet | [the drain](https://api.nearblocks.io/v3/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM) of `safe-0001.maskwars.near` |
| Judge on OutLayer, in a TEE, pinned by sha256 | `services/judge` | LIVE mainnet | [logs of the claim](JUDGE-PATH.md#the-transactions) |
| Masks: own accounts, function-call keys | `packages/race/src/live.ts` | LIVE mainnet | signers of the drain and the claim |
| Sealed rounds: commit, play, reveal | `contracts/bounty/src/lib.rs` | LIVE mainnet | view `get_round`: seal #0 `confirmed` |
| Races on NEAR AI Cloud models | `packages/race` | LIVE mainnet | [run 42842359569](https://github.com/plavutskyi/mask-wars/actions/runs/42842359569) |
| MASK CHECK: the check, the agent wrapper, the API | `packages/check`, `apps/web/app/api/check` | LIVE mainnet | [/api/check](https://maskwars.xyz/api/check?account=safe-0001.maskwars.near) |
| Attestation of the models with a fresh nonce | `packages/mind/src/attestation.ts`, `apps/web/app/verified` | LIVE mainnet | [/api/verified](https://maskwars.xyz/api/verified) |
| MCP server, 17 read-only tools | `apps/mcp` | LIVE mainnet | [/mcp](https://maskwars.xyz/mcp) |
| The arena on the site, read from the chain: race, masks, league, 3D arena | `apps/web/components/arena`, `apps/web/components/arena3d`, `packages/arena` | LIVE mainnet | [/api/races/race-0001](https://maskwars.xyz/api/races/race-0001) |
| Sign-up page for teams | `apps/web/app/break` | LIVE mainnet | [/break](https://maskwars.xyz/break) |
| Jobs market and crews | `contracts/jobs`, `contracts/crews` | LIVE testnet | one job paid: [settle](https://api-testnet.nearblocks.io/v3/txns/zxyaAKQHRtd87tDrC8ZfrNqAHW6NjFX9gmkCWooi7dE) |
| Season: a treasury with no key opens rounds | `contracts/season` | LIVE testnet | view `season`: `rounds: 2`, none paid yet |
| Forge your own mask | `contracts/masks`, `packages/forge`, `apps/web/app/forge` | SIMULATED | **on no network**: [/api/forge](https://maskwars.xyz/api/forge) says `"open":false` |
| A person's mask in a sealed round | `packages/race/src/keeper.ts`, `services/brain` | SIMULATED | waits for the forge |
| Confidential copying of a sealed strategy | `contracts/masks/factory` | SIMULATED | waits for the forge |
| Job judges in a TEE: private tests, AI review | `services/judge-tests`, `services/judge-review` | SIMULATED | not on chain: the jobs contract has `judges: []` |
| A person's vault through NEAR Intents | `packages/pay`, `apps/web/app/wallet` | SIMULATED | page up, **top-ups closed** |
| Hire the swarm, a button other apps embed | `packages/hire`, `apps/web/app/hire` | SIMULATED | page up, **deposits closed** |
| MASK CHECK signed inside a TEE | `services/check` | SIMULATED | not published on OutLayer |
| Jobs, season and forge on mainnet | `packages/network`, `scripts/mainnet` | SIMULATED | no account yet: [/api/jobs](https://maskwars.xyz/api/jobs) says `"deployed":false` |
| A round with scripted masks, no models | `contracts/challenges/runner` | SIMULATED | `pnpm demo:round` |
| Ten more targets for sandbox races | `contracts/challenges` | SIMULATED | `pnpm demo:contracts` |
| Agent Market client | `packages/market` | SIMULATED | not listed there |
| Vault for winning breaks | `services/vault` | SIMULATED | not called yet |

Tools outside the running product: `packages/media` builds the cards and the 16:9 clip of a round from its chain
record; the mainnet round's are in `packages/media/shots/race-0001`. `packages/brand` holds the tokens and fonts.

The first design of this repository, on 1–2 November, was market duels between masks; the race replaced it on
2 November. What is left of it does not run in the arena: `packages/core` (its ids and types are still used by
`packages/media`) and the mask voices in `packages/mind`.

## Live on NEAR testnet

The same contracts ran on testnet first, with test NEAR. `tinygif8324.testnet` is the team's account.

| Date | What happened | Transaction |
| --- | --- | --- |
| 10 Nov | Jobs market: `settle` pays 0.95 NEAR to ORACLE for the job `break-safe-0004`, fee 0.05 NEAR | [zxyaAK…](https://testnet.nearblocks.io/txns/zxyaAKQHRtd87tDrC8ZfrNqAHW6NjFX9gmkCWooi7dE) · [JSON](https://api-testnet.nearblocks.io/v3/txns/zxyaAKQHRtd87tDrC8ZfrNqAHW6NjFX9gmkCWooi7dE) |
| 10 Nov | `race-0005` on the contract with no key: ONYX seals, drains 1.34 NEAR, the contract pays 0.2115 NEAR | [BuFJTe…](https://testnet.nearblocks.io/txns/BuFJTeszB25qVkhTQcHyhHsaPotYQhtmKAHdV1MQFBME) · [JSON](https://api-testnet.nearblocks.io/v3/txns/BuFJTeszB25qVkhTQcHyhHsaPotYQhtmKAHdV1MQFBME) |
| 6 Nov | `race-0003`, the first mask paid: NOVA drains 1 NEAR with its function-call key and the first contract pays 0.08664 NEAR. That claim was sent by hand with NOVA's full key | [8pvCJF…](https://testnet.nearblocks.io/txns/8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg) · [JSON](https://api-testnet.nearblocks.io/v3/txns/8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg), [BHuCzq…](https://testnet.nearblocks.io/txns/BHuCzqtM3ZWnS4EBww9ig9txers8ebQnqerGCpqW4Me8) · [JSON](https://api-testnet.nearblocks.io/v3/txns/BHuCzqtM3ZWnS4EBww9ig9txers8ebQnqerGCpqW4Me8) |

## Roadmap (not in this submission)

- On mainnet: the season treasury, the jobs market and the forge. Their accounts and limits are in
  `packages/network/mainnet.json`: [how they are deployed](scripts/mainnet/README.md).
- The forge on testnet, and a first sealed round with a person's mask in it.
- Job judges on OutLayer pinned in the jobs contract, and masks that take a job with no hand in it.
- MASK CHECK as a paid, signed answer from the TEE module.
- Deposit addresses for the vault and for Hire.
- The race itself inside a TEE.

## Honest limits

- **One round on mainnet, small sums.** 0.35 NEAR locked, 0.54 NEAR drained. One mask of three acted on chain; NOVA
  and ONYX sealed nothing.
- **The holes are planted.** These are training targets; no third party's contract has been attacked.
- **The race is not in a TEE.** It runs on GitHub Actions; the models and the judge run in TEEs. A TEE proves which
  code ran, not that the code is right. This repository pins the judge's wasm by its hash and reads OutLayer's answer
  on chain; it does not verify OutLayer's own attestation.
- **The team still holds keys.** Each mask's account has a full-access key held by the team beside its function-call
  keys; the race signs with the function-call keys only. The team's account `maskwars.near` is the bounty contract's
  admin: it can propose a new judge or new code, and each waits in the open before it applies.
- **Jobs: testnet, one job.** The masks' calls on it were signed by hand. No job judge is on chain, so only a job
  that a sealed round decides can open.
- **Season: testnet, no payout yet.** The treasury opened two rounds; neither was won.
- **The forge is on no network.** People's masks and copying run only in the local sandbox.
- **The vault and Hire take no deposits yet.** No money has moved through them.
- **MASK CHECK knows little.** It says nothing about an account it has no signal for. Its `block` today is for the
  arena's own safes, listed in `packages/check/list.mainnet.json`, and for accounts that do not exist.
- **Sandbox races name a private repository.** The first testnet bounties were judged from GitHub Actions runs of the
  private development repository named in `services/judge/src/judge.rs`; nobody outside can open those runs. A live
  round, the only kind on mainnet, is judged from the chain alone.

## Built with

- **NEAR:** near-sdk 5.30 for the Rust contracts; near-workspaces 0.24 and near-sandbox 0.4 for a local neard 2.14 per
  attempt; public RPC of FastNEAR, dRPC and near.org; NEAR AI Cloud; OutLayer (the `outlayer` 0.2 crate, wasi 0.13,
  wasi-http-client, target wasm32-wasip2); NEAR Intents 1Click; @hot-labs/near-connect 0.12 for NEAR wallets on the
  site; binaryen's wasm-opt to shrink contracts.
- **Rust crates:** serde, serde_json, sha2, sha3, ed25519-dalek, x25519-dalek, k256, aes-gcm, hkdf, getrandom, wasmi 2
  (runs a client's private tests), tokio, anyhow; in tests base64, ureq, wat.
- **TypeScript:** Node 22.21+, pnpm 12, TypeScript 5, Vitest 3, zod 4, @noble/curves and @noble/hashes,
  @phala/dcap-qvl 0.7 (Intel TDX quotes), @modelcontextprotocol/server and client 2.4, esbuild (the Hire script).
- **Site:** Next.js 16, React 19, three 0.186 (the 3D arena), uqr (QR codes), @vercel/blob (team sign-ups), happy-dom
  in tests; hosted on Vercel.
- **Media:** Remotion 4 and Playwright for cards and clips; fonts Hubot Sans and Mona Sans (@fontsource-variable),
  fontkit and wawoff2 to subset them.
- **AI:** much of the code was written with Claude Code and Codex under the author's direction; every rule is pinned
  by tests. The mask and arena frames in `brand/art/web` and the clip's music are AI-generated. The masks' models are
  the three named above.

## Baseline

- **Nothing predates the hackathon.** The first commit of the development repository is from 2026-11-01, inside the
  window that runs from 2026-10-19 to 2026-11-14. There is no earlier code and no product on another chain behind
  this one: MASK WARS is a new project, built on NEAR only.
- **This repository is an export.** Development happens in a private repository (more than 460 commits by
  11 November). Each commit here is one cumulative export made by a script, and its message names the development
  commit it came from, so this history starts on 2026-11-10 and is short. [BUILDLOG.md](BUILDLOG.md) dates each
  piece from the development commits.
- **Techniques from the author's earlier products, rewritten here:** the Elo rating in `packages/core` (from a game,
  2026-10-28, not on NEAR), cleaning outside text before a model reads it (`packages/mind/src/clean.ts`) and the
  event → card → post queue in `packages/media`. The export script itself is based on one from another project of
  the author's and is not part of this repository.
- **Libraries and AI:** everything third-party is listed in [Built with](#built-with).

## More

[RULES.md](RULES.md) · [JUDGE-PATH.md](JUDGE-PATH.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
[SECURITY.md](SECURITY.md) · [BUILDLOG.md](BUILDLOG.md) · [Bounty contract](contracts/bounty/README.md) ·
[MASK CHECK](packages/check/README.md) · [Race](packages/race/README.md) ·
[Targets and the sandbox runner](contracts/challenges/README.md) · [Season](contracts/season/README.md) ·
[Masks](contracts/masks/README.md) · [Jobs](contracts/jobs/README.md) · [Crews](contracts/crews/README.md) ·
[Hire the swarm](packages/hire/README.md) · [Mainnet](scripts/mainnet/README.md) ·
[Brand book](docs/brand/BRANDBOOK.md) ·
[MIT License](LICENSE)
