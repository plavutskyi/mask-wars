import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { hireAncestors, hirePolicy, notFramed, proxy, walletPolicy } from './proxy';

describe('the vault page’s policy', () => {
  it('lets no site frame it and runs only scripts carrying this response’s nonce', () => {
    const p = walletPolicy('abc123', false);
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).toContain("script-src 'nonce-abc123' 'strict-dynamic'");
    expect(p).toContain("object-src 'none'");
    expect(p).toContain("base-uri 'none'");
    expect(p).not.toContain("'unsafe-eval'");
  });

  it('allows eval only in development, where React needs it for its error overlay', () => {
    expect(walletPolicy('n', true)).toContain("'unsafe-eval'");
  });
});

describe('the hire checkout’s policy', () => {
  it('lets any https page and a developer’s own machine frame it, and nothing else', () => {
    const p = hirePolicy('n0nce', false, hireAncestors(undefined));
    expect(p).toContain("frame-ancestors 'self' https: http://localhost:* http://127.0.0.1:*");
    // No bare `*`: a page on plain http elsewhere, or a data: URL, may not frame it.
    expect(p).not.toMatch(/frame-ancestors[^;]*\s\*(\s|;|$)/);
  });

  it('talks only to its own server, loads nothing from elsewhere, frames nothing', () => {
    const p = hirePolicy('n0nce', false, "'self'");
    expect(p).toContain("default-src 'self'");
    expect(p).toContain("connect-src 'self'");
    expect(p).toContain("frame-src 'none'");
    expect(p).toContain("script-src 'nonce-n0nce' 'strict-dynamic'");
    expect(p).toContain("object-src 'none'");
    expect(p).toContain("base-uri 'none'");
    expect(p).not.toContain("'unsafe-eval'");
    expect(hirePolicy('n', true, "'self'")).toContain("'unsafe-eval'");
  });

  it('narrows to HIRE_FRAME_ANCESTORS, keeping only plain sources', () => {
    expect(hireAncestors("'self' https://app.example https://*.near.page")).toBe("'self' https://app.example https://*.near.page");
    expect(hireAncestors('https://app.example; script-src *')).toBe("'self' https: http://localhost:* http://127.0.0.1:*");
    expect(hireAncestors('https://ok.example javascript:alert(1)')).toBe('https://ok.example');
  });
});

