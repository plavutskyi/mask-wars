import { CHAINS, type ChainId } from "./chains.ts";
import type { Token } from "./oneclick.ts";

/** A coin money can come in as or go out as, matched in 1Click's live token list. */
export interface Coin {
  /** `near` only for NEAR itself, the coin a vault holds. */
  readonly chain: ChainId | "near";
  readonly symbol: string;
  readonly assetId: string;
  readonly decimals: number;
  /** Dollars a coin, from 1Click: for showing only. */
  readonly price: number;
}

export interface CatalogChain {
  readonly id: ChainId;
  readonly name: string;
  readonly coins: readonly Coin[];
}

export interface Catalog {
  /** What a vault holds: NEAR, kept as wNEAR inside NEAR Intents. */
  readonly near: Coin;
  readonly chains: readonly CatalogChain[];
}

/** The asset a vault is topped up into. 1Click lists it as wNEAR on `near`. */
export const NEAR_ASSET = "nep141:wrap.near";

const same = (a: string | undefined, b: string, caseless: boolean) => a !== undefined && (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The offered coins, each found in `tokens` by network, symbol and contract (or by having no contract, for a network's
 * own coin). A coin 1Click does not list, or lists twice in a way that cannot be told apart, is left out. `null` when
 * 1Click does not list NEAR itself: then there is nothing to top up into.
 */
export function catalogOf(tokens: readonly Token[]): Catalog | null {
  const nearToken = tokens.find((t) => t.assetId === NEAR_ASSET && t.blockchain === "near");
  if (!nearToken || !(nearToken.price > 0)) return null;
  const chains: CatalogChain[] = [];
  for (const chain of CHAINS) {
    const caseless = chain.id !== "sol" && chain.id !== "tron";
    const coins: Coin[] = [];
    for (const spec of chain.coins) {
      const bySymbol = tokens.filter((t) => t.blockchain === chain.id && t.symbol.toUpperCase() === spec.symbol);
      const hits = spec.contract
        ? bySymbol.filter((t) => same(t.contractAddress, spec.contract!, caseless))
        : bySymbol.filter((t) => !t.contractAddress);
      const hit = hits.length === 1 ? hits[0]! : !spec.contract && bySymbol.length === 1 ? bySymbol[0]! : null;
      if (hit && hit.price > 0 && Number.isInteger(hit.decimals)) {
        coins.push({ chain: chain.id, symbol: spec.symbol, assetId: hit.assetId, decimals: hit.decimals, price: hit.price });
      }
    }
    if (coins.length) chains.push({ id: chain.id, name: chain.name, coins });
  }
  return {
    near: { chain: "near", symbol: "NEAR", assetId: NEAR_ASSET, decimals: nearToken.decimals, price: nearToken.price },
    chains,
  };
}

/** Every coin a vault can hold: NEAR, and whatever a refund leaves in it. */
export function vaultCoins(c: Catalog): Coin[] {
  return [c.near, ...c.chains.flatMap((ch) => ch.coins)];
}

export function coinOf(c: Catalog, assetId: string): Coin | null {
  return vaultCoins(c).find((x) => x.assetId === assetId) ?? null;
}
