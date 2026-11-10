/** Money as the engine keeps it: USDC in minimal units (6 decimals), carried in JSON as a decimal string. */

export const USDC = 1_000_000n;

export const parseUsdc = (s: string): bigint => BigInt(s);

/** `$5`, `$41`, `$4.60`, `$1,240`: cents only when they are there and the sum is under a thousand. */
export function usd(micro: bigint): string {
  const cents = (micro + 5_000n) / 10_000n;
  const whole = cents / 100n;
  const rest = cents % 100n;
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return rest === 0n || whole >= 1000n ? `$${w}` : `$${w}.${rest.toString().padStart(2, "0")}`;
}

/** Payout over stake, rounded down to one decimal: a card never shows more than was won. */
export function multiple(stake: bigint, payout: bigint): number {
  if (stake <= 0n) throw new Error("stake must be positive");
  return Number((payout * 10n) / stake) / 10;
}

/** `×8.2`, `×12`. */
export const times = (m: number): string => `×${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)}`;

/** On a card: whole dollars from $10 up, rounded down, so the big number stays short and never shows more than won. */
export const usdCard = (micro: bigint): string => (micro >= 10n * USDC ? usd((micro / USDC) * USDC) : usd(micro));
