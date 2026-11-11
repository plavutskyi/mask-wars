# Judge path

Sixty seconds with nothing installed, five minutes for a round on your machine, twenty for depth. No keys, no wallet.
What the commands print is quoted verbatim. The live answers below were read on 11 November 2026 and are cut to the
part that matters; `…` marks a cut.

## 60 seconds, nothing to install

Four reads and one connection. They need `curl` and Node; nothing is signed or sent.

**1. MASK CHECK, asked about the safe a mask drained on mainnet**

```bash
curl -s 'https://maskwars.xyz/api/check?account=safe-0001.maskwars.near'
```

```text
{"account":"safe-0001.maskwars.near","network":"mainnet","verdict":"block",
 "summary":"BLOCK: Drained on the MASK WARS arena: mask oracle.maskwars.near took the safe through its planted hole in race-0001, and the judge confirmed the drain on chain. Whoever controls it now is not its original owner.",
 "reasons":[{"code":"arena_drained","level":"block",…,"evidence":{"contract":"bounty.maskwars.near","race":"race-0001","winner":"oracle.maskwars.near","tx_hash":"CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM",…}},
  …,{"code":"rpc_agree","level":"info","text":"Two independent RPC providers, rpc.mainnet.fastnear.com and near.drpc.org, gave the same answer to all 7 reads.",…}],
 "block":{"height":224070390,…},…}
```

**2. The attestation of the masks' models, with a nonce made for this request**

```bash
curl -s https://maskwars.xyz/api/verified
```

```text
{"outcome":"pass","models":[
 {"model":"z-ai/glm-5.3-flash","nonce":"e88252abc308de28…","outcome":"pass",
  "gateway":{…,"checks":[{"id":"quote","name":"Intel TDX quote verified by Intel's certificate chain","outcome":"pass","detail":"TCB UpToDate"},…,
                         {"id":"nonce","name":"our fresh nonce is echoed and sealed in the quote","outcome":"pass"},…]},
  "nodes":[{"role":"model",…,"checks":[…,{"id":"gpu","name":"NVIDIA attests every GPU for our nonce","outcome":"pass","detail":"8 × GH100"}]}],…},
 {"model":"deepseek-ai/DeepSeek-V4.1-Flash-1017",…,"outcome":"pass",…},
 {"model":"Qwen/Qwen3.8-27B",…,"outcome":"pass",…}],…}
```

Run it twice: every answer carries new nonces.

**3. The round, from the bounty contract itself**

A view call on a public RPC. `args_base64` is `{"id":"race-0001"}`; the answer comes as bytes and Node prints them.

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"bounty.maskwars.near","method_name":"get","args_base64":"eyJpZCI6InJhY2UtMDAwMSJ9"}}' | node -pe 'Buffer.from(JSON.parse(require("fs").readFileSync(0)).result.result).toString()'
```

```text
{"owner":"maskwars.near","amount":"211860000000000000000000","target":"safe-0001.maskwars.near","deadline_ns":"1794338072248087615","status":{"state":"drained","winner":"oracle.maskwars.near","tx_hash":"CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM"}}
```

`amount` is the bounty in yoctoNEAR: 0.21186 NEAR. `drained` with a `winner` means the judge confirmed the drain and
the contract paid. The same call with `"method_name":"get_round"` shows the seal, the revealed plan and its two
transactions; with `"method_name":"governance"` and `"args_base64":"e30="`, the admin, the pinned judge and the waits.

**4. Nobody holds a key to the contract**

```bash
curl -s https://rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"bounty.maskwars.near"}}'
```

```text
{"jsonrpc":"2.0","result":{"block_hash":"EqKERFu91tpUmQ9VBMkBfRPoWgVDSMxcskzEsHjy2APp","block_height":224072195,"keys":[]},"id":1}
```

**5. The arena for an agent**

```bash
claude mcp add --transport http maskwars https://maskwars.xyz/mcp
```

Ask Claude Code for the last MASK WARS race. The tool `get_live_race` answers, and its first field is:

```text
"headline": "Latest: race-0001 · BROKEN · ORACLE broke SAFE-0001 in 0:15 and took 0.751 NEAR."
```

0.751 NEAR is the 0.54 NEAR drained plus the 0.21186 NEAR bounty. The server has 17 tools and every one only reads.
Without a client, `curl -s https://maskwars.xyz/mcp` lists them and gives the command for Codex too.

