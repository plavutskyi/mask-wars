# @maskwars/forge

The person's side of forging a mask of their own. The package covers what a mask is forged with, the strategy line
sealed in the browser for the mind's key, the mask factory read from NEAR, the `forge` transaction a wallet signs, and
what the owner sees and may do afterwards. The factory contract is `contracts/masks`, the mind that opens a sealed line
is `services/brain`, and the page is `apps/web/app/forge`.

## Status

- **Testnet: it ran.** On 11 Nov 2026, on its own testnet stack with the factory `masks2.mwforge1111.testnet`, the
  people's masks BLAZE and EMBER raced a house round. `TESTNET` in `src/chain.ts` names the default testnet factory,
  `masks.tinygif8324.testnet`; the site can name another with `NEXT_PUBLIC_FORGE_FACTORY` (`apps/web/lib/forge.ts`).
- **Mainnet: open since 12 Nov 2026.** `https://maskwars.xyz/api/forge` answers
  `{"open":true,"factory":"masks.maskwars.near","network":"mainnet"}`. The factory `masks.maskwars.near` has no key,
  its mask code is published, and `sections.forge` is `true` in `packages/network/mainnet.json`. On 12 Nov its `config`
  view says `"masks":0`: nobody has forged a mask on mainnet yet, and no person's mask has raced there.

## What it does

| Part | How |
| --- | --- |
| Catalog | 3 looks, 4 styles and 3 minds: GLM 5.3 Flash, DeepSeek V4.1 Flash and Qwen 3.8 27B, all Private TEE models on NEAR AI Cloud. A test holds `MINDS`, `contracts/masks/catalog.json` and `TEE_MODELS` of `packages/mind` in step |
| Name | 3 to 16 lower-case letters and digits, starting with a letter, minus the names the arena keeps (`RESERVED`, the same list as the factory's). The mask's account is `<name>.<factory>` |
| Strategy | One line of up to 160 characters, sealed in the page with Web Crypto only: X25519 with the mind's key, HKDF-SHA256 (`maskwars:strategy:v1`), AES-256-GCM with the mask's account as associated data, padded to 512 bytes. The factory stores only the box; `services/brain/vector.json` pins the bytes for both sides |
| Forge | `forge` on the factory with the fuel attached and 100 TGas. A copy names `copy_of` and the author's share it agrees to (`copy_bps`), and carries no line of its own |
| Owner | Reads the mask's account, what `withdraw` may take out, the mask's × (earned over fuel), copy terms and earnings, and a factory change that is waiting |
| History | A race history opened only by the accounts the owner chose. A view key is an X25519 key made from the reader's wallet signature, and each race has its own key, so a revoked reader gets no later race |

## Run its tests

```bash
pnpm --filter @maskwars/forge test        # vitest: catalog, names, the seal, the forge action, owner reads, view keys
pnpm --filter @maskwars/forge typecheck
```

The factory's own tests, including a person forging a mask on a local NEAR node, are in `contracts/masks`.

## Key files

| File | What it does |
| --- | --- |
| `src/catalog.ts` | Looks, minds with their prices, styles |
| `src/name.ts` | Name rules and the reserved names |
| `src/seal.ts` | Seals the strategy line for the mind's key |
| `src/forge.ts` | The `forge` action, the fuel choices, what the tank pays for |
| `src/chain.ts` | The factory's JSON views over public RPC: config, masks |
| `src/owner.ts` | The owner's reads and actions: withdraw, fuel, copying, waiting changes |
| `src/history.ts` | View keys, race keys and the sealed notes of a race history |
| `src/near.ts` | NEAR amounts in and out of yoctoNEAR |
