// A page that is not there says so in its title and claims no address: never the home page's.
import { describe, expect, it } from 'vitest';
import { LINE, pageMeta, SITE } from '@/lib/meta';
import { metadata } from './not-found';

/** What the layout gives every page that says nothing of its own: the home page's. */
const home = pageMeta({ title: SITE, description: LINE, path: '/' });

describe('the page that is not there', () => {
  it('has its own title', () => {
    expect(metadata.title).toBe('Not found · MASK WARS');
    expect(metadata.openGraph?.title).toBe('Not found · MASK WARS');
    expect((metadata.twitter as { title?: string } | undefined)?.title).toBe('Not found · MASK WARS');
  });

  it('takes the canonical address off: the layout’s is the home page’s', () => {
    expect(home.alternates?.canonical).toBe('/');
    expect(metadata.alternates).toEqual({ canonical: null });
    expect((metadata.openGraph as { url?: unknown } | undefined)?.url).toBeUndefined();
  });
});
