// Quality tiers. `high` for desks, `mid` for a decent phone, `low` is the simplified scene: no mirror pass,
// standard materials, pixel ratio 1. `auto` starts from the device and steps down when frames run slow.

export type Tier = 'high' | 'mid' | 'low';

export interface TierSpec {
  dpr: number;
  /** Mirror floor resolution against the drawing buffer; 0 = no mirror pass. */
  mirror: number;
  /** Streak taps in the wet floor. */
  taps: number;
}

export const TIERS: Record<Tier, TierSpec> = {
  high: { dpr: 2, mirror: 0.5, taps: 9 },
  mid: { dpr: 1.5, mirror: 0.34, taps: 6 },
  low: { dpr: 1, mirror: 0, taps: 0 },
};

/** First guess before any frame is measured. */
export function guessTier(): Tier {
  if (typeof window === 'undefined') return 'mid';
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores <= 4 || memory <= 2) return coarse ? 'low' : 'mid';
  return coarse ? 'mid' : 'high';
}

export const down = (t: Tier): Tier => (t === 'high' ? 'mid' : 'low');
