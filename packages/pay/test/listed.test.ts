import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BTC_ASSET, ETH_ASSET, LISTED, listedOf, listedTokens, NETWORKS, networkOf, nearCatalogOf, ownCoinHere, priceSane, swapCatalogOf, tokenLink, type Token } from "../src/index.ts";

// The whole token list 1Click answered with on 2026-11-11.
const tokens = JSON.parse(readFileSync(new URL("./fixtures/tokens.json", import.meta.url), "utf8")).tokens as Token[];
const byId = new Map(tokens.map((t) => [t.assetId, t]));
const sources = readFileSync(new URL("../src/listed.sources.md", import.meta.url), "utf8");

describe("the list", () => {
  it("pins every coin to an asset id 1Click lists, on the network and with the contract it names", () => {
    for (const l of LISTED) {
      const t = byId.get(l.assetId);
      expect(t, l.assetId).toBeDefined();
      expect(t!.blockchain, l.assetId).toBe(l.chain);
      expect(t!.contractAddress ?? null, l.assetId).toBe(l.contract);
      expect(networkOf(l.chain), l.chain).not.toBeNull();
    }
    expect(new Set(LISTED.map((l) => l.assetId)).size).toBe(LISTED.length);
    expect(listedTokens(tokens)).toHaveLength(LISTED.length);
  });

  it("keeps an EVM token when 1Click sends its address checksummed, and drops one on another contract", () => {
    const arb = LISTED.find((l) => l.chain === "arb" && l.symbol === "USDT")!;
    const upper = tokens.map((t) => (t.assetId === arb.assetId ? { ...t, contractAddress: `0x${arb.contract!.slice(2).toUpperCase()}` } : t));
    expect(listedTokens(upper).some((x) => x.listed === arb)).toBe(true);
    const other = tokens.map((t) => (t.assetId === arb.assetId ? { ...t, contractAddress: `0x${"1".repeat(40)}` } : t));
    expect(listedTokens(other).some((x) => x.listed === arb)).toBe(false);
    const tron = LISTED.find((l) => l.chain === "tron" && l.symbol === "USDT")!;
    const lower = tokens.map((t) => (t.assetId === tron.assetId ? { ...t, contractAddress: tron.contract!.toLowerCase() } : t));
    expect(listedTokens(lower).some((x) => x.listed === tron)).toBe(false);
  });

  it("has about sixty mainstream coins on about twenty networks, each network with a coin", () => {
    expect(LISTED.length).toBe(62);
    expect(NETWORKS).toHaveLength(21);
    for (const n of NETWORKS) expect(LISTED.some((l) => l.chain === n.id), n.id).toBe(true);
  });

  it("shows one symbol once per network, and at most one USDT and one USDC", () => {
    for (const n of NETWORKS) {
      const here = LISTED.filter((l) => l.chain === n.id).map((l) => l.symbol);
      expect(new Set(here).size, n.id).toBe(here.length);
    }
    const usdt = LISTED.filter((l) => l.symbol === "USDT").map((l) => l.chain);
    const usdc = LISTED.filter((l) => l.symbol === "USDC").map((l) => l.chain);
    expect(usdt).toEqual(["near", "eth", "tron", "arb", "sol", "bsc", "pol", "op", "avax", "ton", "aptos"]);
    expect(usdc).toEqual(["near", "eth", "arb", "sol", "bsc", "base", "pol", "op", "avax", "sui", "aptos"]);
  });

  it("names every stablecoin contract in listed.sources.md, where it was checked against its issuer", () => {
    for (const l of LISTED.filter((x) => x.peg === "usd" && x.contract)) expect(sources, `${l.chain} ${l.symbol}`).toContain(l.contract!);
  });

  it("uses the stablecoin contracts the issuers name, never a bridged one", () => {
    const at = (chain: string, symbol: string) => LISTED.find((l) => l.chain === chain && l.symbol === symbol)!.contract;
    // Tether's USD₮0 on Arbitrum, Optimism and Polygon, not the old bridged USDT on Optimism.
    expect(at("arb", "USDT")).toBe("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9");
    expect(at("op", "USDT")).toBe("0x01bff41798a0bcf287b996046ca68b395dbc1071");
    expect(LISTED.some((l) => l.contract === "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58")).toBe(false);
    // Circle's native USDC, not USDC.e.
    expect(at("arb", "USDC")).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(at("op", "USDC")).toBe("0x0b2c639c533813f4aa9d7837caf62653d097ff85");
    expect(at("pol", "USDC")).toBe("0x3c499c542cef5e3811e1192ce70d8cc03d5c3359");
    expect(at("base", "USDC")).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    // Not the "(DEPRECATED)" doubles 1Click keeps on BNB Chain, Polygon and Avalanche.
    for (const l of LISTED) expect(byId.get(l.assetId)!.symbol).not.toMatch(/DEPRECATED/);
  });
});

