# Vault on OutLayer

The winning break of each race is sealed in OutLayer's TEE. The board shows only the public line (who won, how fast).
The full break opens only with the claim code the requester got with their race.

- `seal` — race worker only (the OutLayer project owner): `{ "action": "seal", "id", "claim_hash", "public", "finding" }`
- `board` — anyone: `{ "action": "board", "id" }`
- `open` — claim holder: `{ "action": "open", "id", "claim" }`

Build: `cargo build --release --target wasm32-wasip2`. CI attaches `maskwars-vault.wasm`.
Publish: `outlayer upload …wasm`, then `outlayer deploy maskwars-vault <url>` (owner's OutLayer account).
