import Link from 'next/link';
import type { ReactNode } from 'react';
import { Mark } from '../Mark';
import { Menu, Net, type Place } from './Menu';
import s from './header.module.css';

/**
 * The top 8 % of every page: the mark, what the race is doing now, LIVE when it is, and one quiet menu. The network
 * rides beside the mark only on the pages that live on it, where every number is read from it; when the site has a
 * sibling on the other network, it is the switch between the two.
 */
export function Header({
  center,
  live = false,
  network,
  here,
  overlay = false,
}: {
  center?: ReactNode;
  live?: boolean;
  network?: string | undefined;
  here?: Place;
  /** The page draws its own scene under the header: the header floats over it instead of taking its own row. */
  overlay?: boolean;
}) {
  return (
    <header className={s.head} data-overlay={overlay ? '' : undefined} data-center={center ? '' : undefined}>
      <Link href="/" className={s.logo} aria-label="MASK WARS, the race">
        <Mark className={s.mark} />
        <span className={s.word}>Mask Wars</span>
      </Link>
      {network ? <Net network={network} /> : null}
      {center ? <div className={s.center}>{center}</div> : null}
      <div className={s.right}>
        {live ? (
          <span className={s.live} role="status">
            <i aria-hidden />
            Live
          </span>
        ) : null}
        <Menu here={here} network={network} />
      </div>
    </header>
  );
}
