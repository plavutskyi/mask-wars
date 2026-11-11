# MASK CHECK on OutLayer

One question any agent or app on NEAR asks over HTTPS before it sends money: **should I pay this account?** The answer
is `allow`, `warn` or `block`. It is read from the chain inside a TEE on [OutLayer](https://outlayer.ai), and the paid
answer is signed there. Every paid call pays the project in stablecoins through OutLayer Earnings.

It is the check of [`packages/check`](../../packages/check), rule for rule: the same signals, levels and words, on
mainnet and testnet, with mainnet read from two independent RPC providers that must agree at one block: what one of
them says alone is a warning, never an `allow`. The masks on the MASK WARS arena break contracts live; what they
break becomes the answer.

## Call it

```bash
# The verdict, free: nothing attached for the project
curl -X POST https://api.outlayer.ai/call/maskwars.near/check \
  -H "X-Payment-Key: $OUTLAYER_PAYMENT_KEY" -H "Content-Type: application/json" \
  -d '{"input": {"account": "treasury.intents.near"}}'

# Every reason with its evidence, signed: $0.01
curl -X POST https://api.outlayer.ai/call/maskwars.near/check \
  -H "X-Payment-Key: $OUTLAYER_PAYMENT_KEY" -H "X-Attached-Deposit: 10000" -H "Content-Type: application/json" \
  -d '{"input": {"account": "safe-0001.maskwars.near"}}'
```

`X-Payment-Key` is any OutLayer [payment key](https://app.outlayer.ai/docs/payment-keys): it pays OutLayer for the
run. `X-Attached-Deposit` is what the call pays the project, in millionths of a dollar.

| Input | | |
| --- | --- | --- |
| `account` | required | A NEAR account id |
| `network` | optional | `mainnet` or `testnet`. Left out, the account names it: `.testnet` reads testnet, every other id mainnet. A named network wins; a name of the other network is refused |
| `signed` | optional | `true`: a call that attached nothing is refused with the price instead of answered as a preview |
| `action` | optional | `"about"`: the price, the signing key, the rules and the RPC providers, without a check |

One deployment reads both NEAR networks: the module reaches the RPC providers itself, over HTTPS from inside the TEE.

## What a call gets

| Attached | Tier | The answer |
| --- | --- | --- |
| nothing | `preview` | The verdict, the block it was read at and the time. No reasons, no evidence, no signature |
| `10000` or more ($0.01) | `signed` | The whole answer of `packages/check` (verdict, summary, every reason with its evidence, the block, the providers) and an ed25519 signature over it |
| something, less than the price | `preview` | The same preview, with `payment.note`: what the signed answer costs and how to attach it. Never a refusal |
| the price, on a deployment that holds no key | `unsigned` | The whole answer, every reason with its evidence, and a `note` that nothing is signed |
| nothing, with `"signed": true` | — | `payment required: a signed verdict costs $0.01, this call attached $0. Set the header X-Attached-Deposit: 10000`, before anything is read |

The preview is free on purpose. A `block` is worth more to everyone when it reaches the agent that was about to pay
than when it sits behind a price, and an agent can try the call before it spends a cent. What is sold is what an
agent can show somebody else: the reasons with their evidence, and a signature a third party checks without calling
anyone.

**A call that attached money is always answered.** OutLayer keeps what a call attached whatever the module says, so
the module never answers such a call with a refusal: short of the price it gives the preview and says what is
missing, and at the price it gives everything it has. Two things are still outside its reach, and both cost the
caller the deposit: an `account` that is no NEAR account id, and a run OutLayer itself ends. So ask the preview
first, and attach the exact value.

A signed answer ([`sample.json`](sample.json) is one, produced by the module's own tests):

```json
{
  "success": true,
  "output": {
    "tier": "signed",
    "check": {
      "account": "safe-0001.tinygif8324.testnet",
      "network": "testnet",
      "verdict": "block",
      "summary": "BLOCK: Drained on the MASK WARS arena: mask nova.tinygif8324.testnet took the safe through its planted hole in race-0003, and the judge confirmed the drain on chain. Whoever controls it now is not its original owner.",
      "reasons": [{ "code": "arena_drained", "level": "block", "text": "…", "evidence": { "race": "race-0003", "winner": "nova.tinygif8324.testnet", "tx": "https://testnet.nearblocks.io/txns/8pvC…2uqg" } }, "…"],
      "block": { "height": 276842544, "hash": "…", "time": "2026-11-08T23:30:47Z" },
      "checked_at": "2026-11-08T23:30:49Z",
      "rpc": ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"]
    },
    "signed": { "alg": "ed25519", "key": "ed25519:…", "message": "{\"maskwars_check\":2,\"module\":{\"version\":\"0.2.0\",\"rules\":\"…\"},\"account\":\"safe-0001.tinygif8324.testnet\",…}", "signature": "<base64>" },
    "module": { "version": "0.2.0", "rules": "<sha256>" },
    "price": { "usd": "0.01", "usd_micro": 10000, "header": "X-Attached-Deposit: 10000", "attached_usd": "10000" },
    "attached_usd_micro": 10000
  },
  "error": null
}
```

OutLayer returns this object as the call's `output`, next to `compute_cost`, `instructions` and `attestation_url`.
Every signal and what it means: the [table in `packages/check`](../../packages/check/README.md#signals).

### From a contract

A contract reaches the module through OutLayer's own contract (`request_execution`) and cannot set a header. What
it pays the project is `params.attached_usd`, stablecoins it deposited there, and the module reads it the same way:
`"attached_usd": "10000"` buys the signed answer, less than that the preview with the note, and the note names
`attached_usd`, not a header. NEAR attached to the request pays OutLayer for the run and is not a payment to the
project. This path is covered by the module's tests; no call from a contract has been made yet.

## The price

A signed verdict costs **$0.01**: `X-Attached-Deposit: 10000`.

- **What the caller pays OutLayer** for the run, besides it. OutLayer's contract sets the rates (`get_pricing_full` on
  `outlayer.near` and `outlayer.testnet`, read on 2026-11-09): $0.001 a call, $0.000001 per million instructions and
  $0.000001 per second. A check is 5 to 16 small RPC answers and runs under OutLayer's default limit of a billion
  instructions, so the compute is between $0.001 and $0.002 a call. The preview costs the caller that and nothing else.
- **What a call costs the project.** Nothing per call: the caller's key pays the compute, and the module reads public
  RPC endpoints.
- **Why a cent.** It is ten times the compute, so the price is for the answer and not for the machine. It is the
  lowest paid tier OutLayer's own [earnings guide](https://app.outlayer.ai/docs/earnings) uses as its example. And it
  stays small next to any payment worth checking: an agent that moves ten dollars pays a tenth of a percent to know
  the payee exists and was not drained an hour ago.
- **Withdrawing.** Earnings add up on the project owner's OutLayer balance and are withdrawn as USDT or USDC from $1,
  which is a hundred signed verdicts.

Two rules of OutLayer a caller should know. The deposit is charged when the call is accepted, **even if the run then
fails** or the payment was short: OutLayer keeps it for the project either way. And a payment key's `max_per_call`
must cover the compute and the deposit together.

No income is promised by any of this. It is a price list.

### Who says what a call paid

The module takes the payment from one place: the variable OutLayer's worker writes for the kind of call it is.
`USD_PAYMENT` counts only when `OUTLAYER_EXECUTION_TYPE` is `HTTPS`, `ATTACHED_USD` only when it is `NEAR`
(`Run::from_env` in [`src/lib.rs`](src/lib.rs)). The same names anywhere else are not a payment.

Could a caller write `USD_PAYMENT=10000` into secrets of its own (`secrets_ref`) and be taken for a payer? We read
OutLayer's worker for the answer (commit `c30c667`, 2026-11-09): **no, on two counts.**

- Before the worker writes any variable of its own it removes every system name from the secrets the call brought:
  [`worker/src/main.rs#L1437-L1439`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/main.rs#L1437-L1439). `USD_PAYMENT`, `ATTACHED_USD` and
  `OUTLAYER_EXECUTION_TYPE` are on that list ([`#L1317-L1340`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/main.rs#L1317-L1340)). Then it writes
  them itself, on every run: the kind of call at [`#L1446-L1449`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/main.rs#L1446-L1449),
  `USD_PAYMENT` from the header on an HTTPS call ([`#L1483-L1486`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/main.rs#L1483-L1486)) and `"0"`
  on a call from the chain ([`#L1550`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/main.rs#L1550)). Its own test holds that:
  `no_secret_can_occupy_a_system_variable_on_either_path`
  ([`#L5158`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/main.rs#L5158)).
- The keystore refuses to store a secret under any of those names in the first place:
  [`keystore-worker/src/api.rs#L85-L123`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/keystore-worker/src/api.rs#L85-L123).

The module does not lean on that alone. A payment that arrives without OutLayer's own word on the kind of call buys
nothing, so a runtime that passed variables through would still give a preview; `cargo test` holds this
(`the_payment_is_read_from_the_runs_own_kind_of_call_and_from_nowhere_else`), and `live.mjs` tries it against the
published module when a secrets row is named for it.

The signing seed is protected the same way. Names that start with `PROTECTED_` can only be generated inside the TEE,
never set by hand ([`keystore-worker/src/api.rs#L879-L891`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/keystore-worker/src/api.rs#L879-L891)), and a call
whose own secrets carry a name the project's secrets also carry is refused before it runs
([`worker/src/connector_manifest.rs#L231-L246`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/connector_manifest.rs#L231-L246)).

## Check the answer yourself

**The signature.** `signed.message` is one line of JSON: first `maskwars_check`, a field no other message of this key
starts with; then `module`, the version and the rules that made the answer; then the answer itself.
`signed.signature` is ed25519 (RFC 8032) over its UTF-8 bytes.

```bash
node services/check/verify.mjs answer.json ed25519:<the project's key> --max-age 600
# VERIFIED: BLOCK safe-0001.tinygif8324.testnet on testnet, block 276842544, 2026-11-08T23:30:47Z (40 s ago)
# signed by ed25519:…, the key you passed
# module 0.2.0, rules …
```

[`verify.mjs`](verify.mjs) needs nothing but Node. It checks three things, and a caller's own code should check
the same three:

- **Whose signature it is.** The key is yours to name: the answer's own `signed.key` is only a claim, and anyone can
  sign anything with a key of their own. Without a key to trust the script verifies nothing and exits 1. Left out
  on the command line, the key is the one in [`deployment.json`](deployment.json), once a version is published.
- **That `check` is what was signed**, field for field.
- **How old it is**, with `--max-age <seconds>`. The age is counted from the time of the block the answer was read
  at, which comes from the chain. `checked_at` is the clock of the machine that ran the module, and that machine
  sets it. An answer that could not read the chain has no block and never passes an age limit.

`--rules <sha256>` holds the answer to one version of the rules; with the key from `deployment.json` the rules
recorded there are required too.

**The key.** It is made from `PROTECTED_CHECK_SEED`, 32 bytes OutLayer generated inside the TEE for this project: no
person ever saw them. `{"action": "about"}` returns the public key, and that run's attestation
(`attestation_url` in OutLayer's response) is an Intel TDX quote over the module's sha256 and that very output: proof
the key came out of this code. From then on a signature is checked against the key alone.

**Which rules made it.** The project has one key, and every version of the module the project ever publishes signs
with it: OutLayer hands the seed to all of them, and a caller can still ask for an old version by its `version_key`.
So the key alone does not say which rules answered. The message does: `module.rules` is the sha256 of everything
that decides an answer (the module's sources, its manifest, its dependency lock, its toolchain file and the two
shared lists; [`build.rs`](build.rs) computes it), and `module.version` is the crate's version. A signature over an
answer of old rules names the old rules, and a verifier that holds to the current ones refuses it. `about` returns
the same `module`, and `deployment.json` records it for the published version.

We chose this over a new seed for every version of the rules. A seed per version would make the key itself name
the rules, but every list update, which is a new version, would then need the owner to generate a seed and every
agent to learn a new key, and an agent that missed the change would refuse true answers. One key that stays, and a
message that names its rules, costs the verifier one comparison. The first shape of the message (`maskwars_check: 1`,
no `module`) was never published and no key ever signed it.

**The code.** OutLayer runs a wasm named by its sha256, and the attestation names it. Build it and compare:

```bash
services/check/build.sh     # prints the sha256 of target/wasm32-wasip2/release/maskwars-check.wasm
```

The build gives the same bytes in any folder on any machine with the toolchain in `rust-toolchain.toml`. The sha256
covers the rules, the RPC endpoints, the price and the two shared lists the module carries
([`list.json`](../../packages/check/list.json), [`list.mainnet.json`](../../packages/check/list.mainnet.json)): a new
report or a new arena safe is a new version. CI builds the module on every change and fails unless the file in
[`apps/web/public/outlayer`](../../apps/web/public/outlayer) under that sha256 holds exactly those bytes.

## The same answer as the TypeScript check

[`packages/check/test/vectors.json`](../../packages/check/test/vectors.json) holds 78 checks with every answer the RPC
nodes gave and what the check said: mainnet and testnet as they really answered about `intents.near`, a lookalike
that does not exist, the arena's drained safe; a provider that lies about a balance, one that names a final head
the chain has not reached, one that serves a chain hours old, one that is down, one that is rate-limited; every
arena state; young accounts, changed code, skipped and garbage-collected blocks. Every reason code and every verdict
is in it. The TypeScript tests replay the file and so does `cargo test` here, and the module must give the same
answer down to the order of the fields. A change to the check that is not carried here fails the build.

One provider alone never makes an `allow`. The two providers must name final heads within 100 blocks of each other,
the check reads at the lower one, and a read only one of them answered is a `warn`
([how, in `packages/check`](../../packages/check/README.md#networks)).

One difference, for the enclave: a node that went down is not asked again during the same check on testnet either
(the TypeScript reader does this on mainnet only). OutLayer ends a run on its second request that it has to cut, so
a hung node must cost one request. The answers come from the same blocks either way, and a vector holds that too.

## How long a request may take

A provider that takes the connection and then says nothing must not hold the run. Left alone, each wait of a
request has the runtime's default limit, which is minutes, and OutLayer's own timer covers only the connection and
the first byte. So the module sets every limit itself, on the request ([`src/http.rs`](src/http.rs)): 3 s to
connect, 5 s to the first byte, 3 s between two pieces of the answer, 8 s for the whole request. OutLayer's worker
honours them ([`worker/src/executor/pinned_http.rs#L41`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/executor/pinned_http.rs#L41),
[`#L117`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/executor/pinned_http.rs#L117)). The manifest gives each host 10 s, more than the module
gives itself, so the module's limits are reached first and OutLayer's own timer, which ends a run after two
requests it had to cut ([`worker/src/executor/wasi_p2.rs#L75`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/executor/wasi_p2.rs#L75)), stays
out of it. A test holds the manifest to that. These limits are read from the worker's code and compiled against
`wasi:http`; no run on OutLayer has exercised them yet.

## Inside

| File | What it does |
| --- | --- |
| `src/lib.rs` | One call: the input, what OutLayer says was attached, the tier, the answer and the message that is signed |
| `src/check.rs` | The signals and the verdict, as `packages/check/src/check.ts` |
| `src/rpc.rs` | The JSON-RPC reader: failover, or cross-check at one block with an archival node per provider |
| `src/list.rs`, `src/network.rs`, `src/account.rs` | The shared lists, the two networks and their endpoints, account ids |
| `src/sign.rs` | The project's ed25519 signature |
| `src/http.rs` | HTTPS over `wasi:http`, with a limit on every wait of a request |
| `src/main.rs` | OutLayer's entry: stdin, stdout, the run's variables |
| `build.rs` | The sha256 of what decides an answer: `module.rules` in every signed message |
| `manifest.json` | Embedded in the wasm: the signing seed joins every run, and the module reaches five RPC hosts, 10 s a request |
| `tests/vectors.rs`, `tests/tiers.rs` | The shared vectors; the tiers, who a payment is taken from, the signature |
| `examples/live.rs` | The same code against live RPC, run natively: `cargo run --example live -- intents.near` |
| `verify.mjs` | Checks a signed answer with Node alone: the key you trust, the rules, the age |
| `publish.mjs`, `live.mjs` | Publishing a version, up to the owner's signatures; the first calls to it |
| `deployment.json` | Where the module is published; the site and the MCP server read it |

```bash
cargo test                  # 47 tests: the rules, the 78 vectors, the tiers, the payment, the signature
node --test verify.test.mjs # 10 tests: the signature again, in Node, and what a forger's key gets
./build.sh                  # the wasm and its sha256
```

`sample.json` names the rules that made it, so it changes with the module: `MASKWARS_WRITE_SAMPLE=1 cargo test`
writes it again, and `cargo test` fails until it is.

## What it does not say

- `allow` means only that no signal against the account was found. The check reads the chain and the shared list. It
  does not cover leaked keys, servers or anything else off chain.
- Two providers that agree can still both be wrong; two independent ones lying the same way at the same block is what
  the cross-check makes hard, not impossible. Testnet is read from one node at a time.
- While one mainnet provider is down, lagging or rate-limited, no mainnet account gets an `allow`: the answer is a
  `warn` that says which reads had one source. That is the price of never taking one provider's word.
- The TEE proves which code read the chain and signed. It does not make the RPC providers honest, and it does not make
  the rules right: read them, they are short.
- A paid call is answered even when no provider could be read: the signed answer then says `warn`,
  `chain_unreadable`, which is the truth of that moment.
- The key belongs to the project. Every version of the module signs with the same key, so the owner of the project
  decides what the key signs, and a signature says which rules made it only through `module.rules` in the message:
  compare it. A caller who wants one exact build pins it with OutLayer's `version_key` (the wasm's sha256).
- The project is `maskwars.near/check` on OutLayer mainnet (`deployment.json`), where payment keys hold real
  stablecoins. Until its first calls record the key there, the address answers nothing and nothing sends an agent to
  it.

## On the site

`maskwars.xyz/api/check` and the `/check` page give the module's signed answer whenever they can
([`apps/web/lib/check-tee.ts`](../../apps/web/lib/check-tee.ts)): the site calls the project with its own payment key
(`OUTLAYER_PAYMENT_KEY` in Vercel), pays the price like any caller, and hands the answer on only after the same three
checks as `verify.mjs` against the key and the rules in `deployment.json`, plus a fourth: the answer is about the
account that was asked. The response carries `tee.signed: true`, the key, the signed message and the signature, so
whoever gets it can verify it again offline. `tee.requested_wasm_sha256` is the build the site asked for with
`version_key`, not a proof of what ran: the site does not read the attestation, and `tee.attestation_url` (kept only on
OutLayer's own API origin, over https) is where OutLayer attests the build.

The module carries the shared list it was built with, and the site reads the current one. So the site asks the TEE
only while `deployment.json` names the rules this checkout builds (`sample.json`); once a safe is added to the list and
no new version is recorded, the site answers itself and says so, rather than sign an answer that could miss a drain.
`cargo test` and the site's tests fail on such a commit too: publish the new build and record it.

When the module is not published yet or was built from another list, the site holds no payment key, the site's budget
for signed answers is spent for the minute, OutLayer does not answer within 6 s, or anything in its answer cannot be
read, the site reads the chain itself with `packages/check` and says so: `tee.signed: false` and `tee.why`. After three
failed runs in a row, or one `402`, an instance asks OutLayer nothing for a minute.

**Before the site pays for signed answers** (`OUTLAYER_PAYMENT_KEY` in Vercel): a Vercel Firewall rule on `/api/check`,
30 a minute per IP, fixed window 60 s. Every signed answer costs the price and the run's compute; the route's own limits
live in one instance's memory only.

## Publishing a version

1. `./build.sh`, `MASKWARS_WRITE_SAMPLE=1 cargo test`, and the wasm goes to the site under its sha256:
   `apps/web/public/outlayer/maskwars-check-<sha256>.wasm`. CI fails a commit whose file is not its own build.
2. Once the site serves the file: `node services/check/publish.mjs`. It builds the module to learn which version this
   checkout is (on a machine without the toolchain it takes the one file in the folder, or `--sha`), checks the file
   and the site, reads from the chain whether the project and its seed exist, and prints the commands the owner of
   the project runs: the one that creates the project `check` (or adds the version to it) and, the first time, the
   one that has OutLayer generate the signing seed inside the TEE (`PROTECTED_CHECK_SEED`, profile `check`, readable
   by any caller's run). A new version keeps the seed, so the key stays the same.
3. `node services/check/live.mjs --record` makes the first calls with a payment key: `about`, a preview, a signed
   verdict asked with nothing attached, a payment of $0.000001, two signed verdicts, and, when a secrets row is named
   for it, a payment written into the caller's own secrets. It checks every signature against the key of `about`,
   and writes the key, the rules and the sha256 into `deployment.json` only if the module OutLayer attests is the
   file of this checkout. From that commit on, the MCP tool `check_account` hands agents this address.

Between creating the project and generating the seed OutLayer runs no call of the project at all: the manifest names
the seed, and a run whose manifest names secrets nobody stored is refused before the module starts
([`worker/src/main.rs#L4613-L4621`](https://github.com/out-layer/outlayer/blob/c30c6675da1b/worker/src/main.rs#L4613-L4621)). So generate the seed right after
the project, and make the first calls after both.
