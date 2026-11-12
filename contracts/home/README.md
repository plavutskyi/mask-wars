# home

The code on the arena's own masks, NOVA, ONYX and ORACLE. It has one method, `home()`, with no arguments, and anyone may
call it. It sends everything the mask holds above 0.4 NEAR plus the stake of its own storage to the house, and to no
other account. That way the NEAR of the daily round goes in a circle: house, vault, the mask that wins, house.

## On mainnet

- Deployed on `nova.maskwars.near`, `onyx.maskwars.near` and `oracle.maskwars.near`. The code hash is
  `59bFq9xjFEAGxJBJwop9RApoW1KcQRG8szQiH4hDmz9f`, the `home_code` of `packages/network/mainnet.json`. The same 1,349
  bytes are served as
  `apps/web/public/contracts/maskwars-home-mainnet-3da2209123ce59600ef36fa87dd3130ba51054fd121d4c07ceff8ca058ffe95a.wasm`,
  a file named after its sha256. CI checks that this file hashes to `home_code`. Each mask locks about 0.0135 NEAR of
  its own balance as the storage stake for the code.
- That code is home 1.0.0, whose only method is `home`. This folder holds 1.1.0, which adds the read-only
  `contract_source_metadata` (NEP-330) and leaves `home()` and its event unchanged. Its bytes are different and are not
  on the masks yet.
- As of 12 Nov 2026, nobody has called `home()` on mainnet. The first call will be the first step of the house's next
  daily round: `packages/race/src/house.ts` calls `home()` only on a mask whose code hash is `home_code`.
- The masks keep their keys. The function-call keys they race with on the bounty contract and the vault work as
  before, because code on an account changes what calls *to* it do, not what the account signs.

## What `home()` does

| Case | Result |
| --- | --- |
| The balance is above `0.4 NEAR + storage_usage × 10^19` yoctoNEAR | One transfer of the difference to `house.maskwars.near`, and the event `EVENT_JSON:{"standard":"maskwars_home","version":"1.0.0","event":"home","data":{"to":"house.maskwars.near","amount":"<yoctoNEAR>"}}` |
| At or below that line | Nothing is sent. The log says `home: nothing above the 0.4 NEAR this mask keeps besides its storage` |
| A deposit is attached | It adds to the balance and goes home with the rest |
| The transfer fails | NEAR refunds it to the mask |

The house is compiled in. `--features mainnet` sends to `house.maskwars.near` and `--features testnet` sends to
`house.tinygif8324.testnet`, and a build must name exactly one of the two. The code reads no arguments, stores nothing
and touches no keys. It is built without near-sdk and without `std`, and the only host functions it calls are
`account_balance`, `storage_usage`, `promise_batch_create`, `promise_batch_action_transfer`, `log_utf8` and
`value_return`.

## Run its tests

Rust 1.97.0 with `wasm32-unknown-unknown`, pinned in `rust-toolchain.toml`.

```bash
cd contracts/home
cargo test --locked --features mainnet    # the threshold, overflow, the event, NEP-330, the house and 0.4 NEAR of mainnet.json
cargo test --locked --features testnet    # the same against testnet.json
./build.sh                                # target/wasm/maskwars_home-{mainnet,testnet}.wasm and their sha256, the same in any folder
cd ../challenges && cargo test -p race-runner --test home   # on a local NEAR node; builds the sandbox runner first
```

The sandbox test checks that a mask keeps exactly 0.4 NEAR and its storage, to the yoctoNEAR. It also checks that a
stranger's call sends only to the house, and that a mask running `home` with only its function-call keys still seals,
plays, reveals and claims its rounds, with its winnings going home. A deploy uses the reproducible build:
`contracts/build-source.sh home` (see `../README.md`, "Source on chain").

## Key files

| File | What it does |
| --- | --- |
| `src/lib.rs` | `home()`, `above()` (what goes home), the event, `contract_source_metadata`, the unit tests |
| `build.rs` | Writes the NEP-330 JSON at build time; the same file serves `contracts/house` and `contracts/masks/mask` |
| `build.sh` | The plain build for both networks, with fixed flags, and the sha256 of each |
| `Cargo.toml` | The `mainnet` and `testnet` features, and the cargo-near image of the reproducible build |
| `../challenges/runner/tests/home.rs` | `home` on a mask, on a real local node |
| `../../scripts/mainnet/home-deploy.mjs` | Prints the three deploy commands, each signed by that mask's own full key; it refuses unless the served file hashes to `home_code` |
| `../../packages/network/mainnet.json` | `home_code`, `house` and `round.mask_keep`, which the unit tests compare with the code |
