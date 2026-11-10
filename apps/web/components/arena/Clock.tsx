'use client';

import { useEffect, useState } from 'react';

/** A clock that runs on the device: time to `to`, or time since `from`. */
export function Clock({ to, from, className }: { to?: number | undefined; from?: number | undefined; className?: string | undefined }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (now === null) return <span className={className}>&nbsp;</span>;
  const ms = to !== undefined ? to - now : now - (from ?? now);
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return <span className={className}>{h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`}</span>;
}
