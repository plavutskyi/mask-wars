// Money on the vault: real numbers only, no rounding that changes what they say.

import type { ArenaMoney } from './types';

const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fine = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

/** Digits of an amount: $25,000 · 3 · 0.08664 · 1,250. */
export function digits(m: ArenaMoney): string {
  if (m.text) return m.unit === 'USD' && !m.text.startsWith('$') ? '$' + m.text : m.text;
  if (m.unit === 'USD') return '$' + whole.format(m.amount);
  const a = Math.abs(m.amount);
  if (a >= 1000) return whole.format(m.amount);
  // Four significant digits, trailing zeros dropped: 3 · 2.5 · 0.08664 · 12.35.
  return a === 0 ? '0' : fine.format(Number(m.amount.toPrecision(4)));
}

/** Unit word after the digits, or nothing for dollars. */
export const unitWord = (m: ArenaMoney): string | null => (m.unit === 'NEAR' ? 'NEAR' : null);

/** For screen readers: “3 NEAR”, “$25,000”. */
export const spoken = (m: ArenaMoney): string => (m.unit === 'NEAR' ? digits(m) + ' NEAR' : digits(m));