describe('the checkout is a frame or nothing', () => {
  const at = (path: string, dest: string | null) => new NextRequest(`https://maskwars.xyz${path}`, { headers: dest ? { 'sec-fetch-dest': dest } : {} });

  // The finding: /hire/embed?team=attacker.near opened as a page of its own, a maskwars.xyz page asking for money.
  it('sends a browser that is not loading a frame to /hire, job and vault left behind', () => {
    for (const dest of ['document', 'empty', 'script']) {
      const res = proxy(at('/hire/embed?job=Pay+me&team=attacker.near&usd=500', dest));
      expect([dest, res.status, res.headers.get('location')]).toEqual([dest, 307, 'https://maskwars.xyz/hire']);
    }
    expect(notFramed(at('/hire/embed', 'iframe'))).toBe(false);
    const framed = proxy(at('/hire/embed?job=x', 'iframe'));
    expect(framed.status).toBe(200);
    expect(framed.headers.get('content-security-policy')).toContain('frame-ancestors');
  });

  it('holds the vault window like the vault page: no one may frame it', () => {
    const res = proxy(at('/hire/prove', 'document'));
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

// One product on two sites: a page of a part that is on chain only on the other network is answered by the other site.
// What is on chain where changes with one word in packages/network; these tests name no part that it would move.
describe('a page whose part lives on the other network', () => {
  const PAGES = ['/forge', '/forge?copy=kira', '/jobs', '/jobs?page=2', '/jobs/job-0001'];
  const at = (path: string) => new NextRequest(`https://this.example${path}`, { headers: { 'sec-fetch-dest': 'document' } });
  /** The proxy of a site built for `network`, with the other site at `sibling`, and that site's own rule. */
  const site = async (network: string, sibling: string | undefined) => {
    vi.resetModules();
    vi.stubEnv('MASKWARS_NETWORK', network);
    vi.stubEnv('MASKWARS_SIBLING_URL', sibling ?? '');
    const m = await import('./proxy');
    const rule = await import('@/lib/site');
    return { open: (path: string) => m.proxy(at(path)), rule };
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@/lib/site');
    vi.resetModules();
  });

  it('is sent to the address the site’s rule gives, and not for good', async () => {
    // The rule itself, injected: the jobs board and every job live on the other site, the forge here.
    vi.resetModules();
    vi.doMock('@/lib/site', async (original) => ({
      ...(await original<typeof import('@/lib/site')>()),
      elsewhere: (pathname: string, search = '') => (pathname === '/jobs' || pathname.startsWith('/jobs/') ? `https://other.example${pathname}${search}` : null),
    }));
    const { proxy } = await import('./proxy');
    for (const [path, to] of [
      ['/jobs', 'https://other.example/jobs'],
      ['/jobs?page=2', 'https://other.example/jobs?page=2'],
      ['/jobs/break-safe-0004', 'https://other.example/jobs/break-safe-0004'],
    ] as const) {
      const res = proxy(at(path));
      expect([path, res.status, res.headers.get('location')]).toEqual([path, 307, to]);
    }
    // A part that is not sent anywhere is answered here, with no policy of the vault's on it.
    const here = proxy(at('/forge?copy=kira'));
    expect([here.status, here.headers.get('location'), here.headers.get('content-security-policy'), here.headers.get('x-frame-options')]).toEqual([200, null, null, null]);
  });

  it('on each of the two sites, every page of a part goes exactly where that site’s rule says', async () => {
    for (const [network, sibling] of [
      ['mainnet', 'https://testnet.maskwars.xyz'],
      ['testnet', 'https://maskwars.xyz'],
    ] as const) {
      const { open, rule } = await site(network, sibling);
      for (const page of PAGES) {
        const [pathname, query] = page.split('?');
        const to = rule.elsewhere(pathname!, query ? `?${query}` : '');
        const res = open(page);
        expect([network, page, res.status, res.headers.get('location'), res.headers.get('content-security-policy')]).toEqual([network, page, to ? 307 : 200, to, null]);
        if (to) expect(to.startsWith(sibling), page).toBe(true);
      }
    }
  });

  it('a page one site sends away, the other answers: nobody is sent back and forth', async () => {
    const main = await site('mainnet', 'https://testnet.maskwars.xyz');
    const sentFromMain = PAGES.filter((p) => main.open(p).status === 307);
    const test = await site('testnet', 'https://maskwars.xyz');
    const sentFromTest = PAGES.filter((p) => test.open(p).status === 307);
    for (const page of sentFromMain) expect(sentFromTest, page).not.toContain(page);
  });

  it('a site with no sibling answers every page itself, as before', async () => {
    for (const network of ['mainnet', 'testnet']) {
      const { open } = await site(network, undefined);
      for (const page of PAGES) expect([network, page, open(page).status, open(page).headers.get('location')]).toEqual([network, page, 200, null]);
    }
  });

  it('the vault, the checkout, Get NEAR and Swap keep their policies on both sites', async () => {
    for (const [network, sibling] of [
      ['mainnet', 'https://testnet.maskwars.xyz'],
      ['testnet', 'https://maskwars.xyz'],
    ] as const) {
      const { open } = await site(network, sibling);
      const wallet = open('/wallet');
      expect(wallet.status).toBe(200);
      expect(wallet.headers.get('x-frame-options')).toBe('DENY');
      expect(wallet.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(open('/hire/prove').headers.get('referrer-policy')).toBe('no-referrer');
      // Get NEAR hands out deposit addresses and asks wallets to sign: framed by nobody, scripts only by nonce.
      const near = open('/near');
      expect(near.status).toBe(200);
      expect(near.headers.get('x-frame-options')).toBe('DENY');
      expect(near.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(near.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
      // Swap too: any coin into any coin, the same deposit addresses and wallet signatures.
      const swap = open('/swap');
      expect(swap.status).toBe(200);
      expect(swap.headers.get('x-frame-options')).toBe('DENY');
      expect(swap.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(swap.headers.get('content-security-policy')).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
    }
  });
});
