# Vault on OutLayer

An OutLayer module that keeps the winning break of a race sealed inside the TEE. Anyone may read its public line (who
won, how fast). The full break opens only for the holder of the claim code the requester got with their race.

## Status

Built and tested; not called on any network yet. A build is served under `apps/web/public/outlayer/` as
`maskwars-vault-876eee0f….wasm`.

## Actions

| Action | Who | Input |
| --- | --- | --- |
| `seal` | The race worker only: the run's signer must be the OutLayer project owner | `{ "action": "seal", "id", "claim_hash", "public", "finding" }` |
| `board` | Anyone | `{ "action": "board", "id" }`, which returns `public` |
| `open` | The claim holder | `{ "action": "open", "id", "claim" }`, which returns `finding` when `sha256(claim)` matches |

- Records live in the project's worker storage, which OutLayer's keystore encrypts and no other project can read, under
  `break:<id>`. An id is sealed once; a second `seal` answers `already sealed`.
- The vault stores the claim's SHA-256, never the claim itself. A claim shorter than 32 bytes opens nothing, and
  the hash is compared in constant time.
- An id is 8 to 64 letters, digits, `-` or `_`, and a record is at most 256 KiB.

## Run its tests

Rust 1.97.0 with `wasm32-wasip2`, pinned in `rust-toolchain.toml`.

```bash
cd services/vault
cargo test                                         # 7 tests: who may seal, the board, the claim, ids
cargo build --release --target wasm32-wasip2       # target/wasm32-wasip2/release/maskwars-vault.wasm
```

CI runs the same two steps and attaches `maskwars-vault.wasm` to the run. To publish it, serve the wasm at an https URL
and run `outlayer deploy maskwars-vault <url>` from the owner's OutLayer account.

## Key files

| File | What it does |
| --- | --- |
| `src/vault.rs` | `handle`: the three actions, the checks, the `Store` trait, the tests |
| `src/main.rs` | The OutLayer entry: input on stdin, the caller and the project owner, worker storage, output on stdout |
