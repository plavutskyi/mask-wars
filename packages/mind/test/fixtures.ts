import type { MarketSnapshot } from "../src/market.ts";

/** A calm market: SOL runs, ZEC bleeds, ETH beats BTC over the hour, NEAR beats ZEC. */
export const MARKET: MarketSnapshot = {
  at: 1_762_000_000_000,
  coins: {
    BTC: { price: 104_000, m5: 4, h1: 10, h24: -120 },
    ETH: { price: 3_900, m5: 8, h1: 55, h24: -60 },
    SOL: { price: 190, m5: 40, h1: 120, h24: 300 },
    NEAR: { price: 3.1, m5: 12, h1: 70, h24: -40 },
    ZEC: { price: 61, m5: -30, h1: -90, h24: -900 },
  },
};