describe("the explorer of every network", () => {
  it("opens a token's own page by its contract", () => {
    const at = (chain: string, symbol: string) => {
      const l = LISTED.find((x) => x.chain === chain && x.symbol === symbol)!;
      return tokenLink(chain, l.contract);
    };
    expect(at("near", "USDT")).toEqual({ name: "NearBlocks", href: "https://nearblocks.io/token/usdt.tether-token.near" });
    expect(at("eth", "USDT")).toEqual({ name: "Etherscan", href: "https://etherscan.io/token/0xdac17f958d2ee523a2206206994597c13d831ec7" });
    expect(at("tron", "USDT")).toEqual({ name: "Tronscan", href: "https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" });
    expect(at("arb", "USDT")).toEqual({ name: "Arbiscan", href: "https://arbiscan.io/token/0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" });
    expect(at("sol", "USDC")).toEqual({ name: "Solscan", href: "https://solscan.io/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" });
    expect(at("bsc", "USDT")).toEqual({ name: "BscScan", href: "https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955" });
    expect(at("base", "USDC")).toEqual({ name: "Basescan", href: "https://basescan.org/token/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" });
    expect(at("pol", "USDT")).toEqual({ name: "PolygonScan", href: "https://polygonscan.com/token/0xc2132d05d31c914a87c6611c10748aeb04b58e8f" });
    expect(at("op", "USDT")).toEqual({ name: "Optimistic Etherscan", href: "https://optimistic.etherscan.io/token/0x01bff41798a0bcf287b996046ca68b395dbc1071" });
    expect(at("avax", "USDC")).toEqual({ name: "Snowtrace", href: "https://snowtrace.io/token/0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e" });
    expect(at("ton", "USDT")).toEqual({ name: "Tonviewer", href: "https://tonviewer.com/EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs" });
    expect(at("sui", "USDC")).toEqual({ name: "Suiscan", href: "https://suiscan.xyz/mainnet/coin/0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC" });
    expect(at("aptos", "USDT")).toEqual({
      name: "Aptos Explorer",
      href: "https://explorer.aptoslabs.com/fungible_asset/0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b?network=mainnet",
    });
  });

  it("has a page for every token listed, and none for a network's own coin", () => {
    for (const l of LISTED) {
      const link = tokenLink(l.chain, l.contract);
      if (l.contract === null) expect(link, l.assetId).toBeNull();
      else if (!l.native) expect(link?.href, l.assetId).toMatch(/^https:\/\/[a-z.]+\//);
    }
    expect(tokenLink("btc", null)).toBeNull();
    expect(tokenLink("nowhere", "0xabc")).toBeNull();
  });

  it("marks a network's own coin on its own network, never Ether on a rollup", () => {
    expect(ownCoinHere("eth", { native: true })).toBe(true);
    expect(ownCoinHere("near", { native: true })).toBe(true);
    expect(ownCoinHere("arb", { native: true })).toBe(false);
    expect(ownCoinHere("base", { native: true })).toBe(false);
    expect(ownCoinHere("eth", { native: false })).toBe(false);
  });
});

describe("a price that cannot be right", () => {
  const price = (over: Record<string, number>) => tokens.map((t) => (t.assetId in over ? { ...t, price: over[t.assetId]! } : t));
  const usdtArb = "nep141:arb-0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9.omft.near";
  const wbtc = "nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near";
  const stnear = "nep141:meta-pool.near";

  it("hides a stablecoin more than 3% off a dollar instead of selling it at that price", () => {
    expect(swapCatalogOf(price({ [usdtArb]: 0.95 }))!.chains.flatMap((c) => c.coins).some((c) => c.assetId === usdtArb)).toBe(false);
    expect(nearCatalogOf(price({ [usdtArb]: 1.000001e-6 }))!.chains.flatMap((c) => c.coins).some((c) => c.assetId === usdtArb)).toBe(false);
    expect(swapCatalogOf(price({ [usdtArb]: 0.985 }))!.chains.flatMap((c) => c.coins).some((c) => c.assetId === usdtArb)).toBe(true);
  });

  it("hides wrapped bitcoin far from Bitcoin, Ether far from Ether, and a staked coin out of its range", () => {
    const btc = byId.get(BTC_ASSET)!.price;
    const eth = byId.get(ETH_ASSET)!.price;
    const near = byId.get("nep141:wrap.near")!.price;
    const of = (id: string) => byId.get(id)?.price ?? null;
    expect(priceSane(listedOf(wbtc)!, btc * 0.99, of)).toBe(true);
    expect(priceSane(listedOf(wbtc)!, btc * 0.5, of)).toBe(false);
    expect(priceSane(listedOf("nep141:arb.omft.near")!, eth * 1.2, of)).toBe(false);
    expect(priceSane(listedOf(stnear)!, near * 1.4, of)).toBe(true);
    expect(priceSane(listedOf(stnear)!, near * 0.5, of)).toBe(false);
    expect(priceSane(listedOf(stnear)!, 0, of)).toBe(false);
    // With Bitcoin itself unpriced there is nothing to hold wrapped bitcoin to: it is hidden too.
    expect(priceSane(listedOf(wbtc)!, btc, () => null)).toBe(false);
  });

  it("hides a coin whose contract 1Click now names differently", () => {
    const moved = tokens.map((t) => (t.assetId === usdtArb ? { ...t, contractAddress: "0x0000000000000000000000000000000000000001" } : t));
    expect(listedTokens(moved).some((x) => x.listed.assetId === usdtArb)).toBe(false);
  });
});
