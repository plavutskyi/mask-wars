'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { encode } from 'uqr';
import s from './near.module.css';

// Small pieces Get NEAR and Swap share: the copy mark, the tick, the QR code of a deposit address, copying, the clock.

export function CopyGlyph() {
  return (
    <svg className={s.copyGlyph} viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" />
      <path d="M10.5 3.5v-1h-8v8h1" />
    </svg>
  );
}

export function Tick() {
  return (
    <svg className={s.tick} viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M3 8.5l3.2 3L13 4.5" />
    </svg>
  );
}

/** A QR code for an address, one SVG path: ink modules on ice, as scanners expect. On a phone it waits for a tap. */
export function Qr({ text, label, shown }: { text: string; label: string; shown: boolean }) {
  const path = useMemo(() => {
    const { data, size } = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`;
    return { d, size };
  }, [text]);
  return (
    <svg className={s.qr} data-shown={shown ? '' : undefined} viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={path.size} height={path.size} className={s.qrPaper} />
      <path d={path.d} className={s.qrInk} />
    </svg>
  );
}

/** Copies `text`, and says so for a moment. */
export function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return [
    copied,
    (key, text) => {
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(key);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(null), 1600);
        },
        () => setCopied(null),
      );
    },
  ];
}

/** The clock, once a second, while a countdown is on screen. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}
