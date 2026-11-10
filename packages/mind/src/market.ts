import { BASKET, type Coin } from "./masks.ts";

/**
 * Open market data, handed in by the caller. The mind never fetches prices itself: one snapshot per minute is shared
 * by every mask in every fight, so a minute costs one fetch, not one per mask.
 */
export interface CoinQuote {
  /** USD price. */
  readonly price: number;
  /** Change over the last 5 minutes, in basis points. */
  readonly m5: number;
  /** Change over the last hour, in basis points. */
  readonly h1: number;
  /** Change over the last 24 hours, in basis points. */
  readonly h24: number;
}

export interface MarketSnapshot {
  /** Unix milliseconds the snapshot was taken. */
  readonly at: number;
  readonly coins: Readonly<Record<Coin, CoinQuote>>;
}

/** Coins of `allowed`, strongest short-term momentum first (5m, then 1h). Stable for equal values. */
export function byMomentum(market: MarketSnapshot, allowed: readonly Coin[] = BASKET): Coin[] {
  return [...allowed].sort((a, b) => {
    const qa = market.coins[a];
    const qb = market.coins[b];
    return qb.m5 - qa.m5 || qb.h1 - qa.h1 || BASKET.indexOf(a) - BASKET.indexOf(b);
  });
}

/** Coins of `allowed`, deepest 24h drop first (then 1h). */
export function byDrawdown(market: MarketSnapshot, allowed: readonly Coin[] = BASKET): Coin[] {
  return [...allowed].sort((a, b) => {
    const qa = market.coins[a];
    const qb = market.coins[b];
    return qa.h24 - qb.h24 || qa.h1 - qb.h1 || BASKET.indexOf(a) - BASKET.indexOf(b);
  });
}

/**
 * The market as the model reads it: compact, deterministic, the same bytes for every mask in the same minute, so the
 * provider's prompt cache serves the shared prefix.
 */
export function marketDigest(market: MarketSnapshot): string {
  return BASKET.map((c) => {
    const q = market.coins[c];
    return `${c} ${q.price} 5m:${q.m5}bp 1h:${q.h1}bp 24h:${q.h24}bp`;
  }).join("\n");
}

/** A tiny time-boxed memo for data every mask shares within a minute: digests, rival history, the system prompt. */
export class SharedCache<V> {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { value: V; until: number }>();

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get(key: string, make: () => V): V {
    const t = this.#now();
    const hit = this.#entries.get(key);
    if (hit && hit.until > t) return hit.value;
    const value = make();
    this.#entries.set(key, { value, until: t + this.#ttlMs });
    if (this.#entries.size > 512) {
      for (const [k, e] of this.#entries) if (e.until <= t) this.#entries.delete(k);
    }
    return value;
  }

  get size(): number {
    return this.#entries.size;
  }
}
