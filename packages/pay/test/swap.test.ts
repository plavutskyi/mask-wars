import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import {
  associatedTokenAccount,
  base58,
  checkSwapQuote,
  depositAddressOk,
  listedOf,
  NEAR_ASSET,
  NEAR_PAY_GAS,
  nearDepositTransaction,
  nearPayExtra,
  NETWORKS,
  PREVIEW_ADDRESS,
  readRefund,
  readSwapAddress,
  refundOnOrigin,
  SWAP_TO,
  swapCatalogOf,
  swapCoinOf,
  swapPreviewView,
  swapProgressOf,
  swapQuoteView,
  swapRequest,
  txExplorer,
  type QuoteResponse,
  type StatusResponse,
  type Token,
} from "../src/index.ts";
import { fakePay } from "../src/fake.ts";

// The whole token list 1Click answered with on 2026-11-11: every network it reaches, 35 coins on NEAR itself.
const tokens = JSON.parse(readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")).tokens as Token[];
const catalog = swapCatalogOf(tokens)!;
const chain = (id: string) => catalog.chains.find((c) => c.id === id)!;
const coin = (id: string, symbol: string) => ({ chain: chain(id), coin: chain(id).coins.find((c) => c.symbol === symbol)! });
const NOW = new Date("2026-11-11T21:00:00.000Z");

/** A Solana wallet: an ed25519 public key, on the curve. */
const SOL_WALLET = base58(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("the swap catalog", () => {
  it("has NEAR first, only the listed networks, and pays out only where an address is read", () => {
    expect(catalog.chains.map((c) => c.id)).toEqual(NETWORKS.map((n) => n.id));
    expect(catalog.chains).toHaveLength(21);
    expect(catalog.chains[0]!.id).toBe("near");
    expect(catalog.chains.map((c) => c.id)).not.toContain("hypercore");
    // Gnosis and Scroll are left out (no mainstream coin of their own here), so 11 networks pay out.
    expect(SWAP_TO).toEqual(["near", "eth", "arb", "base", "bsc", "pol", "op", "avax", "gnosis", "scroll", "sol", "tron", "btc"]);
    expect(catalog.chains.filter((c) => c.to).map((c) => c.id)).toEqual(["near", "eth", "tron", "arb", "sol", "bsc", "base", "btc", "pol", "op", "avax"]);
    // NEAR is paid only from a NEAR wallet: no deposit address an exchange could send native NEAR to.
    expect(chain("near").address).toBe(false);
    expect(catalog.chains.filter((c) => c.id !== "near").every((c) => c.address)).toBe(true);
  });

  it("lists NEAR's blue chips that a NEAR wallet pays with ft_transfer, wNEAR as NEAR, and no meme coins", () => {
    const near = chain("near");
    expect(near.coins[0]).toMatchObject({ assetId: NEAR_ASSET, symbol: "NEAR", decimals: 24, contract: "wrap.near", native: true });
    expect(near.coins.map((c) => c.symbol)).toEqual(["NEAR", "USDT", "USDC", "BTC", "wBTC", "ETH", "stNEAR", "AURORA", "RHEA"]);
    for (const c of near.coins) expect(c.assetId).toBe(`nep141:${c.contract}`);
    expect(swapCoinOf(catalog, "nep141:usdt.tether-token.near")?.chain.id).toBe("near");
    expect(swapCoinOf(catalog, "nep141:nope.near")).toBeNull();
  });

  it("never shows or finds a coin outside the list: meme coins, vault shares, synthetic dollars", () => {
    const all = catalog.chains.flatMap((c) => c.coins);
    expect(all).toHaveLength(62);
    const symbols = new Set(all.map((c) => c.symbol));
    for (const s of ["BLACKDRAGON", "SHITZU", "JAMBO", "NearKat", "PURGE", "MOG", "SPX", "BRETT", "BOME", "MELANIA", "CASHCAT", "SWEAT", "USD1", "USDf", "sUSDC", "nrUsdt", "steakUSDC", "gtUSDCp", "sparkUSDC", "mwUSDC", "USDT0", "WETH", "xBTC", "hemiBTC"]) {
      expect(symbols).not.toContain(s);
    }
    for (const t of tokens) if (!listedOf(t.assetId)) expect(swapCoinOf(catalog, t.assetId)).toBeNull();
    // A vault share 1Click prices at a millionth of a dollar is not even reachable by asset id.
    expect(swapCoinOf(catalog, "nep141:eth-0xaf08e292d62df255f7953665a44ed65f0380aa60.omft.near")).toBeNull();
  });
});

describe("reading an address on the network that receives", () => {
  it("takes an EVM address in lower case, a checksummed one only when its checksum holds, never the zero address", () => {
    expect(readSwapAddress("arb", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F")).toEqual({ ok: true, id: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f", kind: "evm" });
    expect(readSwapAddress("bsc", " 0x71c7656ec7ab88b098defb751b7401b5f6d8976f ")).toMatchObject({ ok: true, id: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f" });
    expect(readSwapAddress("eth", "0x71C7656EC7ab88b098defB751B7401B5f6d8976f")).toEqual({ ok: false, why: "checksum" });
    expect(readSwapAddress("base", "0x0000000000000000000000000000000000000000")).toEqual({ ok: false, why: "zero" });
    expect(readSwapAddress("eth", "0x71c7656ec7ab88b098defb751b7401b5f6d8976")).toEqual({ ok: false, why: "bad" });
    expect(readSwapAddress("eth", SOL_WALLET)).toEqual({ ok: false, why: "other", other: "a Solana" });
    expect(readSwapAddress("pol", "maskwars.near")).toEqual({ ok: false, why: "other", other: "a NEAR" });
  });

  it("takes a NEAR name or implicit account in lower case, never an 0x address or a testnet account", () => {
    expect(readSwapAddress("near", "MaskWars.near")).toEqual({ ok: true, id: "maskwars.near", kind: "near", implicit: false });
    const hex = "df9cf2a975739a9a181c56a271421ad94217c22b252eafb933e523aa0aac63d4";
    expect(readSwapAddress("near", hex)).toEqual({ ok: true, id: hex, kind: "near", implicit: true });
    expect(readSwapAddress("near", "0x3602b546589a8fcafdce7fad64a46f91db0e4d50")).toEqual({ ok: false, why: "other", other: "an Ethereum" });
    expect(readSwapAddress("near", "kira.testnet")).toEqual({ ok: false, why: "testnet" });
    expect(readSwapAddress("near", "")).toEqual({ ok: false, why: "empty" });
    // A name without a dot is a registrar's top-level account, never a wallet: a TON address would read as one.
    expect(readSwapAddress("near", "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG")).toEqual({ ok: false, why: "bad" });
    expect(readSwapAddress("near", "aurora")).toEqual({ ok: false, why: "bad" });
  });

  it("takes a Solana wallet, never a token account (off the curve) that a coin sent to would never reach a wallet", () => {
    expect(readSwapAddress("sol", SOL_WALLET)).toEqual({ ok: true, id: SOL_WALLET, kind: "sol" });
    const ata = associatedTokenAccount(SOL_WALLET, USDC_SOL);
    expect(readSwapAddress("sol", ata)).toEqual({ ok: false, why: "token-account" });
    expect(readSwapAddress("sol", "0x71c7656ec7ab88b098defb751b7401b5f6d8976f")).toEqual({ ok: false, why: "other", other: "an Ethereum" });
    // Solana's own programs sit on the curve and read as wallets: nobody spends from them.
    expect(readSwapAddress("sol", "11111111111111111111111111111111")).toEqual({ ok: false, why: "zero" });
    expect(readSwapAddress("sol", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")).toEqual({ ok: false, why: "zero" });
  });

  it("takes a Tron address whose checksum holds", () => {
    expect(readSwapAddress("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toMatchObject({ ok: true, id: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" });
    expect(readSwapAddress("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toEqual({ ok: false, why: "checksum" });
    expect(readSwapAddress("tron", "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb")).toEqual({ ok: false, why: "zero" });
    expect(readSwapAddress("tron", "0x71c7656ec7ab88b098defb751b7401b5f6d8976f")).toEqual({ ok: false, why: "other", other: "an Ethereum" });
  });

  it("takes Bitcoin mainnet addresses of every kind, segwit in lower case, never testnet or a broken checksum", () => {
    for (const a of ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297"]) {
      expect(readSwapAddress("btc", a)).toEqual({ ok: true, id: a, kind: "btc" });
    }
    expect(readSwapAddress("btc", "BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ")).toMatchObject({ ok: true, id: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" });
    expect(readSwapAddress("btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx")).toEqual({ ok: false, why: "checksum" });
    expect(readSwapAddress("btc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toEqual({ ok: false, why: "checksum" });
    expect(readSwapAddress("btc", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toEqual({ ok: false, why: "testnet" });
    // Segwit after Taproot is spendable by anyone today: a valid checksum is not enough.
    expect(readSwapAddress("btc", "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs")).toMatchObject({ ok: false });
    expect(readSwapAddress("btc", "BC1SW50QGDZ25J")).toMatchObject({ ok: false });
  });

  it("reads nothing on a network it has no reader for", () => {
    expect(readSwapAddress("ton", "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG")).toEqual({ ok: false, why: "bad" });
    expect(readSwapAddress("xrp", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh")).toEqual({ ok: false, why: "bad" });
  });

  it("prices previews for addresses that pass its own reading", () => {
    expect(readSwapAddress("eth", PREVIEW_ADDRESS.evm)).toMatchObject({ ok: true, id: PREVIEW_ADDRESS.evm });
    expect(readSwapAddress("sol", PREVIEW_ADDRESS.sol)).toMatchObject({ ok: true, id: PREVIEW_ADDRESS.sol });
    expect(readSwapAddress("tron", PREVIEW_ADDRESS.tron)).toMatchObject({ ok: true, id: PREVIEW_ADDRESS.tron });
    expect(readSwapAddress("btc", PREVIEW_ADDRESS.btc)).toMatchObject({ ok: true, id: PREVIEW_ADDRESS.btc });
  });
});

describe("where a refund goes", () => {
  it("is an address on the paying network where it is read, else a NEAR account inside NEAR Intents", () => {
    expect(readRefund("arb", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F")).toEqual({ ok: true, refund: { to: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f", type: "ORIGIN_CHAIN" } });
    expect(readRefund("near", "Kira.near")).toEqual({ ok: true, refund: { to: "kira.near", type: "ORIGIN_CHAIN" } });
    expect(readRefund("ton", "kira.near")).toEqual({ ok: true, refund: { to: "kira.near", type: "INTENTS" } });
    expect(readRefund("ton", "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG")).toMatchObject({ ok: false });
    expect(readRefund("arb", "kira.near")).toEqual({ ok: false, why: "other", other: "a NEAR" });
    expect(refundOnOrigin("tron")).toBe(true);
    expect(refundOnOrigin("ton")).toBe(false);
  });
});

describe("the quote", () => {
  const from = coin("arb", "USDT");
  const to = coin("sol", "USDC");

  it("asks for exactly the coin out on its network, the refund where the page said, and MASK WARS's fee", () => {
    const r = swapRequest({ from, to, amount: 25_000_000n, recipient: SOL_WALLET, refund: { to: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f", type: "ORIGIN_CHAIN" }, dry: false, fee: { recipient: "maskwars.near", fee: 25 }, now: NOW });
    expect(r).toEqual({
      dry: false,
      swapType: "FLEX_INPUT",
      slippageTolerance: 100,
      originAsset: from.coin.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: to.coin.assetId,
      amount: "25000000",
      refundTo: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
      refundType: "ORIGIN_CHAIN",
      recipient: SOL_WALLET,
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-11T22:00:00.000Z",
      referral: "maskwars",
      quoteWaitingTimeMs: 3000,
      appFees: [{ recipient: "maskwars.near", fee: 25 }],
    });
    // Bitcoin confirms slowly: its deposit address waits two hours. Stellar's deposit carries a memo.
    const btc = swapRequest({ from: coin("btc", "BTC"), to: coin("near", "NEAR"), amount: 30_000n, recipient: "kira.near", refund: { to: "kira.near", type: "INTENTS" }, dry: true, now: NOW });
    expect(btc.deadline).toBe("2026-11-11T23:00:00.000Z");
    expect(btc.appFees).toBeUndefined();
    const xlm = swapRequest({ from: { chain: chain("stellar"), coin: chain("stellar").coins[0]! }, to: coin("near", "NEAR"), amount: 10_000_000n, recipient: "kira.near", refund: { to: "kira.near", type: "INTENTS" }, dry: true, now: NOW });
    expect(xlm.depositMode).toBe("MEMO");
  });

  it("refuses the same coin in and out, a network it cannot pay out to, and addresses it was not given read", () => {
    const refund = { to: "kira.near", type: "INTENTS" as const };
    expect(() => swapRequest({ from, to: from, amount: 1n, recipient: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f", refund, dry: true })).toThrow(/same coin/);
    const ton = { chain: chain("ton"), coin: chain("ton").coins[0]! };
    expect(() => swapRequest({ from, to: ton, amount: 1n, recipient: "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG", refund, dry: true })).toThrow(/no payout/);
    // A checksummed address goes out in lower case, as `readSwapAddress` gives it.
    expect(() => swapRequest({ from: to, to: from, amount: 1n, recipient: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", refund, dry: true })).toThrow(/not an address/);
    expect(() => swapRequest({ from, to, amount: 1n, recipient: SOL_WALLET, refund: { to: "kira.near", type: "ORIGIN_CHAIN" }, dry: true })).toThrow(/refund/);
    expect(() => swapRequest({ from, to, amount: 0n, recipient: SOL_WALLET, refund, dry: true })).toThrow(/positive/);
  });

  it("reads a quote back: coins, receiver, refund, the exact amount and a minimum within 1%", async () => {
    const fake = fakePay({ tokens });
    const refund = { to: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F".toLowerCase(), type: "ORIGIN_CHAIN" as const };
    const request = swapRequest({ from, to, amount: 25_000_000n, recipient: SOL_WALLET, refund, dry: false, now: new Date() });
    const res = (await (await fake.fetch("https://1click.chaindefuser.com/v0/quote", { method: "POST", body: JSON.stringify(request) })).json()) as QuoteResponse;
    const view = swapQuoteView({ ...res, quote: { ...res.quote, withdrawFee: "10033", refundFee: "5300" } });
    expect(view.withdrawFee).toBe("10033");
    expect(view.refundFee).toBe("5300");
    expect(depositAddressOk("arb", view.depositAddress!)).toBe(true);
    const terms = { from: from.coin.assetId, to: to.coin.assetId, recipient: SOL_WALLET, refund, amountIn: "25000000" };
    expect(checkSwapQuote(view, terms)).toEqual({ ok: true });
    // 1Click echoing an EVM address in another case is the same address.
    expect(checkSwapQuote({ ...view, refundTo: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" }, terms)).toEqual({ ok: true });
    expect(checkSwapQuote({ ...view, refundType: "INTENTS" }, terms).ok).toBe(false);
    expect(checkSwapQuote({ ...view, recipient: PREVIEW_ADDRESS.sol }, terms).ok).toBe(false);
    expect(checkSwapQuote({ ...view, destinationAsset: from.coin.assetId }, terms).ok).toBe(false);
    expect(checkSwapQuote({ ...view, amountIn: "26000000" }, terms).ok).toBe(false);
    expect(checkSwapQuote({ ...view, minAmountOut: ((BigInt(view.amountOut) * 98n) / 100n).toString() }, terms).ok).toBe(false);
    expect(checkSwapQuote(view, { ...terms, seen: ((BigInt(view.amountOut) * 105n) / 100n).toString() })).toEqual({ ok: false, why: "the price moved", moved: true });
    expect(checkSwapQuote({ ...view, dry: true }, terms).ok).toBe(false);
    expect(swapPreviewView(view)).toMatchObject({ recipient: null, refundTo: null, depositAddress: null, depositMemo: null, withdrawFee: "10033" });
  });

  it("knows a NEAR deposit account and an EVM deposit address when it sees one", () => {
    expect(depositAddressOk("near", "ff586ca661152445c7a3925587cb6a66a4f4906d04506e50b92316e280261794")).toBe(true);
    expect(depositAddressOk("near", "maskwars.near")).toBe(false);
    expect(depositAddressOk("base", "0x71c7656ec7ab88b098defb751b7401b5f6d8976f")).toBe(true);
    expect(depositAddressOk("base", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe(false);
    expect(depositAddressOk("ton", "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG")).toBe(true);
  });
});

describe("following a swap", () => {
  const status = (s: Partial<StatusResponse> & { swapDetails?: StatusResponse["swapDetails"] }): StatusResponse =>
    ({ correlationId: "c", quoteResponse: {} as QuoteResponse, status: "SUCCESS", updatedAt: "", swapDetails: {}, ...s }) as StatusResponse;

  it("links the payout on the network it landed on, and nothing for a hash that is not that network's", () => {
    const evm = `0x${"ab".repeat(32)}`;
    expect(swapProgressOf(status({ swapDetails: { destinationChainTxHashes: [{ hash: evm, explorerUrl: "" }] } }), "arb").landed).toEqual({ hash: evm, link: `https://arbiscan.io/tx/${evm}` });
    const near = "HYZ4ycqXgR4yEMhfsYgvkZjiU5V6YtbW2D5vhNVF2wWy";
    expect(swapProgressOf(status({ swapDetails: { nearTxHashes: ["x", near] } }), "near").landed).toEqual({ hash: near, link: `https://nearblocks.io/txns/${near}` });
    expect(swapProgressOf(status({ swapDetails: { destinationChainTxHashes: [{ hash: near, explorerUrl: "" }] } }), "arb").landed).toBeNull();
    expect(swapProgressOf(status({ status: "PROCESSING", swapDetails: { destinationChainTxHashes: [{ hash: evm, explorerUrl: "" }] } }), "arb").landed).toBeNull();
    expect(txExplorer("btc", "a".repeat(64))).toBe(`https://mempool.space/tx/${"a".repeat(64)}`);
    expect(txExplorer("tron", "a".repeat(64))).toBe(`https://tronscan.org/#/transaction/${"a".repeat(64)}`);
    expect(txExplorer("ton", "a".repeat(64))).toBeNull();
  });
});

describe("paying from a NEAR wallet", () => {
  const deposit = "ff586ca661152445c7a3925587cb6a66a4f4906d04506e50b92316e280261794";
  const STORAGE = 1_250_000_000_000_000_000_000n;

  it("wraps native NEAR and sends it in one transaction to wrap.near, registering whoever is not registered first", () => {
    const near = coin("near", "NEAR").coin;
    const tx = nearDepositTransaction({ coin: near, payer: "kira.near", depositAddress: deposit, amount: 5n * 10n ** 24n, depositStorage: STORAGE, payerStorage: STORAGE });
    expect(tx.receiverId).toBe("wrap.near");
    expect(tx.actions.map((a) => [a.params.methodName, a.params.args, a.params.deposit])).toEqual([
      ["storage_deposit", { account_id: deposit, registration_only: true }, STORAGE.toString()],
      ["storage_deposit", { account_id: "kira.near", registration_only: true }, STORAGE.toString()],
      ["near_deposit", {}, (5n * 10n ** 24n).toString()],
      ["ft_transfer", { receiver_id: deposit, amount: (5n * 10n ** 24n).toString() }, "1"],
    ]);
    const gas = tx.actions.reduce((n, a) => n + BigInt(a.params.gas), 0n);
    expect(gas).toBeLessThanOrEqual(300n * 10n ** 12n);
    expect(nearPayExtra({ depositStorage: STORAGE, payerStorage: STORAGE, native: true })).toBe(2n * STORAGE + 1n + NEAR_PAY_GAS);
  });

  it("sends a token with ft_transfer to its own contract, and nothing more when the deposit account is known", () => {
    const usdt = coin("near", "USDT").coin;
    const tx = nearDepositTransaction({ coin: usdt, payer: "kira.near", depositAddress: deposit, amount: 25_000_000n, depositStorage: 0n, payerStorage: STORAGE });
    expect(tx).toEqual({
      receiverId: "usdt.tether-token.near",
      actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: deposit, amount: "25000000" }, gas: "30000000000000", deposit: "1" } }],
    });
    expect(nearPayExtra({ depositStorage: 0n, payerStorage: STORAGE, native: false })).toBe(1n + NEAR_PAY_GAS);
  });

  it("refuses anything but a NEAR deposit account, a NEAR payer and a plain NEP-141 token", () => {
    const usdt = coin("near", "USDT").coin;
    const base = { coin: usdt, payer: "kira.near", depositAddress: deposit, amount: 1n, depositStorage: 0n, payerStorage: 0n };
    expect(() => nearDepositTransaction({ ...base, depositAddress: "maskwars.near" })).toThrow(/deposit account/);
    expect(() => nearDepositTransaction({ ...base, payer: "0x3602b546589a8fcafdce7fad64a46f91db0e4d50" })).toThrow(/NEAR account/);
    expect(() => nearDepositTransaction({ ...base, coin: { ...usdt, assetId: "1cs_v1:near:nep141:zec.omft.near", contract: "zec.omft.near" } })).toThrow(/NEAR token/);
    expect(() => nearDepositTransaction({ ...base, amount: 0n })).toThrow(/positive/);
  });
});
