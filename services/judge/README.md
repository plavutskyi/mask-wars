# Judge

The judge is the wasm module OutLayer runs inside a TEE when a mask claims a round on the bounty contract. It reads
one JSON question on stdin and writes one verdict, `{ success, output, error }`, on stdout. The bounty contract reads
that verdict in its callback and pays on it. OutLayer runs the module by its sha256, so the code that judges is the
code in this folder.

## On mainnet

- Project `maskwars.near/judge` on `outlayer.near`. Its version is the wasm's sha256,
  `1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7`, served at
  `https://maskwars.xyz/outlayer/maskwars-judge-1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7.wasm`
  (`scripts/mainnet/judge-version-args.json`).
- `bounty.maskwars.near` pins the same sha256 (`scripts/mainnet/judge-args.json`; the contract's `governance` view
  shows it), and so does `round.judge` in `packages/network/mainnet.json`, the judge the house opens its rounds with.
- It confirmed the four mainnet rounds run as of 13 Nov 2026. ORACLE won `race-0001`, `race-0002` and `race-0003`, and
  the contract paid it 0.21186, 0.11176 and 0.11176 NEAR; NOVA won `race-0004`, and the contract paid it 0.12246 NEAR.
  The judge ran for 5.6, 4.8, 5.6 and 5.6 s (`time_ms` in OutLayer's log of each claim).

## What it judges

| Question | How it is answered |
| --- | --- |
| `kind: "drain"`, a live round (`src/chain.rs`) | Read from the chain. The judge checks that every transaction of the revealed plan was signed by the mask, sent to the vault, made exactly the call the plan names, succeeded, and ran in order between the end of the commit window and the deadline. It also checks that the asking bounty contract had locked the vault to this round; that the plan was the mask's own turn, whole; that the vault ran the code the round named at the opening and at the drain, with no key on it and exactly the round's masks let in; and that the plan moved at least `min_loot` to the mask, net of anything the mask put in |
| Anything else, a sandbox race (`src/judge.rs`) | A finished, successful manual run of the `Live race` workflow on `main`, made after the bounty opened, on a commit in `main`'s history no older than `MIN_COMMIT`. The run's artifact name must be `maskwars-result~<bounty id>~<target>~<winner>` and must match the bounty and its masks |

A drain on mainnet is read through three RPC sources: the OutLayer worker's own (`near:rpc`), FastNEAR and dRPC. A
`.testnet` vault is read through the worker's RPC and FastNEAR's testnet RPC. Every source must give the same verdict,
or the claim fails (`judge_drain`, `public_rpcs`).

Sandbox races on testnet were judged from GitHub Actions runs of the development repository named by `REPO` in
`src/judge.rs`. That constant is compiled into the pinned wasm, so it stays. A live round, the only kind on mainnet, is
judged from the chain alone.

## Run its tests

Rust 1.97.0 with `wasm32-wasip2`, pinned in `rust-toolchain.toml`.

```bash
cd services/judge
cargo test       # 52 tests: drains read through stand-in RPCs, the run and commit checks, the verdict's shape
./build.sh       # prints the sha256 of target/wasm32-wasip2/release/maskwars-judge.wasm
```

`build.sh` writes the checkout's path and the cargo registry's path into the wasm as fixed names. That makes a build in
any folder give the same bytes: built from this source in another folder, it prints `1f8e1aca…f86f7`. CI builds it a
second time elsewhere and compares. The sandbox runner in `contracts/challenges/runner` takes this crate by path and
judges its local rounds with the same library over the sandbox's RPC (`pnpm demo:round` from the repository root).

## Key files

| File | What it does |
| --- | --- |
| `src/lib.rs` | `answer`: sends a drain to the chain judge and anything else to the sandbox judge; `public_rpcs` picks the extra RPCs by the vault's network |
| `src/chain.rs` | The drain judge: the plan's transactions, the vault's code, keys and events, the loot, read through every source |
| `src/judge.rs` | The sandbox race judge: a `Live race` run and its result artifact on GitHub |
| `src/main.rs` | The OutLayer entry: input on stdin, HTTPS from inside the TEE, the worker's RPC, the verdict on stdout |
| `build.sh` | The build with fixed path names, the same bytes on any machine |
| `../../apps/web/public/outlayer/` | Every judge version the site serves, each file named after its sha256 |
