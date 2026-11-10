# @maskwars/pay

A person's money on MASK WARS: a vault in NEAR Intents, opened by a passkey or a NEAR wallet. Top-ups from any network
and payouts to any network go through 1Click. Only the person holds the key to the vault; the site does not have it.

## How it works

| What | How |
| --- | --- |
| Account | passkey P-256 → `0x` + hex(keccak256("p256" ‖ x ‖ y)[12..32]), an implicit account in `intents.near` (`passkey.ts`). NEAR wallet → its own account; the key is added to `intents.near` once |
| Balance | `mt_batch_balance_of` on `intents.near`, NEAR mainnet (`ledger.ts`). Prices come from 1Click and are for display only |
| Top-up | 1Click `FLEX_INPUT`: a coin from a network → wNEAR on the person's account in NEAR Intents; refunds go to the same account, so no address has to be entered (`quote.ts`) |
| Payout | 1Click `depositType: INTENTS`: `generate-intent` → the page checks the intent (`intent.ts`) → passkey or NEP-413 signature → `submit-intent` |
| Statuses | seven 1Click statuses → seven screen states; `REFUNDED`, `FAILED`, `INCOMPLETE_DEPOSIT` are separate (`status.ts`) |
| Networks | Solana, Base, Ethereum, Arbitrum, Tron, Bitcoin; a coin is found in the live 1Click list by its contract (`chains.ts`, `catalog.ts`) |

Before signing, the page reads the intent itself: exactly one `transfer` of the agreed coin and amount to the address
from the quote, the signer is the vault, the contract is `intents.near`. 1Click dates the intent three days ahead (the
lifetime of the deposit address); the page rewrites only the deadline, to the deadline of the payout quote, 15 minutes
(`withDeadline`), and signs only that version. The quote is read back too (`checkQuote`): recipient, coins, refund to
the vault, `minAmountOut` within 1% of the price and no lower than shown.

A vault is created only from a passkey that syncs across the person's devices (the BE flag in the authenticator data).
A passkey that lives on one device does not get a vault: a lost phone would lock the money forever.

## Checks

```sh
pnpm --filter @maskwars/pay test            # near/intents vectors, signature, intent check, recorded 1Click responses
pnpm --filter @maskwars/pay live --record   # live 1Click without money; in CI this is the pay-live job
```
