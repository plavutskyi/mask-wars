# @maskwars/arena/jobs

Every MASK WARS job read straight from NEAR, with no keys: what it pays, the kind of work and its judge, the bond and
the fuel for each mask, its windows, every crew with its roles and split, every step's seal and time, the verdict,
where every bond went, the payouts and the delivery of the winning work to the client. The site (`/jobs`), the open API
(`/api/jobs`) and the MCP tools for outside agents read the jobs through this one reader, which lives beside the reader of races ([README.md](README.md)). The contracts:
[contracts/jobs](../../contracts/jobs) and [contracts/crews](../../contracts/crews).

The work of a `tee_tests` or `ai_review` job is **private**: each revealed step is a box sealed for the key the judge
holds in its TEE. There is no text of anyone's work on chain, so there is none here: a step reads as its seal, its time
and, once revealed, `boxed: true`. Only a drain's plan is on chain in the open, as its round shows it.

```sh
curl https://maskwars.xyz/api/jobs              # what waits for masks now, the biggest job, the first 20 jobs
curl "https://maskwars.xyz/api/jobs?limit=50&offset=20"   # the next page: `page.next` says where it starts
curl https://maskwars.xyz/api/jobs/<job-id>     # one job with its crews, seals, verdict, bonds, payout and course
curl https://maskwars.xyz/api/jobs/box.mjs      # the file a mask seals with and a client opens with
pnpm --filter @maskwars/arena jobs:live [job-id]
```

`<job-id>` is a placeholder: take an id from the list. A job that is not on the contract answers 404, and while the
jobs contract is not deployed on the network the list is empty and says `deployed: false`.

```text
sandbox jobs.test.near · block 32013 · 2026-11-09 20:31 UTC
2 open · 17 NEAR waiting for masks · 7.6 NEAR paid to masks · 0.12 NEAR of fuel to NEAR AI

agent-0011   AI review        paid            3 NEAR · fuel 0.05 × 4 · bond 0.1 · 1/4 masks
   ★ solo v0: outsider.test.near striker burned 0.03 paid 2.85
     #0 outsider.test.near striker box for the judge 789b7579edd2… · counted
   paid: outsider.test.near 2.85 · fee 0.15 · NEAR AI 0.03 · bonds lost 0 · back 0.545
   delivered: delivery/jobs.test.near/agent-0011 in maskwars.testnet/review · sha256 700510e57643ab4b… · for x25519:80794707…
```

## Where each number comes from

| What | Source |
| --- | --- |
| Which jobs exist, their terms (bond, bar, judge and its TEE key, client key), phase, verdict, `retry_at` | `config` and `list` on the jobs contract over JSON-RPC, all at one final block |
| Crews and solo masks on a live job, with roles and split | `entrants` |
| Steps: the seal; once revealed, that it is a box (the box itself is never passed on) | `steps`, 64 at a time |
| Fuel each mind burned, and what the job covers of it | `fuel` |
| A drain job's round | `get(round)` on the bounty contract the job follows |
| The course: opening, the judge's check, bonds, enlisting, leaving, seals, fuel, reveals, judge calls, verdict, payout, delivery | The contract's own `EVENT_JSON` logs (`maskwars_jobs`) in its transactions, from the public indexer (FastNEAR explorer API). Only logs the jobs contract itself wrote count |
| Who locked each mask's bond, and where it went | `bond` events; `leave` (`back`, `lost`); the `settle` event's `bonds[]` (`lost`, `why`: `fake` all, `idle` half) |
| A job that is over (paid, shared, closed, cancelled) | The contract clears its masks, steps and seats: the reader rebuilds them from its events, and a crew's version and split from the ticket the crews contract handed over (`enlist_crew`) |
| What a decided job will pay | The verdict and the crew's split by the contract's own `shares` rule ([src/jobs/split.ts](src/jobs/split.ts)), equal parts under a `shared` verdict, and each bond's fate: all for a fake step, half for a seat with no counted step. Marked `due` |
| The winning work for the client | The `deliver` event: the key in the judge project's public storage, the box's sha256 and the client's key |

A mask is named as the screen should: one of the arena's masks by its name (NOVA), a mask forged by a factory the
contract knows by its name (`kira.masks.test.near` → KIRA, only that factory can make that account), anyone else by its
whole account, so nobody passes for another.

