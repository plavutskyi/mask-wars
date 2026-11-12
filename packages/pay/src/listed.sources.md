# Where each stablecoin in `listed.ts` was checked

Every stablecoin shown on Swap and Get NEAR is the one its issuer names as official on that network, checked against the
issuer's own page on 2026-11-12. The asset ids and contracts are the ones 1Click lists for them
(`https://1click.chaindefuser.com/v0/tokens`, recorded in `test/fixtures/tokens.json`); `test/listed.test.ts` fails if
1Click names a different contract for an asset id, or if a stablecoin contract below is missing from this file.

Issuer pages:

- Tether, supported protocols: https://tether.to/en/supported-protocols/
- USDT0 (Tether's token on Arbitrum, Optimism, Polygon and others): https://usdt0.to/ecosystem/arbitrum,
  https://usdt0.to/ecosystem/optimism, https://usdt0.to/ecosystem/polygon
- Circle, USDC contract addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses

## USDT

| Network | Contract | Source | Why this one |
| --- | --- | --- | --- |
| NEAR | `usdt.tether-token.near` | Tether | Tether's own token on NEAR. `nrUsdt` (a Rhea vault share) is left out. |
| Ethereum | `0xdac17f958d2ee523a2206206994597c13d831ec7` | Tether | Tether's ERC-20. |
| Tron | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | Tether | Tether's TRC-20. |
| Arbitrum | `0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9` | USDT0 | The only Tether token on Arbitrum, run by USDT0 (renamed USD₮0). Exchanges list it as USDT on Arbitrum One; shown as USDT with the line «Tether · USD₮0», found by `usdt`, `usdt0` and `tether`. |
| Solana | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | Tether | Tether's SPL token. |
| BNB Chain | `0x55d398326f99059ff775485246999027b3197955` | — | Tether issues no USDT on BNB Chain (its page lists only XAU₮ there). This is Binance's pegged USDT («Binance-Peg BSC-USD» on BscScan), the token exchanges pay out as USDT BEP-20, redeemable 1:1 at Binance. Shown with the line «Binance-Peg». |
| Polygon | `0xc2132d05d31c914a87c6611c10748aeb04b58e8f` | USDT0 | USDT0 upgraded Polygon's USDT in place on this contract. The «(DEPRECATED)» double 1Click keeps for the same contract is left out. |
| Optimism | `0x01bff41798a0bcf287b996046ca68b395dbc1071` | USDT0 | USDT0's contract. 1Click also lists the old bridged USDT `0x94b008aa00579c1307b0ef2c499ad98a8ce58e58`; it is left out: OKX's USDT0 FAQ lists Optimism among its USDT0 networks, Bitfinex pays out USDT0 on Optimism, and Bitkub switched to USDT0 on Optimism on 2026-10-15 and closed the old token the same day. |
| Avalanche | `0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7` | Tether | Tether's token on the C-Chain (non-deprecated asset id). |
| TON | `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` | Tether | Tether's jetton. |
| Aptos | `0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b` | Tether | Tether names this the USD₮ token object asset id (its contract is `0xf73e…73cb`); Aptos Explorer opens it as a verified fungible asset. |

## USDC

Circle's native USDC only, never a bridged USDC.e.

| Network | Contract | Source |
| --- | --- | --- |
| NEAR | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | Circle |
| Ethereum | `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` | Circle |
| Arbitrum | `0xaf88d065e77c8cc2239327c5edb3a432268e5831` | Circle |
| Solana | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Circle |
| Base | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | Circle |
| Polygon | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359` | Circle (Polygon PoS) |
| Optimism | `0x0b2c639c533813f4aa9d7837caf62653d097ff85` | Circle (OP Mainnet) |
| Avalanche | `0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e` | Circle (C-Chain) |
| Sui | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` | Circle |
| Aptos | `0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b` | Circle |
| BNB Chain | `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d` | — Circle issues no USDC on BNB Chain. This is Binance's pegged USDC, the only USDC there, the one exchanges pay out as USDC BEP-20. Shown with the line «Binance-Peg». |

Left out on purpose: USD1, USDf, sUSDC, nrUsdt, steakUSDC, gtUSDCp, sparkUSDC, mwUSDC, laUSDC and every other vault share,
wrapped-yield or synthetic dollar; Stellar's USDC (no Stellar token page we could open from here); Gnosis and Scroll (only
bridged stablecoins there).

## Other dollars

| Coin | Contract | Source |
| --- | --- | --- |
| DAI on Ethereum | `0x6b175474e89094c44da98b954eedeac495271d0f` | Sky (formerly MakerDAO) Dai; the contract every exchange and Etherscan list as Dai Stablecoin. |

## Names

- **Gram (prev. Toncoin)**: Toncoin was renamed Gram, ticker GRAM, on 2026-06-15 after a TON community vote; the network is
  still TON. Trust Wallet's asset registry names it «Gram (prev. Toncoin)», symbol GRAM
  (https://github.com/trustwallet/assets/blob/master/blockchains/ton/info/info.json). Shown as GRAM, «prev. Toncoin»,
  found by `ton` and `toncoin`. ton.org could not be opened from the build session.
- **BTC on NEAR** is nBTC, the Omni Bridge's Bitcoin (`nbtc.bridge.near`); **wBTC on NEAR** is Wrapped Bitcoin over the
  Rainbow Bridge. Both say so on their second line.

## Explorer links

Each network's token page is the one the issuers link themselves: Circle's page links Arbiscan, Basescan, Etherscan,
Optimistic Etherscan, PolygonScan, Snowtrace, Solscan, NearBlocks, Aptos Explorer (`fungible_asset/…?network=mainnet`) and
Suiscan (`mainnet/coin/…`); Tether's and USDT0's pages link Tronscan (`#/token20/…`), BscScan, Tonviewer and NearBlocks.
