import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accountExists,
  checkNearQuote,
  feeBps,
  minimumUsd,
  NEAR_ASSET,
  nearFinal,
  nearCatalogOf,
  nearCoinOf,
  NETWORKS,
  nearDepositUnits,
  nearPreviewView,
  nearProgressOf,
  nearQuoteView,
  nearRequest,
  readNearAccount,
  type QuoteResponse,
  type StatusResponse,
  type Token,
} from "../src/index.ts";
import { fakePay } from "../src/fake.ts";

// The whole token list 1Click answered with on 2026-11-11: every network it reaches.
const tokens = JSON.parse(readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")).tokens as Token[];
const catalog = nearCatalogOf(tokens)!;
const arb = catalog.chains.find((c) => c.id === "arb")!;
const usdtArb = arb.coins.find((c) => c.symbol === "USDT")!;
const NOW = new Date("2026-11-11T21:00:00.000Z");

describe("the networks NEAR can come from", () => {
  it("takes only the listed networks, NEAR itself aside, in the order people look for them", () => {
    const listed = new Set(tokens.map((t) => t.blockchain));
    expect(listed.size).toBe(39);
    const ids = catalog.chains.map((c) => c.id);
    expect(ids).toEqual(NETWORKS.map((n) => n.id).filter((id) => id !== "near"));
    expect(ids).toHaveLength(20);
    for (const gone of ["near", "hypercore", "gnosis", "scroll", "bera", "monad", "plasma", "xlayer", "starknet", "abs", "hood", "aleo", "dash", "fogo", "miden", "movement", "adi", "prl", "qtc"]) {
      expect(ids).not.toContain(gone);
    }
    expect(ids.slice(0, 7)).toEqual(["eth", "tron", "arb", "sol", "bsc", "base", "btc"]);
    expect(catalog.near).toEqual({ assetId: NEAR_ASSET, decimals: 24, price: 3.71 });
  });

  it("names every network and shows each listed coin once, with its name and logo", () => {
    for (const c of catalog.chains) {
      expect(c.name).toMatch(/\S/);
      expect(c.coins.length).toBeGreaterThan(0);
      for (const coin of c.coins) {
        expect(coin.symbol).not.toMatch(/[()]/);
        expect(coin.price).toBeGreaterThan(0);
        expect(coin.name).toMatch(/\S/);
        expect(coin.logo).toMatch(/^[a-z0-9]+\.(svg|png)$/);
      }
      expect(new Set(c.coins.map((x) => x.symbol)).size).toBe(c.coins.length);
    }
    // Binance's pegged stablecoins and BNB: no SWEAT, ASTER, RHEA on BNB Chain, nrUsdt or deprecated doubles.
    expect(catalog.chains.find((c) => c.id === "bsc")!.coins.map((c) => c.symbol)).toEqual(["USDT", "USDC", "BNB"]);
    expect(catalog.chains.find((c) => c.id === "base")!.coins.map((c) => c.symbol)).toEqual(["USDC", "ETH", "cbBTC"]);
  });

  it("calls Arbitrum's USDT0 plain USDT, as exchanges do, and says it is Tether's USD₮0", () => {
    expect(usdtArb).toMatchObject({ symbol: "USDT", name: "Tether USD", note: "Tether · USD₮0", decimals: 6, contract: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" });
    expect(usdtArb.aka).toContain("usdt0");
    expect(arb.coins[0]).toBe(usdtArb);
    // Optimism lists the old bridged USDT and USDT0: only USDT0 is shown, as USDT.
    const op = catalog.chains.find((c) => c.id === "op")!.coins;
    expect(op.map((c) => c.symbol)).toEqual(["USDT", "USDC", "ETH", "OP"]);
    expect(op[0]!.contract).toBe("0x01bff41798a0bcf287b996046ca68b395dbc1071");
  });

  it("shows Toncoin by the name it has today, Gram, and still finds it as Toncoin", () => {
    const gram = catalog.chains.find((c) => c.id === "ton")!.coins.find((c) => c.native)!;
    expect(gram).toMatchObject({ symbol: "GRAM", name: "Gram", note: "prev. Toncoin", logo: "gram.svg" });
    expect(gram.aka).toContain("toncoin");
  });

  it("gives slow networks two hours, memo networks a memo", () => {
    expect(catalog.chains.find((c) => c.id === "btc")!.window).toBe(120);
    expect(arb.window).toBe(60);
    expect(catalog.chains.find((c) => c.id === "stellar")!.memo).toBe(true);
    expect(arb.memo).toBe(false);
  });

  it("finds a coin by asset id, and nothing for NEAR itself", () => {
    expect(nearCoinOf(catalog, usdtArb.assetId)).toEqual({ chain: arb, coin: usdtArb });
    expect(nearCoinOf(catalog, NEAR_ASSET)).toBeNull();
  });

  it("has nothing to offer when 1Click does not list NEAR", () => {
    expect(nearCatalogOf(tokens.filter((t) => t.assetId !== NEAR_ASSET))).toBeNull();
  });

  it("prices dollars as an amount a person can type", () => {
    expect(nearDepositUnits(25, usdtArb)).toBe(25_000_000n);
    const btc = catalog.chains.find((c) => c.id === "btc")!.coins[0]!;
    expect(nearDepositUnits(25, btc).toString()).toMatch(/^\d{1,4}0*$/);
  });
});

describe("who receives", () => {
  it("reads names and implicit addresses, in lower case", () => {
    expect(readNearAccount("  MaskWars.near ")).toEqual({ ok: true, id: "maskwars.near", kind: "named" });
    expect(readNearAccount("alice.tg")).toEqual({ ok: true, id: "alice.tg", kind: "named" });
    const hex = "df9cf2a975739a9a181c56a271421ad94217c22b252eafb933e523aa0aac63d4";
    expect(readNearAccount(hex.toUpperCase())).toEqual({ ok: true, id: hex, kind: "implicit" });
  });

  it("refuses an Ethereum address, a testnet account and anything that is not an account", () => {
    expect(readNearAccount("0x3602b546589a8fcafdce7fad64a46f91db0e4d50")).toEqual({ ok: false, why: "eth" });
    expect(readNearAccount("alice.testnet")).toEqual({ ok: false, why: "testnet" });
    expect(readNearAccount("")).toEqual({ ok: false, why: "empty" });
    for (const bad of ["a", "alice..near", "-alice.near", "alice near", "alice@near", "x".repeat(65)]) expect(readNearAccount(bad).ok).toBe(false);
  });

  it("asks NEAR whether an account is there, and never mistakes a dead node for no account", async () => {
    const rpc = (answer: unknown, status = 200) => (async () => Response.json(answer, { status })) as typeof fetch;
    expect(await accountExists("maskwars.near", { rpcs: ["https://rpc"], fetch: rpc({ result: { amount: "1", storage_usage: 1 } }) })).toBe(true);
    expect(await accountExists("nobody.near", { rpcs: ["https://rpc"], fetch: rpc({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }) })).toBe(false);
    await expect(accountExists("maskwars.near", { rpcs: ["https://a", "https://b"], fetch: rpc({}, 502) })).rejects.toThrow();
    // The first node down, the second answers.
    let calls = 0;
    const flaky = (async () => (++calls === 1 ? new Response("", { status: 503 }) : Response.json({ result: { amount: "5" } }))) as typeof fetch;
    expect(await accountExists("maskwars.near", { rpcs: ["https://a", "https://b"], fetch: flaky })).toBe(true);
  });
});

describe("the quote", () => {
  const fee = { recipient: "maskwars.near", fee: 25 };

  it("sends native NEAR to the account, refunds to the same account in NEAR Intents, and takes our fee", () => {
    const r = nearRequest({ recipient: " MaskFan.near", chain: arb, from: usdtArb, amount: 25_000_000n, dry: false, fee, now: NOW });
    expect(r).toEqual({
      dry: false,
      swapType: "FLEX_INPUT",
      slippageTolerance: 100,
      originAsset: usdtArb.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: "nep141:wrap.near",
      amount: "25000000",
      refundTo: "maskfan.near",
      refundType: "INTENTS",
      recipient: "maskfan.near",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-11T22:00:00.000Z",
      referral: "maskwars",
      quoteWaitingTimeMs: 3000,
      appFees: [{ recipient: "maskwars.near", fee: 25 }],
    });
  });

  it("asks for a memo where the network needs one, waits no time for a preview, and takes no fee when none is set", () => {
    const stellar = catalog.chains.find((c) => c.id === "stellar")!;
    const r = nearRequest({ recipient: "maskwars.near", chain: stellar, from: stellar.coins[0]!, amount: 10n, dry: true, now: NOW });
    expect(r.depositMode).toBe("MEMO");
    expect(r.quoteWaitingTimeMs).toBe(0);
    expect(r.appFees).toBeUndefined();
    expect(nearRequest({ recipient: "maskwars.near", chain: arb, from: usdtArb, amount: 1n, dry: true, fee: { recipient: "maskwars.near", fee: 0 } }).appFees).toBeUndefined();
  });

  it("refuses a coin from another network, nothing to send, or no NEAR account", () => {
    const sol = catalog.chains.find((c) => c.id === "sol")!;
    expect(() => nearRequest({ recipient: "maskwars.near", chain: arb, from: sol.coins[0]!, amount: 1n, dry: true })).toThrow();
    expect(() => nearRequest({ recipient: "maskwars.near", chain: arb, from: usdtArb, amount: 0n, dry: true })).toThrow();
    expect(() => nearRequest({ recipient: "0x3602b546589a8fcafdce7fad64a46f91db0e4d50", chain: arb, from: usdtArb, amount: 1n, dry: true })).toThrow();
  });

  it("reads the fees inside the price from 1Click's own echo, and passes the read-back", async () => {
    const pay = fakePay({ tokens, now: () => NOW.getTime() });
    const req = nearRequest({ recipient: "maskfan.near", chain: arb, from: usdtArb, amount: 25_000_000n, dry: false, fee, now: NOW });
    const echoed = { ...req, appFees: [{ recipient: "maskwars.near", fee: 13 }, { recipient: "5880ad2b", fee: 20 }] };
    const res = (await (await pay.fetch("https://1click.chaindefuser.com/v0/quote", { method: "POST", body: JSON.stringify(echoed) })).json()) as QuoteResponse;
    const v = nearQuoteView(res);
    expect(v.fees).toEqual([{ recipient: "maskwars.near", fee: 13 }, { recipient: "5880ad2b", fee: 20 }]);
    expect(feeBps(v)).toBe(33);
    expect(v.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(checkNearQuote(v, { recipient: "maskfan.near", from: usdtArb.assetId, seen: v.amountOut })).toEqual({ ok: true });
    // Someone else's account, another coin, or a refund anywhere else: not this quote.
    expect(checkNearQuote(v, { recipient: "other.near", from: usdtArb.assetId }).ok).toBe(false);
    expect(checkNearQuote(v, { recipient: "maskfan.near", from: arb.coins[1]!.assetId }).ok).toBe(false);
    expect(checkNearQuote({ ...v, refundTo: "solver.near" }, { recipient: "maskfan.near", from: usdtArb.assetId }).ok).toBe(false);
    expect(checkNearQuote({ ...v, recipientType: "INTENTS" }, { recipient: "maskfan.near", from: usdtArb.assetId }).ok).toBe(false);
    // The price slid well below the preview: a fresh look, not a failure.
    expect(checkNearQuote(v, { recipient: "maskfan.near", from: usdtArb.assetId, seen: ((BigInt(v.amountOut) * 110n) / 100n).toString() })).toMatchObject({ ok: false, moved: true });
    const shared = nearPreviewView(v);
    expect([shared.recipient, shared.refundTo, shared.depositAddress, shared.depositMemo]).toEqual([null, null, null, null]);
    expect(shared.fees).toEqual(v.fees);
  });

  it("reads the least a route takes from 1Click's refusal", () => {
    expect(minimumUsd("Temporary swap limits: minimum swap amount is $100", usdtArb)).toBe(100);
    const btc = { decimals: 8, price: 100_000 };
    expect(minimumUsd("Amount is too low for bridge, try at least 6559", btc)).toBe(6.56);
    expect(minimumUsd("Quoting for this pair is not available", usdtArb)).toBeNull();
  });
});

describe("where the swap is", () => {
  it("does not end on a short deposit: the address takes the rest until the deadline", () => {
    expect(nearFinal("short")).toBe(false);
    expect(["waiting", "seen", "moving", "short"].map((s) => nearFinal(s as never))).toEqual([false, false, false, false]);
    expect(["done", "refunded", "failed"].map((s) => nearFinal(s as never))).toEqual([true, true, true]);
  });

  const status = (s: StatusResponse["status"], details: StatusResponse["swapDetails"]): StatusResponse =>
    ({ correlationId: "aa39ab52", quoteResponse: {} as QuoteResponse, status: s, updatedAt: NOW.toISOString(), swapDetails: details }) as StatusResponse;

  it("names the NEAR transaction that paid out, which 1Click lists without an explorer link", () => {
    // As 1Click answered for swap aa39ab52… on 2026-11-11.
    const p = nearProgressOf(
      status("SUCCESS", {
        amountOut: "17999990000000000000000",
        nearTxHashes: ["G95gXaijFkDmMkL4pWFtSq655MdHtLdRdFr4g4ARPXNN", "HYZ4ycqXcvWsdfK95qmHE17TBGQz5SP1YzfqXaj8JJvJ"],
        originChainTxHashes: [],
        destinationChainTxHashes: [{ hash: "HYZ4ycqXcvWsdfK95qmHE17TBGQz5SP1YzfqXaj8JJvJ", explorerUrl: "" }],
      }),
    );
    expect(p.stage).toBe("done");
    expect(p.amountOut).toBe("17999990000000000000000");
    expect(p.landedTx).toBe("HYZ4ycqXcvWsdfK95qmHE17TBGQz5SP1YzfqXaj8JJvJ");
  });

  it("has no NEAR transaction before it is done, or when the swap was refunded", () => {
    expect(nearProgressOf(status("PROCESSING", { nearTxHashes: ["HYZ4ycqXcvWsdfK95qmHE17TBGQz5SP1YzfqXaj8JJvJ"] })).landedTx).toBeNull();
    const r = nearProgressOf(status("REFUNDED", { refundedAmount: "25000000", refundReason: "slippage" }));
    expect(r).toMatchObject({ stage: "refunded", landedTx: null, refunded: "25000000" });
    expect(nearProgressOf(status("SUCCESS", { destinationChainTxHashes: [{ hash: "not a hash", explorerUrl: "" }] })).landedTx).toBeNull();
  });
});
