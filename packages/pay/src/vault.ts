import { usdOf } from "./amount.ts";
import { vaultCoins, type Catalog, type Coin } from "./catalog.ts";

/** One coin in a vault, with what it is worth now. */
export interface Holding {
  readonly coin: Coin;
  /** Units, as a decimal string. */
  readonly units: string;
  readonly usd: number;
}

/** A vault as its page shows it: the total in dollars, NEAR first, then whatever else is in it. */
export interface Vault {
  readonly account: string;
  readonly usd: number;
  /** Units of NEAR. */
  readonly near: string;
  readonly holdings: readonly Holding[];
}

/** Builds a vault from `balances`, read in the order of `vaultCoins(catalog)`. Coins with nothing in them are left out. */
export function vaultOf(account: string, catalog: Catalog, balances: readonly bigint[]): Vault {
  const coins = vaultCoins(catalog);
  if (balances.length !== coins.length) throw new Error("one balance per coin");
  const holdings: Holding[] = [];
  coins.forEach((coin, i) => {
    const units = balances[i]!;
    if (units > 0n) holdings.push({ coin, units: units.toString(), usd: usdOf(units, coin.decimals, coin.price) });
  });
  holdings.sort((a, b) => (a.coin.assetId === catalog.near.assetId ? -1 : b.coin.assetId === catalog.near.assetId ? 1 : b.usd - a.usd));
  return {
    account,
    usd: holdings.reduce((n, h) => n + h.usd, 0),
    near: holdings.find((h) => h.coin.assetId === catalog.near.assetId)?.units ?? "0",
    holdings,
  };
}
