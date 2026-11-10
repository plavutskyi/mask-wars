'use client';

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import s from './info.module.css';

export interface InfoRow {
  label: string;
  value: string;
  href?: string | undefined;
}

/** The quiet «i»: everything technical about a number, one tap away. */
export function Info({
  rows,
  label = 'Details',
  align = 'center',
  side = 'bottom',
  children,
}: {
  rows: InfoRow[];
  label?: string;
  align?: 'start' | 'center' | 'end';
  /** Where the sheet opens on a wide screen; on a phone it always rises from the bottom. */
  side?: 'top' | 'bottom';
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // On a phone the sheet goes to the body: inside a moving or contained parent (the 3D arena) `fixed` is not the screen.
  const [sheet, setSheet] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const q = window.matchMedia('(max-width: 760px)');
    const on = () => setSheet(q.matches);
    on();
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || panel.current?.contains(t)) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const details = (
    <>
      <span className={s.scrim} aria-hidden onClick={() => setOpen(false)} />
      <span ref={panel} className={s.panel} id={id} role="dialog" aria-label={label}>
        {rows.map((r, i) => (
          <span key={`${r.label}-${i}`} className={s.row}>
            <span className={s.k}>{r.label}</span>
            {r.href ? (
              <a className={s.v} href={r.href} target="_blank" rel="noreferrer">
                {r.value}
              </a>
            ) : (
              <span className={s.v}>{r.value}</span>
            )}
          </span>
        ))}
        {children}
      </span>
    </>
  );

  return (
    <span className={s.box} ref={box} data-align={align} data-side={side}>
      <button type="button" className={s.i} aria-expanded={open} aria-controls={id} aria-label={label} onClick={() => setOpen((v) => !v)}>
        i
      </button>
      {open ? (sheet ? createPortal(details, document.body) : details) : null}
    </span>
  );
}
