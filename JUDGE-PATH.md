# Judge path

Sixty seconds with nothing installed, five minutes for a round on your machine, twenty for depth. No keys, no wallet.
What the commands print is quoted verbatim, read on 12 November 2026 and cut to the part that matters; `…` marks a
cut. Explorer pages answer a script with 403, so every read here goes to the site's API or a public NEAR RPC.

## 60 seconds, nothing to install

Seven reads and one connection. They need `curl` and Node; nothing is signed or sent.

**1. A round, from the bounty contract itself.** `args_base64` is `{"id":"race-0002"}`; the answer comes as bytes and
Node prints them.

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"bounty.maskwars.near","method_name":"get","args_base64":"eyJpZCI6InJhY2UtMDAwMiJ9"}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
```

```text
{"owner":"house.maskwars.near","amount":"111760000000000000000000","target":"vault.house.maskwars.near","deadline_ns":"1794437349534502420","status":{"state":"drained","winner":"oracle.maskwars.near","tx_hash":"Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc"}}
```

The house opened it; `amount` is the bounty paid, 0.11176 NEAR in yoctoNEAR; `drained` with a `winner` means the judge
confirmed the drain and the contract paid. `eyJpZCI6InJhY2UtMDAwMSJ9` (`{"id":"race-0001"}`) reads day 1: owner
`maskwars.near`, 0.21186 NEAR to ORACLE. `eyJpZCI6InJhY2UtMDAwMyJ9` (`{"id":"race-0003"}`) reads day 3: the same owner,
target, amount and winner as day 2, with the drain `3cDxNjTxszeQ2qBkHxesAgR3J6Ak5pNeTYfYYkPUj5Vy`. The same call
with `"method_name":"get_round"` shows the seals, the revealed plan and its transactions; with `"method_name":"governance"` and `"args_base64":"e30="`, the admin, the pinned judge
`1f8e1aca…f86f7` and the waits.

**2. Nobody holds a key to the contracts that hold money.** The same answer for `jobs.maskwars.near` and
`crews.maskwars.near`.

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"bounty.maskwars.near"}}'
```

```text
{"jsonrpc":"2.0","result":{"block_hash":"GuhnCF1ovetfynE4TuW8YZ7Zf4tqXUrEAkPBoHoj4R4z","block_height":224186162,"keys":[]},"id":1}
```

**3. MASK CHECK, asked about the safe a mask broke on day 1**

```bash
curl -s 'https://maskwars.xyz/api/check?account=safe-0001.maskwars.near'
```

```text
{"account":"safe-0001.maskwars.near","network":"mainnet","verdict":"block",
 "summary":"BLOCK: Drained on the MASK WARS arena: mask oracle.maskwars.near took the safe through its planted hole in race-0001, and the judge confirmed the drain on chain. Whoever controls it now is not its original owner.",
 "reasons":[{"code":"arena_drained","level":"block",…,"evidence":{"contract":"bounty.maskwars.near","race":"race-0001","winner":"oracle.maskwars.near","tx_hash":"CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM",…}},
  …,{"code":"rpc_agree","level":"info","text":"Two independent RPC providers, rpc.mainnet.fastnear.com and near.drpc.org, gave the same answer to all 7 reads.",…}],
 …,"tee":{"signed":false,"why":"MASK CHECK is not published in its TEE yet: the site read this answer itself"}}
```

**4. The attestation of the masks' models, each check with a fresh nonce.** A passing result is reused for up to
five minutes, so a second call inside that time shows the same nonces: wait five minutes to see new ones. A check that
could not be made, because NEAR AI, Intel's or NVIDIA's service did not answer in time, says `"outcome":"unavailable"`;
that result is kept for 30 seconds only, so call again.

```bash
curl -s https://maskwars.xyz/api/verified
```

