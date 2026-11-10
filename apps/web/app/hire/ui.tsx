'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { encode } from 'uqr';

/** Copies `text`, and says so for a moment; where the clipboard is shut (a locked frame), selects `fallback` instead. */
export function useCopy(): [string | null, (key: string, text: string, fallback?: Element | null) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return [
    copied,
    (key, text, fallback) => {
      const done = () => {
        setCopied(key);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1600);
      };
      const select = () => {
        const sel = window.getSelection();
        if (!fallback || !sel) return;
        const range = document.createRange();
        range.selectNodeContents(fallback);
        sel.removeAllRanges();
        sel.addRange(range);
      };
      if (!navigator.clipboard) return select();
      void navigator.clipboard.writeText(text).then(done, select);
    },
  ];
}

/** The clock, once a second, for countdowns. */
export function useNow(on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** 29:41, or 1:59:41. */
export function mmss(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `acme.near`, `0x3602…4d50`: an account short enough for one line, its ends intact. */
export function shortAccount(a: string): string {
  return a.length <= 22 ? a : `${a.slice(0, 8)}…${a.slice(-6)}`;
}

/**
 * A vault as the card names it: a named account whole (`northwind-lend.near`, every letter counts), an implicit one
 * (a passkey's `0x…`, a key's 64 hex) by its ends, which is how the payer's own wallet shows it.
 */
export function vaultName(a: string): string {
  return /^0x[0-9a-f]{40}$/.test(a) || /^[0-9a-f]{64}$/.test(a) ? shortAccount(a) : a;
}

/** A QR code for an address, one SVG path: ink modules on ice, as scanners expect. */
export function Qr({ text, label, className, paper, ink }: { text: string; label: string; className?: string | undefined; paper?: string | undefined; ink?: string | undefined }) {
  const path = useMemo(() => {
    const { data, size } = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`;
    return { d, size };
  }, [text]);
  return (
    <svg className={className} viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={path.size} height={path.size} className={paper} />
      <path d={path.d} className={ink} />
    </svg>
  );
}