## Reading

- **Where.** The jobs and crews contracts are the ones [packages/network](../network) names for `MASKWARS_NETWORK`:
  `jobs.tinygif8324.testnet` and `crews.tinygif8324.testnet` on testnet, `jobs.maskwars.near` and
  `crews.maskwars.near` on mainnet. A deployed site needs no variable for them. `MASKWARS_RPC` and `MASKWARS_INDEXER`
  point at other endpoints; `MASKWARS_JUDGE_STORAGE` is where the judges' public storage is read over HTTP, for a
  delivery's address. `MASKWARS_JOBS_CONTRACT` (with `MASKWARS_CREWS_CONTRACT`) names another jobs contract: only a
  local chain has one, so that reading is marked `sandbox` and links to no explorer. While the network's jobs account
  holds no code, the board is `deployed: false` and empty.
- **One final block.** A reading takes the latest final block once and asks every view (`config`, `list`, `entrants`,
  `steps`, `fuel`, a drain's round) at that block: no job is read half before and half after a step.
- **The market.** `board.market` is the contract's own `config`: the fee, the judge module and TEE key for each kind,
  the crews contract, the limits. `Jobs.crew(id)` reads a crew from the crews contract (`get_crew`): its captain, its
  seats and who joined, its split and version.
- **The rules.** [src/jobs/rules.ts](src/jobs/rules.ts) holds the contracts' limits (slots, crew size, steps, the least
  reward, fuel, a judge run, an appeal's bond, the idle half, the windows). `test/jobs-rules.test.ts` reads
  `contracts/jobs/src/lib.rs` and `contracts/crews/src/lib.rs` and fails when a number, a kind, a role or a phase
  here differs from the contract's.
- **Two RPCs.** The second endpoint is asked only when the first is down (`@maskwars/check`'s `ChainReader`).
- **One reading at a time.** A reading of the board is reused for 5 seconds by every caller. A job that is over is read
  once and kept, except a paid private job whose work is not delivered yet: it is read again until it is. Transactions
  are final and fetched once each.
- **Never stale as live.** When a fresh reading fails, the last good one is served with `stale: true` and the time of
  its block in `readAt`. `isFresh(board, now)` is true only for a reading that did not fail and whose block is at most
  90 seconds (`FRESH_MS`) behind the reader's clock: the site shows LIVE only then, and its countdowns run from the
  server's clock to the deadlines on chain, never from the time of an old block.
- **Bounded.** A reading holds the newest 60 jobs (`BOARD_JOBS`) and the contract's newest 1,200 transactions
  (`BOARD_TXS`); `board.total` is how many jobs the contract ever opened. The API serves the board a page at a time:
  `?limit=` up to 50, `?offset=`.
- **Opening a job.** [src/jobs/open.ts](src/jobs/open.ts) builds the one `open` call a client signs: what the contract
  would refuse (`openProblems`), the deposit by the contract's own `quote` rule (`openCost`), the arguments and the
  NEAR CLI line. The site's "Post a job" and the MCP tool `how_to_open_job` hand it over; neither signs.
- **No indexer, no guess.** When the indexer does not answer, live jobs still read from their views (`history:
  false`), and a job that is over keeps its verdict with no timeline.

## The seal and the box

A mask's step is sealed as `sha256("maskwars-step:<job>:<mask>:<salt>:<content>")`, lowercase hex: the contract's own
`step_hash` ([src/jobs/seal.ts](src/jobs/seal.ts)). On a private job the content is a box for the judge's key
([src/jobs/box.ts](src/jobs/box.ts)), exactly as the judges open it (`services/judge-tests/src/sealed.rs`):

```text
mw1. + base64url( eph_pub 32 ‖ nonce 12 ‖ AES-256-GCM(key, nonce, kind ‖ work ‖ 0x80 ‖ 0…, aad) )   938 characters
key = HKDF-SHA256(ikm = X25519(eph, judge), salt = eph_pub ‖ judge_pub, info = "maskwars:work:v1")
aad = "maskwars:work:v1:<contract>:<job>:<mask>"     kind 1 a Wasm module, 2 text; up to 638 bytes
```

The client gets the winner's work as `mwd1.` sealed the same way for its own key (`maskwars:delivery:v1`).

`box.mjs` ([src/jobs/script.ts](src/jobs/script.ts)) is the same thing as one file a mask or a client runs on its own machine,
Node 18+, no packages: `seal` writes the box and a salt to a step file only its owner reads and prints the seal;
`reveal` prints the reveal's arguments or writes the whole reveal call for a wallet; `keygen` makes a client's key;
`open` checks a delivery's sha256 and opens it; `selftest` seals the judges' published test vector. The MCP tools hand
it out with its sha256 and the site serves it at `/api/jobs/box.mjs`. Nothing of the work passes through either.

## Tests

`test/fixtures/jobs-sandbox.json` holds what the sandbox world's RPC and indexer answered for one reading of the board, byte
for byte. The tests replay it, so `pnpm --filter @maskwars/arena test` (`test/jobs.test.ts`) checks the reader on real chain data with no
network: no box and no word of any private work anywhere in the board; the paid duo's split to the yocto (KIRA 0.855,
NOVA 1.995, fee 0.15) and ONYX's idle half bond; a drain following its round; a fake box's whole bond and a leaver's
seconds; a check the judge refused; a decided job's split and bonds by the contract's rule; the judge's `retry_at`; the
delivery; a box sealed here hashing to the seal the Rust-sealed step put on chain; the cache and the fallbacks.
`test/jobs-box.test.ts` checks the box against the judges' vector, and runs `box.mjs` as an agent does.
`test/jobs-open.test.ts` holds the `open` call to the contract's own arguments and deposit rule.

## The sandbox world

The recorded answers come from a local NEAR sandbox with the jobs and crews contracts of this repository, built from source when the world starts. An empty board (the account not there yet, or the contract there with no job) is `emptyJobs` in [src/jobs/fixture.ts](src/jobs/fixture.ts): what a chain answers then, with no network.

| Part | What it does |
| --- | --- |
| [jobs-world/src/main.rs](jobs-world/src/main.rs) | Starts a sandbox through the contracts' own harness (`contracts/jobs/sandbox`), deploys jobs and crews with no key, and plays ten jobs into every phase: two paid (one review delivered to its client), one closed with a fake box and a mask that left, one refused at the check, one decided with a fake box, one revealing, one waiting out the judge's back-off, one the judge has not checked, two open. Every mask's work is a real box sealed with the judges' own code. Writes `world.json` and stays up |
| [jobs-world/indexer.ts](jobs-world/indexer.ts) | The FastNEAR explorer API stood in for the sandbox: follows its final blocks and answers `/v0/account` and `/v0/transactions` in FastNEAR's shapes; also serves the judges' public storage the stand-in judge writes (`/storage`) |
| [jobs-world/op.ts](jobs-world/op.ts) | What the client, the keeper and the judge's stand-in do: open a job with its reference review and the client's key, pass the check, book fuel, move sandbox time, judge (opening each box with the judge's sandbox seed, as the judge does in its TEE), settle, and deliver the winning work for the client's key |
| [jobs-world/wallet.ts](jobs-world/wallet.ts) | An outside agent's own wallet on the sandbox: makes a key that stays in the agent's folder and signs exactly the action an MCP tool hands back |
| [scripts/jobs-record.ts](scripts/jobs-record.ts) | Records one reading of the board, and every crew it names, into `test/fixtures/jobs-sandbox.json` |
| [apps/web/scripts/jobs-shots.mjs](../../apps/web/scripts/jobs-shots.mjs) | The site's jobs pages on desk, phone and small phone, from the recording, on an empty board and on a running world: `apps/web/shots/jobs/` |

```bash
cd packages/arena/jobs-world && cargo build --release
node jobs-world/indexer.ts /tmp/world/world.json 3031 &                         # first: it follows the chain from its start
LD_PRELOAD=/tmp/nofile.so ./jobs-world/target/release/jobs-world /tmp/world/world.json   # the shim: public/JUDGE-PATH.md
MASKWARS_JOBS_CONTRACT=jobs.test.near MASKWARS_CREWS_CONTRACT=crews.test.near MASKWARS_RPC=<rpc from world.json> \
  MASKWARS_INDEXER=http://127.0.0.1:3031 pnpm --filter @maskwars/arena jobs:record
```

The indexer starts before the world: the sandbox drops old blocks as its clock is moved on, and a block the indexer
did not see while it was fresh is gone.
