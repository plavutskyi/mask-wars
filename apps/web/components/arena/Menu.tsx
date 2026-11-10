'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mark } from '../Mark';
import s from './header.module.css';

export type Place = 'race' | 'league' | 'jobs' | 'forge' | 'agents' | 'vault' | 'break';

interface Item {
  place: Place;
  href: string;
  label: string;
}

const RACE: Item = { place: 'race', href: '/', label: 'The race' };
const FORGE: Item = { place: 'forge', href: '/forge', label: 'Forge' };
const ITEMS: readonly Item[] = [
  { place: 'league', href: '/league', label: 'League' },
  { place: 'jobs', href: '/jobs', label: 'Jobs' },
  { place: 'agents', href: '/mcp/connect', label: 'Agents' },
  { place: 'vault', href: '/wallet', label: 'Vault' },
];

// One question per page load: is the mask factory open on chain? Asked after the page is up, never in its way.
let forgeAsked: Promise<boolean> | null = null;

function useForgeOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    forgeAsked ??= fetch('/api/forge')
      .then((r) => (r.ok ? (r.json() as Promise<{ open?: unknown }>) : { open: false }))
      .then((j) => j.open === true)
      .catch(() => false);
    void forgeAsked.then((v) => {
      if (alive) setOpen(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return open;
}

/**
 * The quiet menu. On a wide screen its links sit in the header; on a narrow one, or beside the race clock, one button
 * opens them over the page. Forge is there only while the factory is open on chain.
 */
export function Menu({ here }: { here?: Place | undefined }) {
  const forge = useForgeOpen();
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const links = forge ? [FORGE, ...ITEMS] : ITEMS;

  // A new page closes the menu.
  const [seen, setSeen] = useState(path);
  if (seen !== path) {
    setSeen(path);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    sheet.current?.querySelector<HTMLElement>('[data-first]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
        return;
      }
      if (e.key !== 'Tab' || !sheet.current) return;
      // Focus stays inside the open menu.
      const all = [...sheet.current.querySelectorAll<HTMLElement>('a, button')];
      const first = all[0];
      const last = all.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      root.style.overflow = before;
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <>
      <nav className={s.links} aria-label="Site">
        {links.map((l) => (
          <Link key={l.place} href={l.href} className={s.link} data-place={l.place} aria-current={here === l.place ? 'page' : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      <button ref={button} type="button" className={s.toggle} aria-expanded={open} aria-controls={id} aria-label="Menu" onClick={() => setOpen(true)}>
        <MenuIcon />
      </button>
      {open
        ? createPortal(
            <div ref={sheet} className={s.sheet} id={id} role="dialog" aria-modal="true" aria-label="Menu">
              <div className={s.sheetHead}>
                <Link href="/" className={s.logo} aria-label="MASK WARS, the race" onClick={() => setOpen(false)}>
                  <Mark className={s.mark} />
                </Link>
                <button type="button" className={s.toggle} data-shut aria-label="Close menu" onClick={close}>
                  <CloseIcon />
                </button>
              </div>
              <nav className={s.sheetLinks} aria-label="Site">
                {[RACE, ...links].map((l, i) => (
                  <Link
                    key={l.place}
                    href={l.href}
                    className={s.sheetLink}
                    data-place={l.place}
                    data-first={i === 0 ? '' : undefined}
                    aria-current={here === l.place ? 'page' : undefined}
                    style={{ animationDelay: `${40 + i * 40}ms` }}
                    onClick={() => setOpen(false)}
                  >
                    {l.label}
                  </Link>
                ))}
              </nav>
              <Link href="/break" className={s.sheetQuiet} aria-current={here === 'break' ? 'page' : undefined} onClick={() => setOpen(false)}>
                Break my contract
              </Link>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden>
      <path d="M4 8.5h16M4 15.5h16" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
