import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addressOk,
  base58,
  base64,
  base64url,
  cashOutRequest,
  catalogOf,
  CHAINS,
  coinOf,
  coinText,
  depositUnits,
  dollars,
  fromBase58,
  fromBase64,
  fromBase64url,
  fromUnits,
  NEAR_ASSET,
  parseDollars,
  topUpRequest,
  toUnits,
  tooSmall,
  unitsForUsd,
  usdOf,
  utf8,
  vaultCoins,
  vaultOf,
  type Token,
} from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/oneclick.json", import.meta.url), "utf8"));
const tokens = fx.tokens as Token[];

describe("codecs", () => {
  it("base58 matches the reference vectors", () => {
    expect(base58(utf8("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(base58(Uint8Array.of(0, 0, 0x28, 0x7f, 0xb4, 0xcd))).toBe("11233QC4");
    expect(base58(new Uint8Array())).toBe("");
    expect(fromBase58("11233QC4")).toEqual(Uint8Array.of(0, 0, 0x28, 0x7f, 0xb4, 0xcd));
    expect(fromBase58("0OIl")).toBeNull();
    const r = crypto.getRandomValues(new Uint8Array(64));
    expect(fromBase58(base58(r))).toEqual(r);
  });

  it("base64 and base64url round-trip, and refuse junk", () => {
    const r = crypto.getRandomValues(new Uint8Array(33));
    expect(fromBase64(base64(r))).toEqual(r);
    expect(fromBase64url(base64url(r))).toEqual(r);
    expect(base64url(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
    expect(fromBase64("a$b=")).toBeNull();
    expect(fromBase64url("a+b")).toBeNull();
  });
});

describe("amounts", () => {
  it("parse what people type and print it back", () => {
    expect(toUnits("25", 6)).toBe(25_000_000n);
    expect(toUnits("0.5", 9)).toBe(500_000_000n);
    expect(toUnits("1,000.25", 6)).toBe(1_000_250_000n);
    expect(toUnits(".5", 6)).toBe(500_000n);
    expect(toUnits("1.1234567", 6)).toBeNull();
    expect(toUnits("abc", 6)).toBeNull();
    expect(fromUnits(25_500_000n, 6)).toBe("25.5");
    expect(fromUnits("8395312187423519000000000", 24, 4)).toBe("8.3953");
  });

  it("show a coin the way people read it, never more than there is", () => {
    expect(coinText("8395312187423519000000000", 24)).toBe("8.39");
    expect(coinText(173_612_345n, 9)).toBe("0.1736");
    expect(coinText(42_000n, 8)).toBe("0.00042");
    expect(coinText(1_284_500_000n, 6)).toBe("1,284.5");
    expect(coinText(0n, 24)).toBe("0");
  });

  it("show dollars with cents, round when asked, never a negative", () => {
    expect(dollars(12.4)).toBe("$12.40");
    expect(dollars(1284.1)).toBe("$1,284.10");
    expect(dollars(25, { round: true })).toBe("$25");
    expect(dollars(24.99, { round: true })).toBe("$24.99");
    expect(dollars(0.004)).toBe("<$0.01");
    expect(dollars(0)).toBe("$0");
    expect(dollars(-3)).toBe("$0");
  });

  it("ask for a round amount a person can type into a wallet", () => {
    expect(depositUnits(25, { symbol: "USDC", price: 0.9998, decimals: 6 })).toBe(25_000_000n);
    expect(depositUnits(10, { symbol: "USDT", price: 1.0001, decimals: 6 })).toBe(10_000_000n);
    expect(depositUnits(25, { symbol: "SOL", price: 187.42, decimals: 9 })).toBe(133_400_000n);
    expect(depositUnits(25, { symbol: "BTC", price: 101240, decimals: 8 })).toBe(24_700n);
    expect(depositUnits(25, { symbol: "ETH", price: 3412.5, decimals: 18 })).toBe(7_327_000_000_000_000n);
  });

  it("convert between dollars and a coin's units", () => {
    expect(unitsForUsd(25, 1, 6)).toBe(25_000_000n);
    expect(unitsForUsd(25, 187.42, 9)).toBe(133_390_246n);
    expect(unitsForUsd(10, 101240, 8)).toBe(9_877n);
    expect(usdOf("8395312187423519000000000", 24, 2.97)).toBeCloseTo(24.934, 2);
    expect(parseDollars("$25")).toBe(25);
    expect(parseDollars("12.5")).toBe(12.5);
    expect(parseDollars("0")).toBeNull();
    expect(parseDollars("10000")).toBeNull();
    expect(parseDollars("1.234")).toBeNull();
  });
});

describe("addresses", () => {
  it("accept each network's own sample address", () => {
    for (const c of CHAINS) expect([c.id, addressOk(c.id, c.example)]).toEqual([c.id, true]);
  });

  it("accept real address forms and refuse a one-letter slip", () => {
    expect(addressOk("base", "0x71c7656ec7ab88b098defb751b7401b5f6d8976f")).toBe(true);
    expect(addressOk("base", "0x71C7656EC7ab88b098defB751B7401B5f6d8976f")).toBe(false); // checksum
    expect(addressOk("eth", "0x71C7656EC7ab88b098defB751B7401B5f6d8976")).toBe(false);
    expect(addressOk("sol", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgA")).toBe(false); // 31 bytes
    expect(addressOk("sol", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAs0")).toBe(false);
    expect(addressOk("sol", "0x71c7656ec7ab88b098defb751b7401b5f6d8976f")).toBe(false);
    expect(addressOk("tron", "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU8")).toBe(false);
    expect(addressOk("btc", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toBe(true);
    expect(addressOk("btc", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe(true);
    expect(addressOk("btc", "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297")).toBe(true);
    expect(addressOk("btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr")).toBe(false);
    expect(addressOk("btc", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3")).toBe(false);
    expect(addressOk("btc", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBe(false);
  });
});

describe("catalog", () => {
  const cat = catalogOf(tokens)!;

  it("offers each network's coins, found by contract, with NEAR to hold", () => {
    expect(cat.near).toMatchObject({ assetId: NEAR_ASSET, decimals: 24, symbol: "NEAR" });
    expect(cat.chains.map((c) => `${c.name}:${c.coins.map((x) => x.symbol).join("+")}`)).toEqual([
      "Solana:USDC+SOL",
      "Base:USDC+ETH",
      "Ethereum:USDC+ETH",
      "Arbitrum:USDC+ETH",
      "Tron:USDT+TRX",
      "Bitcoin:BTC",
    ]);
    expect(coinOf(cat, "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near")?.symbol).toBe("USDC");
    expect(vaultCoins(cat)[0]!.assetId).toBe(NEAR_ASSET);
  });

  it("leaves out a coin whose contract does not match, and has nothing without NEAR", () => {
    const fake = tokens.map((t) => (t.blockchain === "base" && t.symbol === "USDC" ? { ...t, contractAddress: "0x0000000000000000000000000000000000000001" } : t));
    expect(catalogOf(fake)!.chains.find((c) => c.id === "base")!.coins.map((c) => c.symbol)).toEqual(["ETH"]);
    expect(catalogOf(tokens.filter((t) => t.assetId !== NEAR_ASSET))).toBeNull();
  });

  it("sums a vault in dollars, NEAR first, empty coins left out", () => {
    const coins = vaultCoins(cat);
    const balances = coins.map((c) => (c.assetId === NEAR_ASSET ? 4_210_000_000_000_000_000_000_000n : c.symbol === "USDC" && c.chain === "sol" ? 5_000_000n : 0n));
    const v = vaultOf("0xabc", cat, balances);
    expect(v.holdings.map((h) => h.coin.symbol)).toEqual(["NEAR", "USDC"]);
    expect(v.near).toBe("4210000000000000000000000");
    expect(cat.near.price).toBe(3.7);
    expect(v.usd).toBeCloseTo(4.21 * 3.7 + 5 * 0.999575, 4);
  });
});

describe("quotes", () => {
  const cat = catalogOf(tokens)!;
  const usdcSol = cat.chains[0]!.coins[0]!;
  const usdcBase = cat.chains[1]!.coins[0]!;
  it("top up: any coin in, NEAR into the vault, refunds back to the vault, as 1Click took it", () => {
    const req = topUpRequest({ account: fx.account, from: usdcSol, amount: depositUnits(10, usdcSol), dry: false, now: new Date("2026-11-08T10:48:32.562Z") });
    // 1Click echoes the request back with its own fields added; every field this app sends came back as sent.
    expect(fx.topUp.wet.quoteRequest).toMatchObject(req);
    const preview = topUpRequest({ account: fx.account, from: usdcSol, amount: depositUnits(10, usdcSol), dry: true, now: new Date("2026-11-08T10:48:31.644Z") });
    expect(fx.topUp.dry.quoteRequest).toMatchObject(preview);
    expect(preview.quoteWaitingTimeMs).toBe(0);
    expect(req.quoteWaitingTimeMs).toBe(3000);
  });

  it("cash out: from the vault's NEAR Intents balance to an address on any network", () => {
    const req = cashOutRequest({
      account: fx.account,
      from: cat.near,
      to: usdcBase,
      recipient: " 0x71C7656EC7ab88b098defB751B7401B5f6d8976F ",
      amount: 3_000_000_000_000_000_000_000_000n,
      dry: false,
      now: new Date("2026-11-08T10:48:36.477Z"),
    });
    expect(fx.cashOut.wet.quoteRequest).toMatchObject(req);
  });

  it("refuses an empty amount", () => {
    expect(() => topUpRequest({ account: fx.account, from: usdcSol, amount: 0n, dry: true })).toThrow();
    expect(() => cashOutRequest({ account: fx.account, from: cat.near, to: usdcBase, recipient: "0x", amount: 0n, dry: true })).toThrow();
  });

  it("knows 1Click's minimum-amount refusal", () => {
    expect(tooSmall(fx.errors.tooSmall.body.message)).toBe(true);
    expect(tooSmall("recipient is invalid")).toBe(false);
  });
});
