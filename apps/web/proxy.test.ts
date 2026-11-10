import { describe, expect, it } from 'vitest';
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
