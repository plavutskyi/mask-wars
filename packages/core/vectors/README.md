# Shared vectors

The same inputs and answers for `packages/core` and the Rust contract. Generated from the core: `pnpm --filter @maskwars/core vectors`.
The core test fails if the files drift from the generator. Amounts are decimal strings (u128), USDC in minimal units.

| File | What it checks |
| --- | --- |
| `books.json` | Book: `backs` → `expect` (`paid`: T, W, rake, D, payouts by `op_id`, dust, house, mask_share; `void`: reason and refunds) |
| `score.json` | `score_bp` from `start_usdc`, `final_usdc`, `called_it` |
| `seals.json` | Seals: domain, fields in order, exact bytes of `preimage_hex` and `sha256` |
| `same-primary.json` | Same primary: who takes the backup by `sha256(fight_id)` and the effective coins |