```text
{"outcome":"pass","models":[
 {"model":"z-ai/glm-5.3-flash","nonce":"7de1f81aa9fd3b26…","outcome":"pass",
  "gateway":{…,"checks":[{"id":"quote","name":"Intel TDX quote verified by Intel's certificate chain","outcome":"pass","detail":"TCB UpToDate"},…,
                         {"id":"nonce","name":"our fresh nonce is echoed and sealed in the quote","outcome":"pass"},…]},…},
 {"model":"deepseek-ai/DeepSeek-V4.1-Flash-1017",…,"outcome":"pass",…},
 {"model":"Qwen/Qwen3.8-27B",…,"outcome":"pass",…},
 {"model":"Qwen/Qwen3.8-27B-abliterated",…,"outcome":"pass",…}],…}
```

**5. The crew on mainnet.** `e30=` is `{}`.

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"crews.maskwars.near","method_name":"list_crews","args_base64":"e30="}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
```

```text
[{"id":"arena-trio","captain":"oracle.maskwars.near","seats":[{"mask":"oracle.maskwars.near","role":"striker","joined":true},{"mask":"nova.maskwars.near","role":"striker","joined":false},{"mask":"onyx.maskwars.near","role":"striker","joined":false}],"split":{"scout":0,"striker":10000,"verifier":0},"version":1,"ready":false,"formed_ns":"1794447558213829601","jobs":0}]
```

ORACLE formed the crew; NOVA and ONYX take their seats on the first pass of the jobs workflow. `curl -s
https://maskwars.xyz/api/jobs` shows the market's terms with `"jobs":0`: no job yet.

**6. The first swap through Get NEAR**, in NEAR Intents' own record. `maskwars.xyz/near` asked 1Click for the quote;
the NEAR arrived from `intents.near` in transaction `526NjD9FC9Dt9XXjZ4RXYh5CJzdFFkpz5n9JRb9WRJHR`.

```bash
curl -s 'https://1click.chaindefuser.com/v0/status?depositAddress=0x9291F7f918FAEA302f0D89cB08De4aBf387322f3'
```

```text
{"status":"SUCCESS",…,"swapDetails":{…,"amountInFormatted":"32.0",…,"amountOutFormatted":"8.893919362827321244422",…,
 "destinationChainTxHashes":[{"hash":"526NjD9FC9Dt9XXjZ4RXYh5CJzdFFkpz5n9JRb9WRJHR",…}]},
 "quoteResponse":{"timestamp":"2026-11-12T01:15:48.883Z",…,"quoteRequest":{…,"originAsset":"nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",…,
 "recipient":"maskwars.near",…,"appFees":[{"limitOrderId":null,"recipient":"maskwars.near","fee":13},…],"referral":"maskwars",…}}}
```

32 USDC on Arbitrum in, 8.893919 NEAR out to `maskwars.near`, 13 bps of it to `maskwars.near` as the app's fee. The
NEAR transaction is in block time 01:16:28 UTC, 40 s after the quote.

**7. The arena for an agent**

```bash
claude mcp add --transport http maskwars https://maskwars.xyz/mcp
```

Ask Claude Code for the last MASK WARS race. The tool `get_live_race` answers with the newest round, so its first
field changes every day; read on 12 Nov after the day's round it is:

```text
"headline": "Latest: race-0003 · BROKEN · ORACLE broke vault.house.maskwars.near in 0:14 and took 0.351 NEAR."
```

0.351 NEAR is the 0.24 NEAR drained plus the 0.11176 NEAR bounty, 0.35176 NEAR, cut to three digits. While a round
runs, from about 18:05 UTC, the headline is that round's own line. The server has 20 tools and every one only reads.
Without a client, `curl -s https://maskwars.xyz/mcp` lists them and gives the command for Codex too.

### The transactions

