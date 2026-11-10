/** Amounts: integer units of a coin as bigint inside, plain words outside. Dollars are for showing only: every amount
 * that moves money is a coin amount in units. */

/** "25", "0.5", "1,000.25" as a person types it, in units of a coin with `decimals`. `null` for anything else. */
export function toUnits(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/[,\s]/g, "");
  const m = /^(\d{1,15})(?:\.(\d*))?$/.exec(t) ?? /^()\.(\d+)$/.exec(t);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals) return null;
  return BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Units back to a decimal string, rounded down to `digits` decimals, trailing zeros dropped: `8.42`, `0.1736`, `25`. */
export function fromUnits(units: bigint | string, decimals: number, digits = decimals): string {
  const u = BigInt(units);
  if (u < 0n) return `-${fromUnits(-u, decimals, digits)}`;
  const d = Math.min(digits, decimals);
  const scaled = u / 10n ** BigInt(decimals - d);
  const base = 10n ** BigInt(d);
  const whole = scaled / base;
  const frac = d > 0 ? (scaled % base).toString().padStart(d, "0").replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * A coin amount as a person reads it: two decimals from 1 up, four significant digits below 1, never rounded up (so it
 * never shows more than there is): `4.21`, `0.1736`, `0.00042`, `1,284.5`.
 */
export function coinText(units: bigint | string, decimals: number): string {
  const u = BigInt(units);
  const one = 10n ** BigInt(decimals);
  let digits = 2;
  if (u > 0n && u < one) {
    // Leading zeros after the point, then four significant digits.
    const lead = decimals - u.toString().length;
    digits = Math.min(decimals, lead + 4);
  }
  const text = fromUnits(u, decimals, digits);
  const [whole, frac] = text.split(".");
  const grouped = BigInt(whole!).toLocaleString("en-US");
  return frac ? `${grouped}.${frac}` : grouped;
}

const cents = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** `$12.40`, `$1,284.10`, `$25` for whole round amounts with `round`, `<$0.01` for dust. */
export function dollars(n: number, { round = false }: { round?: boolean } = {}): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (round && Math.abs(n - Math.round(n)) < 0.005) return `$${whole.format(Math.round(n))}`;
  return `$${cents.format(Math.floor(n * 100 + 1e-6) / 100)}`;
}

/** What `units` of a coin are worth in dollars at `price` dollars a coin. */
export function usdOf(units: bigint | string, decimals: number, price: number): number {
  const u = BigInt(units);
  const scale = 10n ** BigInt(Math.max(0, decimals - 9));
  return (Number(u / scale) / 10 ** Math.min(decimals, 9)) * price;
}

/** The units of a coin that `usd` dollars buy at `price`, rounded down. */
export function unitsForUsd(usd: number, price: number, decimals: number): bigint {
  if (!(usd > 0) || !(price > 0)) return 0n;
  // Up to twelve decimals in floating point (well inside its precision for any amount here), the rest in bigint.
  const p = Math.min(decimals, 12);
  const scaled = Math.floor((usd / price) * 10 ** p + 1e-6);
  return BigInt(scaled) * 10n ** BigInt(decimals - p);
}

/** Stablecoins: a dollar is one coin, so $25 is sent as exactly 25. */
export const STABLE = new Set(["USDC", "USDT"]);

/**
 * How much of a coin to send for `usd` dollars, as a number a person can type into a wallet: exactly the dollars for a
 * stablecoin, otherwise rounded up to four significant digits (`0.1334 SOL`, `0.0002470 BTC`).
 */
export function depositUnits(usd: number, coin: { symbol: string; price: number; decimals: number }): bigint {
  if (STABLE.has(coin.symbol)) return unitsForUsd(usd, 1, coin.decimals);
  const units = unitsForUsd(usd, coin.price, coin.decimals);
  if (units <= 0n) return 0n;
  const digits = units.toString().length;
  if (digits <= 4) return units;
  const step = 10n ** BigInt(digits - 4);
  return ((units + step - 1n) / step) * step;
}

/** `$25` from what a person types: 1 to 9 999 dollars with up to two decimals. */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/[,\s]/g, "");
  if (!/^\d{1,4}(?:\.\d{0,2})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}
