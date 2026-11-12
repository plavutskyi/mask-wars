import Link from 'next/link';
import s from './near.module.css';

/**
 * Get NEAR and Swap are one place on the site: Get NEAR is a swap whose coin out is native NEAR. Two tabs above the
 * title move between them; the menu keeps its one item.
 */
export function Tabs({ here }: { here: 'near' | 'swap' }) {
  return (
    <nav className={s.tabs} aria-label="Get NEAR or swap">
      <Link href="/near" className={s.tab} aria-current={here === 'near' ? 'page' : undefined}>
        Get NEAR
      </Link>
      <Link href="/swap" className={s.tab} aria-current={here === 'swap' ? 'page' : undefined}>
        Swap
      </Link>
    </nav>
  );
}
