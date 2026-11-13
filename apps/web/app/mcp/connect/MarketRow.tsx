import type { MarketListing } from '@/lib/market';
import s from './connect.module.css';

/**
 * MASK CHECK for hire on Agent Market: what a call costs, as the marketplace quotes it, and the agent's page there,
 * where a person hires it. Agents call the agent's own host; a person is never sent to it.
 */
export function MarketRow({ listing }: { listing: Pick<MarketListing, 'page' | 'price'> }) {
  return (
    <li className={s.tool}>
      <span className={s.name}>MASK CHECK</span>
      <span className={s.what}>
        {listing.price ? `${listing.price} USDC per call.` : 'USDC per call.'}{' '}
        <a href={listing.page} target="_blank" rel="noopener" className={s.try}>
          Hire it on Agent Market
        </a>
      </span>
    </li>
  );
}