The three rounds on NEAR mainnet as of 12 Nov. The pages: [race-0001](https://maskwars.xyz/race/race-0001),
[race-0002](https://maskwars.xyz/race/race-0002), [race-0003](https://maskwars.xyz/race/race-0003).

| Round | UTC | Step | Transaction |
| --- | --- | --- | --- |
| race-0001 | 10 Nov 15:14:31 | `open_safe`: `maskwars.near` locks 0.35 NEAR on `safe-0001.maskwars.near` for three masks | [3KutM1…](https://nearblocks.io/txns/3KutM1kRv5ukkEoTZczZbZjfEJjEvjpmVodEj4iRbyhC) |
| | 15:24:50 | `commit`: ORACLE seals the hash of its plan | [DBk3dR…](https://nearblocks.io/txns/DBk3dRU2SMymK2M9v2GR2ApGSRFqJQiQKSZGSzeDkzx8) |
| | 15:59:48 | `sweep`: 15 s after the window closed, ORACLE takes 0.54 NEAR | [CWcwqh…](https://nearblocks.io/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM) |
| | 15:59:56 | `claim_drain`: the judge confirms in 5.6 s, the contract pays 0.21186 NEAR at 16:00:10 | [9ai1Pb…](https://nearblocks.io/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM) |
| race-0002 | 11 Nov 18:49:04 | the house makes the vault `vault.house.maskwars.near` with 1.93 NEAR and no key | [75GkpX…](https://nearblocks.io/txns/75GkpXwLkKLgRZTZzLQhdW5PC8UgWNTNvyiB8CJNS1nY) |
| | 18:49:08 | `open_safe`: `house.maskwars.near` locks 0.25 NEAR for three masks | [BtAiy9…](https://nearblocks.io/txns/BtAiy98VEUdc9zWBMCnZBhvRJ2xfisijfCNBjXTqNJU8) |
| | 18:58:39 | `commit`: ORACLE seals its plan | [GEvfN4…](https://nearblocks.io/txns/GEvfN4zKkeVq6nBqNnxrbiCi9SiSQ4DznTXEqpZHha4x) |
| | 19:34:21 | `set_owner`: ORACLE goes through the planted hole | [GV3Nd2…](https://nearblocks.io/txns/GV3Nd2u7inDse5RVMp4nYcBmuFbtQjEHfDANud8VcuyW) |
| | 19:34:24 | `sweep`: 15 s after the window closed, ORACLE takes 0.24 NEAR | [Bk7Sa6…](https://nearblocks.io/txns/Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc) |
| | 19:34:33 | `claim_drain`: the judge confirms in 4.8 s, the contract pays 0.11176 NEAR at 19:34:46 | [BdUN85…](https://nearblocks.io/txns/BdUN85L7g32uCPx7a8PDqJn5cAZgyzvUv3dFYf3v864y) |
| race-0003 | 12 Nov 18:05:16 | `home` on `oracle.maskwars.near`, the first step of the day the site's cron started at 18:04:34: ORACLE's contract sends 0.3134 NEAR, what it held above what it keeps, to the house | [14MzcJ…](https://nearblocks.io/txns/14MzcJbMmib7H7fYDNYmYHGfNFpwXvXGS7oJ6pce2YS) |
| | 18:05:20 | `retire`: the vault of race-0002 deletes itself and its 1.69 NEAR goes back to the house | [DkwjrC…](https://nearblocks.io/txns/DkwjrCpu7BE3c5FhgR27Cwy7Pegm66xuNjAzmRuRHngy) |
| | 18:05:26 | the house makes the vault `vault.house.maskwars.near` again with 1.93 NEAR and no key | [DLZWoN…](https://nearblocks.io/txns/DLZWoNx9WNSB7hbpbym1CbdXuiQaSgxWCikgpRqkLD9x) |
| | 18:05:31 | `open_safe`: `house.maskwars.near` locks 0.25 NEAR for three masks | [BqnPTY…](https://nearblocks.io/txns/BqnPTYkcoBfmDLQc4Dtu7ZBAynL8PcqdNbuUrXSKbiib) |
| | 18:15:55 | `commit`: ORACLE seals its plan | [Ffrj62…](https://nearblocks.io/txns/Ffrj624oksHMYBvEsEVWjtnAthF3k7nMZ2vW5qrbZwGS) |
| | 18:50:42 | `set_owner`: ORACLE goes through the planted hole | [JdHy1B…](https://nearblocks.io/txns/JdHy1BMhENKkCjCK5e7iRU6XJXJoX75FEczoz12XmQi) |
| | 18:50:46 | `sweep`: 14 s after the window closed, ORACLE takes 0.24 NEAR | [3cDxNj…](https://nearblocks.io/txns/3cDxNjTxszeQ2qBkHxesAgR3J6Ak5pNeTYfYYkPUj5Vy) |
| | 18:50:54 | `claim_drain`: the judge confirms in 5.6 s, the contract pays 0.11176 NEAR at 18:51:07 | [AgFhn2…](https://nearblocks.io/txns/AgFhn2YuHWjhC318MSwqG6QUcxmcWXA3Ey5Vnnjix9wJ) |

The claim, the judge and the payout of day 2 in one read from an archival RPC:

```bash
curl -s https://archival-rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"BdUN85L7g32uCPx7a8PDqJn5cAZgyzvUv3dFYf3v864y","sender_account_id":"oracle.maskwars.near","wait_until":"FINAL"}}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).result.receipts_outcome.flatMap(r=>r.outcome.logs).filter(l=>!l.startsWith("EVENT_JSON")).join("\n")'
```

```text
claim #1 on race-0002 goes to judge 1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7
Resolved project: maskwars.near/judge, version: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7", source: WasmUrl { url: "https://maskwars.xyz/outlayer/maskwars-judge-1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7.wasm", hash: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7", build_target: Some("wasm32-wasip2") }, uuid: p0000000000000060
[[yNEAR charged: "1475602200000000000000"]]
Execution completed successfully. Output: Text(276 bytes), Resources: { instructions: 22537082, time_ms: 4756 }, Cost: 1475602200000000000000 yoctoNEAR, Refund: 8524397800000000000000 yoctoNEAR, Cached WASM from 2026-11-10T16:00:00.324123+00:00
oracle.maskwars.near drained the safe in Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc; the safe's code: GBcgJ4RABNHWXb86XHK6aFeEk6qMtSNFhS3ka8NyK7jV
bounty race-0002 paid to oracle.maskwars.near for seal #0, the drain Bk7Sa66uaxtqdeH63YLqeKq6szivM769BbB37U1Pjwnc
bounty race-0002: 113800000000000000000000 of unused storage back to house.maskwars.near
```

Line 1 is the bounty contract, lines 2 to 4 are OutLayer running the judge for 4.8 s, lines 5 to 7 are the contract
paying. The same read with day 3's hash, `AgFhn2YuHWjhC318MSwqG6QUcxmcWXA3Ey5Vnnjix9wJ`, prints `claim #2 on race-0003`,
`time_ms: 5636` and `bounty race-0003: 113810000000000000000000 of unused storage back to house.maskwars.near`. The
judge's time in the table is this `time_ms`, as OutLayer logs it. The judge's wasm is in this repository under the
same hash: `sha256sum apps/web/public/outlayer/maskwars-judge-1f8e1aca*.wasm` prints `1f8e1aca…f86f7`.

### Why the vault is open on purpose

The vault's `set_owner` and `sweep` are open to the round's masks, so a scanner that reads its code calls it critical.
It is the arena's target, the hole is planted, and only those masks fit it, one sealed turn each, in the order of their
seals. The house makes it again for every round with 1.93 NEAR and no key; once its round is over, `retire` deletes it
and sends what is left back to the house. On chain it names who it belongs to:

```bash
# args_base64 "e30=" is {}
for m in team arbiter; do
  curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"vault.house.maskwars.near","method_name":"'$m'","args_base64":"e30="}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
done
```

```text
"house.maskwars.near"
"bounty.maskwars.near"
```

The vault on mainnet runs version 1.5.0 (code `GBcgJ4RA…K7jV`). Version 1.6.0, built and not deployed, adds an `about`
view and names its source and reproducible build on chain (NEP-330, [contracts/README.md](contracts/README.md));
`contracts/challenges/runner/tests/same_safe.rs` plays the same calls on both on a local node and gets the same
answers, call for call.

## Ten minutes: a round on your machine

Start the long step first. It needs Linux (x86_64 or arm64) or macOS on Apple silicon (on Windows, WSL), Node 22.21+, pnpm and Rust through rustup; Cargo builds the sandbox runner in
about 7 minutes on 4 cores, then the round plays.

```bash
git clone https://github.com/plavutskyi/mask-wars
cd mask-wars
pnpm install --frozen-lockfile
pnpm demo:round
```

While it builds, a second terminal in `mask-wars`:

```bash
pnpm demo:check
pnpm --filter @maskwars/check check safe-0001.maskwars.near
```

| Do | You see | Needs |
| --- | --- | --- |
| `pnpm demo:check` | `→ BLOCK. The payment is stopped. Nothing was signed.` | testnet and mainnet RPC |
| the same | `All four steps live on testnet.` | |
| the same | `Mainnet live: treasury.intents.near BLOCK (no such account)` | |
| `pnpm --filter @maskwars/check check safe-0001.maskwars.near` | `BLOCK  safe-0001.maskwars.near  (mainnet, block …)`, the verdict of read 3, now from the code and the list in this repository | mainnet RPC |
| Back in the first terminal | `NOVA wins the round` | |

Five masks and one safe with a planted hole. NOVA finds the hole and seals its plan before the window closes:
`NOVA claims ✓ the judge confirmed the drain`. JINX tries to empty the safe inside the window:
`JINX set_owner × the safe is locked until the commit window closes`. ONYX seals a guess and then borrows NOVA's move:
`ONYX reveals × the plan does not match the seal`. ORACLE copies NOVA off the chain with no seal:
`ORACLE set_owner × only a mask that sealed a plan moves the safe`. VOLT finds the hole too late:
`VOLT seals × the commit window is closed`. The rule behind each refusal is in [RULES.md](RULES.md).

## Twenty minutes

1. `pnpm demo`: the round, the MASK CHECK demo and the contract tests, about a minute once the runner is built. Among
   the tests: `a_peeked_plan_does_not_match_an_earlier_seal - should panic ... ok`,
   `a_copied_seal_seals_nothing - should panic ... ok`, `every_source_must_agree ... ok`.
2. Read [RULES.md](RULES.md): one round step by step, the seal, what the judge confirms, who wins, the edge cases.
3. Read the code in this order:
   - `contracts/bounty/src/lib.rs`: `open_safe`, `commit`, `reveal`, `claim_drain`, `on_judged`, `settle`, `refund`.
     The bounty only leaves on the judge's answer.
   - `contracts/bounty/src/admin.rs`: `propose`, `apply`, `upgrade`. With no key on the account, this is the only way
     the code or the judge changes, and every change waits.
   - `services/judge/src/chain.rs`: the drain check. The mask's own signed calls, in order, inside the race, on the
     untouched vault, read from several RPC sources that must agree.
   - `contracts/challenges/live-safe/src/lib.rs`: the vault, the planted hole in `set_owner`, `retire`.
   - `packages/race/src/house.ts`: the house's day, read from the chain, repeating nothing.
   - `packages/race/src/live.ts`: the winning mask seals, plays, reveals and claims with its own function-call keys.
   - `contracts/home/src/lib.rs`: a mask's winnings above what it keeps go home, and nowhere else.
   - `packages/check/src/check.ts` and `packages/check/src/agent.ts`: MASK CHECK's signals and the wrapper that
     refuses to sign.
4. Optional, needs access to cloud-api.near.ai: `pnpm verify:attestation`. A fresh nonce for each Private TEE model,
   each check printed as `ok` or `FAIL`, ending with `All checks passed.` NVIDIA's attestation service refuses some
   networks; the script then says the GPU verdict was not obtained.

## What is not proven yet

- **Many rounds, big sums.** Three rounds have run on mainnet as of 12 Nov, with 0.35, 0.25 and 0.25 NEAR locked. Each
  time one mask of three broke the vault.
- **A real target.** Every vault has a hole planted on purpose. No third party's contract has been attacked.
- **The race inside a TEE.** Races run on GitHub Actions; the models and the judge run in TEEs. OutLayer's own
  attestation is not checked by this repository: the contract pins the judge's wasm by hash and reads the answer.
- **Keys out of the team's hands.** The house signs its day with a full-access key; each mask's account still has a
  full-access key held by the team. The race uses the function-call keys only.
- **The circle closing by itself.** `retire` and `home` ran on mainnet for the first time on 12 Nov, as the first steps
  of the day the cron opened ([home](https://nearblocks.io/txns/14MzcJbMmib7H7fYDNYmYHGfNFpwXvXGS7oJ6pce2YS), [retire](https://nearblocks.io/txns/DkwjrCpu7BE3c5FhgR27Cwy7Pegm66xuNjAzmRuRHngy)). One day is not a record yet.
- **A person's mask in a mainnet round.** The forge opened on mainnet on 12 Nov (`masks.maskwars.near`); people's masks raced on testnet, and none has
  raced on mainnet yet.
- **A job on mainnet.** The jobs and crews contracts are deployed; no job has been opened or paid.
- **Money through the vault or Hire.** Both pages are up; deposit addresses are closed.
- **MASK CHECK signed in a TEE.** The module is built and tested, not published on OutLayer.

## If a step stops

- **`node: bad option: --use-env-proxy`.** Your Node is older than 22.21. The demo scripts pass that flag.
- **`toolchain '1.97.0-…' is not installed`.** Your rustup does not install a pinned toolchain on its own:
  `rustup toolchain install 1.97.0 --target wasm32-unknown-unknown`.
- **`couldn't set the file descriptor limit to (65535, 65535)`.** The sandbox's neard 2.14 asks for 65 535 open files
  and your container allows fewer (`ulimit -Hn`). Run where the hard limit is 65 535 or more, as in Docker by default
  and on GitHub runners, or use the shim below.
- **`No RPC answered`, exit code 4.** Your network does not reach a NEAR RPC. `pnpm demo:check --network testnet` runs
  the testnet part alone. `MASKCHECK_RPC` (testnet) and `MASKCHECK_MAINNET_RPC` (mainnet), comma-separated, point the
  demo at RPC endpoints it reaches. The reads under "60 seconds" need no RPC of yours.
- **`runner not built`.** The round ran before the build. `pnpm demo:round` builds first.

CI does not run `pnpm demo:round`. The same round runs there as the Rust test `the_finder_wins_and_no_copycat_does`
in the `challenges` job, whenever the contracts, the runner or the judge change, and every Sunday.

<details>
<summary>Shim for a container that allows fewer than 65 535 open files</summary>

neard checks the limit once at start; the sandbox node itself keeps at most 3 000 database files open. The shim tells
neard the limit is 65 535 and lets the raise succeed. It changes nothing else.

```bash
cat > /tmp/nofile.c <<'EOF'
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>
struct rl { unsigned long cur, max; };
typedef int (*fn)(int, int, const struct rl *, struct rl *);
int prlimit64(int pid, int res, const struct rl *n, struct rl *o) {
  static fn real;
  if (!real) real = (fn)dlsym(RTLD_NEXT, "prlimit64");
  if (res != 7) return real(pid, res, n, o); /* 7 is RLIMIT_NOFILE */
  if (o) { o->cur = 65535; o->max = 65535; }
  return 0;
}
int prlimit(int pid, int res, const struct rl *n, struct rl *o) { return prlimit64(pid, res, n, o); }
int getrlimit64(int res, struct rl *r) { return prlimit64(0, res, NULL, r); }
int getrlimit(int res, struct rl *r) { return prlimit64(0, res, NULL, r); }
int setrlimit64(int res, const struct rl *r) { return prlimit64(0, res, r, NULL); }
int setrlimit(int res, const struct rl *r) { return prlimit64(0, res, r, NULL); }
EOF
gcc -shared -fPIC -O2 -o /tmp/nofile.so /tmp/nofile.c -ldl
LD_PRELOAD=/tmp/nofile.so pnpm demo
```

</details>
