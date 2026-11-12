import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import robots from './robots';
import sitemap from './sitemap';

const app = dirname(fileURLToPath(import.meta.url));

describe('what search engines and agents are told', () => {
  it('lists only pages that exist, each once, under the site’s own name', () => {
    const urls = sitemap().map((e) => e.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls[0]).toBe('https://maskwars.xyz');
    for (const url of urls) {
      expect(url.startsWith('https://maskwars.xyz')).toBe(true);
      const path = new URL(url).pathname;
      // A mask's page is one dynamic route.
      const dir = path.startsWith('/mask/') ? join(app, 'mask', '[name]') : join(app, ...path.split('/').filter(Boolean));
      expect(existsSync(join(dir, 'page.tsx')), path).toBe(true);
    }
  });

  it('names the forge, where a person makes a mask of their own, right after the jobs', () => {
    const pages = sitemap();
    const paths = pages.map((e) => new URL(e.url).pathname);
    expect(paths).toHaveLength(15);
    expect(paths.slice(0, 5)).toEqual(['/', '/league', '/jobs', '/forge', '/swap']);
    expect(pages[paths.indexOf('/forge')]).toEqual({ url: 'https://maskwars.xyz/forge', changeFrequency: 'weekly', priority: 0.8 });
  });

  it('lets everything be read and names the sitemap', () => {
    const r = robots();
    expect(r.sitemap).toBe('https://maskwars.xyz/sitemap.xml');
    expect(r.rules).toEqual([{ userAgent: '*', allow: '/', disallow: ['/lab'] }]);
  });
});
