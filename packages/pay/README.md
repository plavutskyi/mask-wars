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
| Spending on a contract | a NEAR wallet's vault puts its NEAR into a call that takes NEAR, such as a forged mask's mind (`refuel`): four transactions, in one approval where the wallet signs several at once: `wrap.near` registration, `ft_withdraw` from `intents.near` to the account itself, `near_withdraw`, then the call (`spend.ts`). `spentOf` reads where the wallet stopped. A passkey vault has no NEAR account to attach NEAR from |

Before signing, the page reads the intent itself: exactly one `transfer` of the agreed coin and amount to the address
from the quote, the signer is the vault, the contract is `intents.near`. 1Click dates the intent three days ahead (the
lifetime of the deposit address); the page rewrites only the deadline, to the deadline of the payout quote, 15 minutes
(`withDeadline`), and signs only that version. The quote is read back too (`checkQuote`): recipient, coins, refund to
the vault, `minAmountOut` within 1% of the price and no lower than shown.

A vault is created only from a passkey that syncs across the person's devices (the BE flag in the authenticator data).
A passkey that lives on one device does not get a vault: a lost phone would lock the money forever.

## Walking it without money

With `PAY_FIXTURE=1` the site runs on 1Click, NEAR Intents and the mask factory in memory (`fake.ts`), never in
production. A top-up in a stablecoin ends by its cents: `.13` is refunded to the vault, `.66` fails, `.07` arrives short
and goes back; any other amount goes through. The factory holds two masks of `kira.near` (`test/fixtures/masks.json`).

## Get NEAR (`bridge.ts`, the page `/near`)

A listed coin on a listed network, swapped to NEAR and sent straight to a NEAR account. No vault, no sign-in.

| What | How |
| --- | --- |
| Networks | Only what `listed.ts` lists, 21 networks and 62 coins, each coin pinned by 1Click's asset id, and of those only what 1Click quotes that day on the same network, with the same contract and at a plausible price (`listedTokens`). NEAR itself is left out here, so Get NEAR shows 20 networks: 53 coins on 2026-11-12. 1Click's own list is wider (39 networks that day); nothing outside `listed.ts` is shown or quoted. Arbitrum's only USDT, listed as USDT0, is shown as USDT, the name an exchange uses |
| Quote | `FLEX_INPUT` from the origin chain into `nep141:wrap.near` with `recipientType: DESTINATION_CHAIN`; a refund goes to the same account inside NEAR Intents, so no refund address is typed and nothing goes back to an exchange's deposit address. MASK WARS's fee rides as `appFees` (`packages/network/mainnet.json` → `get_near`, at most 1%) |
| What arrives | Native NEAR. 1Click pays wNEAR out to a NEAR account with a `native_withdraw` intent (read on chain 2026-11-11: swap `aa39ab52…`, tx `HYZ4ycqX…`), so nothing is left to unwrap, and a 64-character implicit account that does not exist yet is created by the transfer |
| Receiver | A name must already be on NEAR (`view_account` first: 1Click answers a missing name with an error). A 64-character implicit address may be new. An `0x…` address is refused: on NEAR it is an account only an Ethereum key opens |
| Status | 1Click's status in the vault's seven stages, plus the NEAR transaction that paid out (1Click lists it without an explorer link) |
| Switch | Prices are always open. A deposit address only with `GET_NEAR_LIVE=1`, set by the owner on the site |
| Pay from a wallet | The same deposit address, paid straight from a wallet in the browser. EVM (`evm.ts`): nine networks whose chain id is certain; the token's contract must be the one 1Click's asset id names; the wallet is switched there and read back (again right before signing), the token's `decimals()` must match 1Click's and its balance cover the amount, then one `transfer` (or a plain value transfer for the network's own coin) carrying the `chainId`. Solana (`solana.ts`): one legacy transaction built byte by byte for the Wallet Standard's `solana:signAndSendTransaction`: a System transfer, or `CreateIdempotent` of the deposit's token account and `TransferChecked` with the mint's decimals read from the chain. The payer's SOL (for the fee and the ≈0.002 SOL rent of the deposit's token account) and token balance are read first. Tron pays by copying the address. Checked on mainnet with no money: the USDT transfer by `eth_call` from a holder returns true; the SOL and USDC transactions pass `simulateTransaction` |

## Swap (`swap.ts`, the page `/swap`)

Any listed coin into any listed coin on a network whose receiving address the code reads with certainty. Get NEAR is
the same swap with native NEAR as what arrives.

| What | How |
| --- | --- |
| Networks | Paid from any of the 21 networks of `listed.ts`, NEAR first: 62 coins on 2026-11-12, the same list and the same checks as Get NEAR, plus NEAR itself. Paid out only where `SWAP_TO` reads an address with certainty; of the listed networks that is NEAR, Ethereum, Arbitrum, Base, BNB Chain, Polygon, Optimism, Avalanche, Solana, Tron and Bitcoin. On NEAR only plain NEP-141 tokens (asset id `nep141:<contract>`), wNEAR shown as NEAR |
| Receiver | `readSwapAddress`: a NEAR name with a dot or a 64-character implicit account (never `0x…`, testnet, or a dotless name, which is how a TON address reads); an EVM address with its EIP-55 checksum when mixed-case, sent in lower case, never the zero address; a Solana address on the ed25519 curve (a wallet, not a token account); Tron and legacy Bitcoin by base58check; segwit by bech32/bech32m. A refused address names the network it looks like |
| Refund | From a wallet in the browser: back to that wallet on its own network (`ORIGIN_CHAIN`). From an exchange to NEAR: the receiving account inside NEAR Intents. From an exchange elsewhere: a refund address the person gives on the paying network (`readRefund`), or a NEAR account inside NEAR Intents where the code reads no address of that network |
| Quote | `swapRequest`: `FLEX_INPUT`, `DESTINATION_CHAIN`, the refund above, MASK WARS's `appFees` (`packages/network/mainnet.json` → `swap`). `checkSwapQuote` reads it back (EVM addresses compared in lower case); `depositAddressOk` checks the deposit address is one the paying network's wallet can pay |
| A coin on NEAR | Paid only from the person's NEAR wallet: `nearDepositTransaction` is one transaction to the coin's contract — `storage_deposit` for the deposit account where the contract does not know it, for native NEAR `storage_deposit` for the payer and `near_deposit`, then `ft_transfer` of exactly the amount. Actions to one contract run as one receipt: all or nothing. No deposit address is shown for it: an exchange would send native NEAR, which a deposit account does not take as wNEAR |
| Status | `swapProgressOf`: 1Click's stages, and the payout's transaction linked on the explorer of the network it landed on |
| Switch | Prices are always open. A deposit address only with `SWAP_LIVE=1`, set by the owner on the site |

## Checks

```sh
pnpm --filter @maskwars/pay test            # near/intents vectors, signature, intent check, recorded 1Click responses
pnpm --filter @maskwars/pay live --record   # live 1Click without money; in CI this is the pay-live job
```
