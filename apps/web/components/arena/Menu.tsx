'use client';

import { NETWORK_IDS } from '@maskwars/network';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { acrossUrl, forgeStated, type MenuItem, menuOf, type Place, SITE } from '@/lib/site';
import { Mark } from '../Mark';
import s from './header.module.css';

export type { Place };

const RACE: MenuItem = { place: 'race', href: '/', label: 'The race', away: null };

// One question per page load: is the mask factory open on chain? Asked after the page is up, never in its way.
let forgeAsked: Promise<boolean> | null = null;

function useForgeOpen(ask: boolean): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!ask) return;
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
  }, [ask]);
  return open;
}

/** The two networks in the order the switch shows them: the one with real NEAR first. */
const NETWORKS_SHOWN = [...NETWORK_IDS].reverse();

/**
 * The network every number on the page is read from. With the other site named it is the switch between the two:
 * this site's network stands lit, the other one is a link to the same page there.
 */
export function Net({ network, sheet = false }: { network: string; sheet?: boolean }) {
  const across = acrossUrl(usePathname());
  if (!across) {
    return sheet ? null : (
      <span className={s.net} title={`NEAR ${network}`}>
        {network}
      </span>
    );
  }
  return (
    <nav className={s.nets} aria-label="Network" data-sheet={sheet ? '' : undefined}>
      {NETWORKS_SHOWN.map((id) =>
        id === SITE.network ? (
          <span key={id} className={s.netCell} aria-current="true" title={`This site reads NEAR ${id}`}>
            {id}
          </span>
        ) : (
          <a key={id} className={s.netCell} href={across} title={`Open the ${id} site`}>
            {id}
          </a>
        ),
      )}
    </nav>
  );
}

/**
 * One item of the menu. A part that is on chain only on the other network is a plain link to the same page of the
 * other site, marked with that network before the click.
 */
function Item({
  item,
  className,
  current,
  first = false,
  style,
  onClick,
}: {
  item: MenuItem;
  className: string | undefined;
  current: boolean;
  /** The first item of the open menu: it takes the focus. */
  first?: boolean;
  style?: CSSProperties;
  onClick?: () => void;
}) {
  const shared = {
    className,
    'data-place': item.place,
    'data-first': first ? '' : undefined,
    'aria-current': current ? ('page' as const) : undefined,
    ...(style ? { style } : {}),
    ...(onClick ? { onClick } : {}),
  };
  if (item.away) {
    return (
      <a href={item.href} title={`Opens on the ${item.away} site`} {...shared}>
        {item.label}
        <span className={s.tag}>{item.away}</span>
      </a>
    );
  }
  return (
    <Link href={item.href} {...shared}>
      {item.label}
    </Link>
  );
}

/**
 * The quiet menu: the same items in the same order on both sites. On a wide screen its links sit in the header; on a
 * narrow one, or beside the race clock, one button opens them over the page. A site on its own shows Forge only while
 * its factory is open on chain; two sites that know each other show it always: where the forge is, or on this site's
 * own page, which says itself when its factory is not open yet.
 */
export function Menu({ here, network }: { here?: Place | undefined; network?: string | undefined }) {
  const forge = useForgeOpen(!forgeStated());
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const links = menuOf(forge);

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
      {/* How many items are marked with the other network: each is wider by its name, and the header makes room. */}
      <nav className={s.links} aria-label="Site" data-away={links.filter((l) => l.away).length || undefined}>
        {links.map((l) => (
          <Item key={l.place} item={l} className={s.link} current={here === l.place} />
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
                {/* Beside the mark, as in the header: on a phone this is where the two networks switch. */}
                {network ? <Net network={network} sheet /> : null}
                <button type="button" className={s.toggle} data-shut aria-label="Close menu" onClick={close}>
                  <CloseIcon />
                </button>
              </div>
              <nav className={s.sheetLinks} aria-label="Site">
                {[RACE, ...links].map((l, i) => (
                  <Item
                    key={l.place}
                    item={l}
                    className={s.sheetLink}
                    first={i === 0}
                    current={here === l.place}
                    style={{ animationDelay: `${40 + i * 40}ms` }}
                    onClick={() => setOpen(false)}
                  />
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
