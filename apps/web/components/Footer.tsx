'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { CODE_URL, type FootLink, footerOf, footerOn, forgeStated, jobsStated, SITE } from '@/lib/site';
import { useForgeOpen, useJobsOpen } from './arena/Menu';
import { Mark } from './Mark';
import s from './footer.module.css';

/**
 * The foot of every page: the mark, every page a visitor can open in three short groups, the code, and the network
 * the site reads. It stands after the page, so a page that fills exactly one screen keeps that screen whole and the
 * footer is one scroll below it; a long page ends with it. The hire checkout's frame and window and the lab have none.
 */
export function Footer() {
  const path = usePathname();
  return footerOn(path) ? <Foot path={path} /> : null;
}

function Foot({ path }: { path: string }) {
  // The menu's own two questions to the chain, asked once per page load for both: Forge and Jobs stand here exactly
  // while the menu shows them.
  const forge = useForgeOpen(!forgeStated());
  const jobs = useJobsOpen(!jobsStated());
  const groups = footerOf(forge, SITE, jobs);
  const id = useId();
  return (
    <footer className={s.foot}>
      <div className={s.in}>
        <div className={s.brand}>
          <Link href="/" className={s.logo} aria-label="MASK WARS, the race">
            <Mark className={s.mark} />
            <span className={s.word}>Mask Wars</span>
          </Link>
          <p className={s.line}>Private minds. Public war.</p>
        </div>
        <nav className={s.groups} aria-label="All pages">
          {groups.map((g, i) => (
            <div key={g.title} className={s.group}>
              <p className={s.title} id={`${id}-${i}`}>
                {g.title}
              </p>
              <ul className={s.list} aria-labelledby={`${id}-${i}`}>
                {g.links.map((l) => (
                  <li key={l.path}>
                    <Item link={l} current={path === l.path} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className={s.group}>
            <p className={s.title} id={`${id}-code`}>
              Code
            </p>
            <ul className={s.list} aria-labelledby={`${id}-code`}>
              <li>
                <a href={CODE_URL} className={s.link} target="_blank" rel="noopener noreferrer">
                  GitHub
                  <Out />
                </a>
              </li>
            </ul>
          </div>
        </nav>
        <p className={s.base}>
          <span>Built on NEAR</span>
          <span className={s.net} title={`This site reads NEAR ${SITE.network}`}>
            {SITE.network}
          </span>
        </p>
      </div>
    </footer>
  );
}

/** One link. A part that is on chain only on the other network leads to the other site, marked before the click. */
function Item({ link, current }: { link: FootLink; current: boolean }) {
  if (link.away) {
    return (
      <a href={link.href} className={s.link} title={`Opens on the ${link.away} site`}>
        {link.label}
        <span className={s.tag}>{link.away}</span>
      </a>
    );
  }
  return (
    <Link href={link.href} className={s.link} aria-current={current ? 'page' : undefined}>
      {link.label}
    </Link>
  );
}

/** Leaves the site. */
function Out() {
  return (
    <svg className={s.out} viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" aria-hidden focusable="false">
      <path d="M3 9l6-6M4 3h5v5" />
    </svg>
  );
}
