// The row that offers MASK CHECK for hire: the price the marketplace quotes, and the agent's page there for people.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarketRow } from './MarketRow';

const PAGE = 'https://market.near.ai/a/maskwars';
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

describe('MarketRow', () => {
  it('says what a call costs and links people to the agent’s page on the marketplace', () => {
    const html = renderToStaticMarkup(<MarketRow listing={{ page: PAGE, price: '0.10' }} />);
    expect(text(html)).toBe('MASK CHECK0.10 USDC per call. Hire it on Agent Market');
    expect(html).toContain(`href="${PAGE}"`);
    // The agent's own host answers machines: a person is never sent there.
    expect(html).not.toContain('maskwars.market.near.ai');
  });

  it('leaves the price out when the marketplace states none', () => {
    const html = renderToStaticMarkup(<MarketRow listing={{ page: PAGE, price: null }} />);
    expect(text(html)).toBe('MASK CHECKUSDC per call. Hire it on Agent Market');
    expect(html).toContain(`href="${PAGE}"`);
  });
});