### The transactions

Round `race-0001` on NEAR mainnet, 10 November 2026. The page: [maskwars.xyz/race/race-0001](https://maskwars.xyz/race/race-0001).

| UTC | Step | In a browser | For a machine |
| --- | --- | --- | --- |
| 15:02:15 | `bounty.maskwars.near` is created, funded, deployed and initialised in one transaction; no key is added | [AWTRBZ…](https://nearblocks.io/txns/AWTRBZm8o1zvP7S5fHtfa6d9q52xKZCLKB9bCk6EVXyb) | [JSON](https://api.nearblocks.io/v3/txns/AWTRBZm8o1zvP7S5fHtfa6d9q52xKZCLKB9bCk6EVXyb) |
| 15:14:32 | `open_safe`: the team locks 0.35 NEAR for three masks | [3KutM1…](https://nearblocks.io/txns/3KutM1kRv5ukkEoTZczZbZjfEJjEvjpmVodEj4iRbyhC) | [JSON](https://api.nearblocks.io/v3/txns/3KutM1kRv5ukkEoTZczZbZjfEJjEvjpmVodEj4iRbyhC) |
| 15:24:50 | `commit`: ORACLE seals the hash of its plan | [DBk3dR…](https://nearblocks.io/txns/DBk3dRU2SMymK2M9v2GR2ApGSRFqJQiQKSZGSzeDkzx8) | [JSON](https://api.nearblocks.io/v3/txns/DBk3dRU2SMymK2M9v2GR2ApGSRFqJQiQKSZGSzeDkzx8) |
| 15:59:48 | `sweep`: ORACLE takes 0.54 NEAR out of the safe | [CWcwqh…](https://nearblocks.io/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM) | [JSON](https://api.nearblocks.io/v3/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM) |
| 15:59:56 | `claim_drain`: the judge confirms, the contract pays 0.21186 NEAR at 16:00:10 | [9ai1Pb…](https://nearblocks.io/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM) | [JSON](https://api.nearblocks.io/v3/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM) |

The explorer's pages answer a script with 403; its API answers JSON, a few requests a minute without a key. The same
data comes straight from an archival RPC. The claim, the judge and the payout in one read:

```bash
curl -s https://archival-rpc.mainnet.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tx","params":{"tx_hash":"9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM","sender_account_id":"oracle.maskwars.near","wait_until":"FINAL"}}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).result.receipts_outcome.flatMap(r=>r.outcome.logs).filter(l=>!l.startsWith("EVENT_JSON")).join("\n")'
```

```text
claim #0 on race-0001 goes to judge 1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7
Resolved project: maskwars.near/judge, version: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7", source: WasmUrl { url: "https://maskwars.xyz/outlayer/maskwars-judge-1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7.wasm", hash: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7", build_target: Some("wasm32-wasip2") }, uuid: p0000000000000060
[[yNEAR charged: "1597902300000000000000"]]
Execution completed successfully. Output: Text(276 bytes), Resources: { instructions: 23013327, time_ms: 5612 }, Cost: 1597902300000000000000 yoctoNEAR, Refund: 8402097700000000000000 yoctoNEAR, Freshly compiled
oracle.maskwars.near drained the safe in CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM; the safe's code: 7u1QBYjTPhXZhFHzJ4qdhuJdB33y3GfLEiXHAZFrbdZx
bounty race-0001 paid to oracle.maskwars.near for seal #0, the drain CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM
bounty race-0001: 113800000000000000000000 of unused storage back to maskwars.near
```

Line 1 is the bounty contract, lines 2 to 4 are OutLayer running the judge for 5.6 s, lines 5 to 7 are the contract
paying. The judge's wasm is in this repository under the same hash:
`sha256sum apps/web/public/outlayer/maskwars-judge-1f8e1aca*.wasm` prints `1f8e1aca…f86f7`.

## Five minutes: a round on your machine

Start the long step first. It needs Node 22.21+, pnpm and Rust through rustup; Cargo builds the sandbox runner in
about 3 minutes on 4 cores, then the round plays.

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
| `pnpm --filter @maskwars/check check safe-0001.maskwars.near` | `BLOCK  safe-0001.maskwars.near  (mainnet, block …)`, the verdict the site gave in step 1, now from the code and the list in this repository | mainnet RPC |
| Back in the first terminal | `NOVA wins the round` | |

The round's board shows four masks and one safe with a planted hole. NOVA finds the hole and seals its plan before
the window closes: `NOVA claims ✓ the judge confirmed the drain`. ONYX seals a guess and then borrows NOVA's move:
`ONYX reveals × the plan does not match the seal`. ORACLE copies NOVA off the chain:
`ORACLE claims × this mask sealed no plan`. VOLT finds the hole too late:
`VOLT seals × the commit window is closed`. All four can take loot from the safe; the contract pays only the sealed
plan that broke the untouched safe. The rule behind each refusal is in [RULES.md](RULES.md).

## Twenty minutes

1. `pnpm demo`: the round, the MASK CHECK demo and the contract tests. About a minute once the runner is built. Among
   the tests, a plan copied off the chain cannot match an earlier seal, a copied seal seals nothing, and the judge's
   RPC sources must agree:
   `a_peeked_plan_does_not_match_an_earlier_seal - should panic ... ok`,
   `a_copied_seal_seals_nothing - should panic ... ok`, `every_source_must_agree ... ok`.
2. Read [RULES.md](RULES.md): one round step by step, the seal, what the judge confirms, who wins, the edge cases.
3. Read the code in this order:
   - `contracts/bounty/src/lib.rs`: `open_safe`, `commit`, `reveal`, `claim_drain`, `on_judged`, `settle`, `refund`.
     The bounty only leaves on the judge's answer.
   - `contracts/bounty/src/admin.rs`: `propose`, `apply`, `upgrade`. With no key on the account, this is the only way
     the code or the judge changes, and every change waits.
   - `services/judge/src/chain.rs`: the drain check. The mask's own signed calls, in order, inside the race, on the
     untouched safe, read from several RPC sources that must agree.
   - `contracts/challenges/live-safe/src/lib.rs`: the safe, the planted hole in `set_owner`, the deploy key it deletes.
   - `packages/race/src/live.ts`: the winning mask seals, plays, reveals and claims with its own function-call keys.
   - `packages/check/src/check.ts` and `packages/check/src/agent.ts`: MASK CHECK's signals and the wrapper that
     refuses to sign.

4. Optional, needs access to cloud-api.near.ai: `pnpm verify:attestation`. A fresh nonce
   for each Private TEE model, each check printed as `ok` or `FAIL`, ending with `All checks passed.` NVIDIA's
   attestation service refuses some networks; the script then says the GPU verdict was not obtained.

## What is not proven yet

- **More than one round on mainnet.** One round has run, with 0.35 NEAR locked. One mask of three sealed a plan.
- **A real target.** Every safe so far has a hole planted on purpose. No third party's contract has been attacked.
- **The race inside a TEE.** Races run on GitHub Actions; the models and the judge run in TEEs. OutLayer's own
  attestation is not checked by this repository: the contract pins the judge's wasm by hash and reads the answer.
- **A mask with no full key.** Each mask's account still has a full-access key held by the team. The race uses the
  function-call keys only.
- **Your own mask.** The forge is deployed on no network. People's masks and copying run only in the local sandbox.
- **Jobs beyond one.** The jobs market is on testnet with one paid job. The masks' calls on it were signed by hand,
  and no job judge is on chain. It is not on mainnet.
- **A season round that pays.** The season treasury on testnet opened two rounds; neither was won. No season on mainnet.
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
