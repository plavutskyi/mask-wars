# House contract

The daily round's seven steps, on the house's own account (`house.maskwars.near`), for a function-call key that can
sign nothing else. Until now the `Season` workflow signed each step of the house's day (packages/race/src/house.ts)
with a full key of the house kept in GitHub (`HOUSE_KEY`): whoever held it could spend everything the house holds.
With this contract deployed on the house, the workflow holds a function-call key for these seven methods instead, and
each method does one step with terms the contract pins. house.ts sees the contract on the house (its account has code
and answers `day`) and sends every step through it.

> **Do not deploy 1.0.0.** It could not bring the masks' winnings home (no `home`), and a leaked day's key could
> burn each day's slot with an `open_round` before the vault was made. Deploy 1.2.0, the reproducible build that names
> its source (contracts/README.md, "Source on chain"): `contracts/build-source.sh house` in the public clone.

| Method | Arguments | What it does | Bounds |
| --- | --- | --- | --- |
| `home` | `{"mask"}` | `home()` on one of the round's masks (contracts/home): everything it holds above what it keeps comes to the house | only a mask in `masks`; nothing attached; exactly 10 TGas |
| `unstick` | `{"id", "claim"}` | the bounty contract's `unstick` (anyone may call it) | nothing attached |
| `settle` | `{"id"}` | the bounty contract's `settle`: pays the round's confirmed winner | nothing attached |
| `refund` | `{"id"}` | the bounty contract's `refund`: the bounty nobody won back to the house | nothing attached |
| `retire` | none | the vault's `retire`: it deletes itself and its whole balance comes home | the vault refuses while its round can be played; from then on no vault counts as made in the slot |
| `make_vault` | the vault's wasm, as the call's raw input | creates the vault with the pinned NEAR, deploys the code, `new` with the pinned arguments, no key added; `on_made` records the slot it was made in | the wasm must hash to `safe_code`; the house keeps the deposit and the day's gas after it |
| `open_round` | `{"id"}` | `open_safe` on the bounty contract with every term pinned and the pinned deposit | `race-<n>` after the last; once per slot; only on a vault `make_vault` made in this slot; only while a round opened now ends, its claim grace included, before the next slot |

The arguments, gas and deposits are those house.ts sends (`vaultInit`, `roundArgs`, `houseStepTx`). An `open_safe` the
bounty contract refuses gives the deposit back, and `on_opened` gives the slot back. The bounty contract takes the
deposit even for a vault that will not arm and returns it only later, in its `on_armed`: so `open_round` opens only
on a vault made in the same slot, never on yesterday's armed vault or on none. The terms change only with
`configure` and one yoctoNEAR, which a function-call key cannot attach; `configure` also sets `last_round` and
`last_slot_ns`, and new terms clear the record of the vault made under the old ones. Views: `config`, `day` (the last
round, its slot, the slot of the vault made last), `now` (the slot, whether it has its round, whether its vault is
made, until when one may open, the next round's id, what the house holds free), `version`, and
`contract_source_metadata` (NEP-330: the version, the commit of the public repository and how to build the code again).

No SDK: the contract talks to NEAR's host functions directly (`near-sys`), with its own small JSON reader and writer,
so its code is 31 KB in the reproducible build (1.2.0) and locks about 0.31 NEAR of the house's balance, where the same contract on near-sdk built to 172 KB.
The rules (`src/rules.rs`, `src/json.rs`) are plain Rust with native tests; the contract (`src/contract.rs`) runs on a
real local node in `contracts/challenges/runner/tests/house.rs`: two days of the circle on the function-call key alone,
yesterday's armed vault and a vault made and retired at once refused a round, `home` bringing a mask's winnings to the
house under its real name, and everything the key cannot do.

```bash
cargo test                 # the rules
contracts/house/build.sh   # the same bytes in any folder; the deploy's code is the reproducible build (contracts/README.md)
cd ../challenges && cargo test -p race-runner --test house   # the contract on a local node
```

Deploying 1.2.0: the owner's full key deploys the code and calls `new` with the terms of `packages/network` in one
transaction, then adds a function-call key for the seven methods with an allowance of 0.3 NEAR (about a week of days;
a new key replaces it when it runs out). The day's workflow holds that key; the full key stays with the owner, off
GitHub.

```bash
near contract deploy house.maskwars.near use-file maskwars_house.wasm with-init-call new file-args house-init.json prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-keychain send
near account add-key house.maskwars.near grant-function-call-access --allowance '0.3 NEAR' --contract-account-id house.maskwars.near --function-names 'home, unstick, settle, refund, retire, make_vault, open_round' use-manually-provided-public-key ed25519:<public key> network-config mainnet sign-with-keychain send
```
