import { final, type Stage } from '@maskwars/pay';

/**
 * How a signed cash-out ended. `none`: its intent ran out without moving anything. `away`: it left the vault and 1Click
 * is still delivering it (or refunding it) past the quote's time. `unknown`: neither 1Click nor the vault could be read.
 */
export type EndKind = 'done' | 'back' | 'failed' | 'none' | 'away' | 'unknown';

/**
 * Whether a cash-out being followed has settled, from 1Click's stage (`null` when it did not answer), the clock, and, once
 * its intent can no longer move anything (`until`), the vault: `null` means keep following it.
 */
export function settleOf(o: {
  stage: Stage | null;
  now: number;
  until: number;
  /** Units of the coin the vault held when the cash-out started, and what it sends. */
  before: string;
  units: string;
  /** What the vault holds of that coin now; `null` when it cannot be read. Only asked once `until` has passed. */
  held?: () => string | null;
}): EndKind | null {
  if (o.stage && final(o.stage)) return o.stage === 'done' ? 'done' : o.stage === 'failed' ? 'failed' : 'back';
  if (o.now < o.until) return null;
  if (o.stage === 'seen' || o.stage === 'moving') return 'away';
  if (o.stage === 'waiting') return 'none';
  const held = o.held?.() ?? null;
  if (held === null) return 'unknown';
  return BigInt(held) + BigInt(o.units) <= BigInt(o.before) ? 'away' : 'none';
}

/** When to ask for the coins on offer again after `n` failures: 1.5, 3, 6, 12 seconds, then `null` (say so, offer a retry). */
export const catalogDelay = (n: number): number | null => (n >= 4 ? null : 1500 * 2 ** n);
