const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** $25,000 from whole dollars. */
export function usd(n: number): string {
  return `$${whole.format(n)}`;
}

/** 1,284 */
export function count(n: number): string {
  return whole.format(n);
}

/** 03:12 from ms, 23:58:40 past the hour, never negative. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Countdown: rounds up so it never shows 00:00 before the moment. */
export function countdown(ms: number): string {
  return clock(Math.ceil(Math.max(0, ms) / 1000) * 1000);
}

/** 3:12 for a short span, 24 hours for a day. */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 3600) {
    const h = Math.round(s / 3600);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
