'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { encode } from 'uqr';
import type { CatalogState } from './api';
import s from './wallet.module.css';

/** The band's first line: what this step is, its details behind «i», a way back, and where in the flow it is. */
export function Top(p: {
  id: string;
  label: string;
  details?: string | null;
  info: boolean;
  onInfo: () => void;
  back?: (() => void) | null;
  backLabel?: string;
  count?: [number, number] | null;
  extra?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className={s.top}>
      <span className={`${s.word} ${s.label}`} id={`${p.id}-label`}>
        {p.label}
      </span>
      {p.details ? (
        <button type="button" className={s.info} aria-expanded={p.info} aria-controls={`${p.id}-details`} aria-label="Details" onClick={p.onInfo}>
          i
        </button>
      ) : null}
      {p.extra}
      <span className={s.grow} />
      {p.right}
      {p.back ? (
        <button type="button" className={s.back} onClick={p.back}>
          {p.backLabel ?? 'Back'}
        </button>
      ) : null}
      {p.count ? (
        <span className={s.count} aria-label={`Step ${p.count[0]} of ${p.count[1]}`}>
          {p.count[0]}/{p.count[1]}
        </span>
      ) : null}
    </div>
  );
}

/** The line under the row: the details when «i» is open, otherwise one short sentence, red when something is wrong. */
export function Note(p: { id: string; info: boolean; details?: string | null; bad?: boolean; children: ReactNode }) {
  if (p.info && p.details) {
    return (
      <p className={s.details} id={`${p.id}-details`}>
        {p.details}
      </p>
    );
  }
  return (
    <p className={s.note} data-bad={p.bad ? '' : undefined} role={p.bad ? 'alert' : 'status'} aria-live="polite">
      {p.children}
    </p>
  );
}

/** A money screen without its coins: loading, or a plain line and a retry when the list did not come. */
export function NoCoins(p: { id: string; label: string; coins: CatalogState; empty: string; onClose: () => void }) {
  const down = p.coins.down;
  return (
    <div className={s.form}>
      <Top id={p.id} label={p.label} info={false} onInfo={() => {}} back={p.onClose} />
      {down ? (
        <div className={s.row}>
          <button type="button" className={s.btn} onClick={p.coins.retry}>
            <span className={s.word}>Try again</span>
          </button>
        </div>
      ) : null}
      <Note id={p.id} info={false} bad={down}>
        {down ? 'The coins did not load. Your money has not moved.' : p.coins.catalog ? p.empty : 'Loading the coins on offer.'}
      </Note>
    </div>
  );
}

/**
 * Puts focus on the one way on when a screen ends by itself (money landed, a cash-out settled), so a screen reader and
 * the keyboard start there, without the focus ring a click would not have shown.
 */
export const quietFocus = (el: HTMLElement | null) => el?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);

/** A QR code for an address, drawn as one SVG path: ink modules on ice, as scanners expect. */
export function Qr({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const { data, size } = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]![x]) d += `M${x} ${y}h1v1h-1z`;
    return { d, size };
  }, [text]);
  return (
    <svg className={s.qr} viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={path.size} height={path.size} className={s.qrPaper} />
      <path d={path.d} className={s.qrInk} />
    </svg>
  );
}

/** Copies `text`, and says so on the button for a moment. */
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

/** `0x3602…4d50`, `maskfan.near`, `7xKXtg…sgAsU`: an address short enough for one line, its ends intact. */
export function shortAddress(a: string): string {
  if (a.length <= 18) return a;
  return `${a.slice(0, a.startsWith('0x') ? 6 : 6)}…${a.slice(-4)}`;
}

/** 29:41 */
export function mmss(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
