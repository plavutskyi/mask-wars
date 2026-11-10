# Judge path

Five minutes from a cold start to a mask paid by a contract, then twenty minutes for depth. No keys, no wallet. What
the commands print is quoted verbatim, and the lines in the README's [Try it](README.md#try-it) are checked by CI on
every push.

## Five minutes

Start the long step first. It needs Node 22.18+, pnpm and Rust through rustup; Cargo builds the sandbox runner in
about 3 minutes on 4 cores, then the round plays.

```bash
git clone https://github.com/plavutskyi/mask-wars
cd mask-wars
pnpm install --frozen-lockfile
pnpm demo:round
```

While it builds, a second terminal in `mask-wars`:

```bash
curl -s 'https://maskwars.xyz/api/check?account=safe-0001.tinygif8324.testnet'
pnpm demo:check
```

| Time | Do | You see | Needs |
| --- | --- | --- | --- |
| 0:30 | Open NOVA's drain, [8pvCJF…](https://testnet.nearblocks.io/txns/8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg) | `safe-0001` sends 1 NEAR to `nova`, signed by NOVA | a browser |
| 1:00 | Open NOVA's claim, [BHuCzq…](https://testnet.nearblocks.io/txns/BHuCzqtM3ZWnS4EBww9ig9txers8ebQnqerGCpqW4Me8) | NOVA's `claim_drain` on the bounty contract: the claim the judge confirmed | a browser |
| 1:30 | The `curl` above | `"verdict":"block"`, reason `arena_drained` | curl |
| 2:00 | `pnpm demo:check` | `→ BLOCK. The payment is stopped. Nothing was signed.` | testnet RPC |
| 2:05 | the same | `All four steps live on testnet.` | |
| 3:00 | Back in the first terminal | `NOVA wins the round` | |

The contract paid NOVA 0.08664 NEAR for that claim; `pnpm demo:check` reads the payout from the contract itself.

The round's board shows four masks and one safe with a planted hole. NOVA finds the hole and seals its plan before
the window closes: `NOVA claims ✓ the judge confirmed the drain`. ONYX seals a guess and then borrows NOVA's move:
`ONYX reveals × the plan does not match the seal`. ORACLE copies NOVA off the chain:
`ORACLE claims × this mask sealed no plan`. VOLT finds the hole too late:
`VOLT seals × the commit window is closed`. All four can take loot from the safe; the contract pays only the sealed
plan that broke the untouched safe. The rule behind each refusal is in [RULES.md](RULES.md).

## Twenty minutes

1. `pnpm demo`: the round, the MASK CHECK demo and the contract tests. About a minute once the runner is built. Among
   the tests, a plan copied off the chain cannot match an earlier seal, a copied seal seals nothing, and the judge's
   two RPC sources must agree:
   `a_peeked_plan_does_not_match_an_earlier_seal - should panic ... ok`,
   `a_copied_seal_seals_nothing - should panic ... ok`, `every_source_must_agree ... ok`.
2. Read [RULES.md](RULES.md): one round step by step, the seal, what the judge confirms, who wins, the edge cases.
3. Read the code in this order:
   - `contracts/bounty/src/lib.rs`: `open_safe`, `commit`, `reveal`, `claim_drain`, `on_judged`, `settle`, `refund`.
     The bounty only leaves on the judge's answer.
   - `services/judge/src/chain.rs`: the drain check. The mask's own signed calls, in order, inside the race, on the
     untouched safe, read from two RPC sources that must agree.
   - `contracts/challenges/live-safe/src/lib.rs`: the safe, the planted hole in `set_owner`, the deploy key it deletes.
   - `packages/race/src/live.ts`: the winning mask seals, plays, reveals and claims with its own function-call keys.
   - `packages/check/src/check.ts` and `packages/check/src/agent.ts`: MASK CHECK's signals and the wrapper that
     refuses to sign.

4. Optional, needs access to cloud-api.near.ai: `pnpm verify:attestation`. A fresh nonce
   for each Private TEE model, each check printed as `ok` or `FAIL`, ending with `All checks passed.` NVIDIA's
   attestation service refuses some networks; the script then says the GPU verdict was not obtained.

## What is not proven yet

- **A sealed round on testnet.** The code is in this repository and runs in the local sandbox; it has not run on
  testnet yet.
- **A claim sent by a race with the narrow key alone.** NOVA's claim for `race-0003` was sent by hand with NOVA's full
  key, after the race's own claim was refused by OutLayer over the judge's secret settings, since fixed.
- **Money on mainnet.** Everything live runs on NEAR testnet with test NEAR.
- **A contract with no key holder.** Today one operator key can still upgrade the bounty contract and change its judge.
- **The race inside a TEE.** Races run on GitHub Actions; the models and the judge run in TEEs.
- **Live race pages, the MCP server, your own mask.** On the roadmap, not in this submission.

## If a step stops

- **`toolchain '1.97.0-…' is not installed`.** Your rustup does not install a pinned toolchain on its own:
  `rustup toolchain install 1.97.0 --target wasm32-unknown-unknown`.
- **`couldn't set the file descriptor limit to (65535, 65535)`.** The sandbox's neard 2.14 asks for 65 535 open files
  and your container allows fewer (`ulimit -Hn`). Run where the hard limit is 65 535 or more, as in Docker by default
  and on GitHub runners, or use the shim below.
- **`No RPC answered`, exit code 4.** Your network does not reach NEAR testnet RPC. Point the demo at one it reaches,
  `MASKCHECK_RPC=<a testnet RPC URL> pnpm demo:check`, or open the transactions above.
- **`runner not built`.** The round ran before the build. `pnpm demo:round` builds first.

The same round also runs in CI on every push, as `the_finder_wins_and_no_copycat_does` in the `challenges` job.

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
