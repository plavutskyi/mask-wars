# Contracts

Every contract MASK WARS puts on NEAR, each in its own folder with its own README and tests.

| Contract | Folder | Version here | On mainnet today |
| --- | --- | --- | --- |
| The vault: the arena's target, made again for every round | [`challenges/live-safe`](challenges/live-safe) | 1.6.0 | `vault.house.maskwars.near` runs 1.5.0 (`GBcgJ4RA…K7jV`); 1.6.0 is not deployed |
| The bounty contract: sealed rounds, the judge in a TEE, the payout | [`bounty`](bounty) | 1.0.0 | `bounty.maskwars.near`, no key, an earlier build |
| The house: the daily round's steps for a key that can sign nothing else | [`house`](house) | 1.2.0 | not deployed: `house.maskwars.near` has no code and signs its day with a full key |
| home: a mask's winnings go back to the house, and only there | [`home`](home) | 1.1.0 | `nova`, `onyx`, `oracle.maskwars.near` run 1.0.0 (`59bFq9xj…mz9f`), which has `home` and no NEP-330 view |
| The season treasury | [`season`](season) | 1.0.0 | not deployed (testnet: `season.tinygif8324.testnet`) |
| The jobs market and mask crews | [`jobs`](jobs), [`crews`](crews) | 1.0.0 | `jobs.maskwars.near`, `crews.maskwars.near`, no key, an earlier build |
| The mask factory and the code on every forged mask | [`masks/factory`](masks/factory), [`masks/mask`](masks/mask) | 2.0.0 | `masks.maskwars.near`, no key, since 12 Nov 2026: the bytes `scripts/mainnet/forge-wasm.json` pins (`GsS7EwaE…pWsv`), an earlier build; the mask code is published as a global contract (sha256 `35b5471c…861a`). No mask forged as of 12 Nov |

"An earlier build": the code on chain is not the reproducible build that names its source, so its
`contract_source_metadata` answers version 0.1.0 with `"link":null,"build_info":null`. That is every contract on
mainnet today (12 Nov 2026): the bounty contract, jobs, crews, the factory and the vault.

## Source on chain

Built as below, each contract answers `contract_source_metadata` (NEP-330): its version, a link to its source at the
exact commit of the public repository it was built from, and how to build the same bytes again. nearblocks shows that
link on the account's page, and anyone can rebuild the code and compare. No contract on mainnet carries it yet: the
answer below is what the vault 1.6.0 gives once it is deployed, and today the same call on mainnet answers
`{"version":"0.1.0","link":null,"standards":[{"standard":"nep330","version":"1.3.0"}],"build_info":null}`.

```bash
near contract call-function as-read-only vault.house.maskwars.near contract_source_metadata json-args '{}' network-config mainnet now
```

```json
{
  "version": "1.6.0",
  "link": "https://github.com/plavutskyi/mask-wars/tree/<commit>",
  "standards": [{ "standard": "nep330", "version": "1.3.0" }],
  "build_info": {
    "build_environment": "sourcescan/cargo-near:0.22.0-rust-1.97.0@sha256:b193c8640a27172f83136a0f0aab2a9bf9d09f6ba0e6afd187addfaa9b92bae0",
    "build_command": ["cargo", "near", "build", "non-reproducible-wasm", "--locked", "--no-abi"],
    "contract_path": "contracts/challenges/live-safe",
    "source_code_snapshot": "git+https://github.com/plavutskyi/mask-wars?rev=<commit>",
    "output_wasm_path": "/home/near/code/contracts/challenges/target/near/live_safe/live_safe.wasm"
  }
}
```

- **Where it comes from.** The version and the link are the crate's `version` and `repository`. `build_info` is
  written only by `cargo near build reproducible-wasm`, which builds in the image each `Cargo.toml` pins under
  `[package.metadata.near.reproducible_build]`, from a clean clone at HEAD. near-sdk writes the JSON for the contracts
  on its `#[near]` struct; house, home and the mask's code have none, and their `build.rs` (one file, the same in the
  three, a test of the house holds them equal) writes it the same way. In those three it is a view of a constant: it
  reads nothing and moves nothing.
- **What a deploy uses.** Only the reproducible build, made in a clone of the public repository at a commit pushed
  there, so the link opens: `contracts/build-source.sh` builds every contract and checks each file
  (`node contracts/nep330.mjs --check`). Then `node scripts/mainnet/source.mjs out/source` checks the files again,
  puts the vault and home where the house's day and the site read them, writes the house's terms with the vault's new
  code and prints the owner's steps in their order (scripts/mainnet/README.md).
- **What CI checks.** The `source` job runs the same script on every change to a contract: each file must name its
  version, the commit and how to build it. Those bytes name a commit of this repository, so they are a check and
  never a deploy. `build.sh` of house, home and jobs stays the quick build anyone runs: the same bytes in any folder,
  with `build_info: null`.

```bash
contracts/build-source.sh                 # in the public clone: out/source/<name>.wasm and the check
contracts/build-source.sh live-safe home  # only these
node contracts/nep330.mjs <file.wasm>     # what any wasm says about its source
```

## The vault, open on purpose

`sweep` and `set_owner` of the vault are open to the masks of its round: that is the target the masks race to break,
and a scanner reads it as a hole. It is one, planted, and only for them. The vault says so itself: `about` returns
*"MASK WARS arena target. Funded only by MASK WARS. Only the masks of this round can open it. After the round the rest
goes home."* Version 1.6.0 adds `about` and the metadata and changes no behaviour:
`challenges/runner/tests/same_safe.rs` runs the same calls on the code on mainnet and on 1.6.0 on a real local node
and gets the same answers, panics, events and transfers, call for call.
