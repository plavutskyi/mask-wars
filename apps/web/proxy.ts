import { type NextRequest, NextResponse } from 'next/server';

// The vault page holds a person's money: no other site may frame it, and only scripts this page itself loads may run on
// it. A fresh nonce per request goes to Next.js (it stamps its own scripts with it, from the request's CSP header) and
// to NEAR Connect, whose sandboxed wallet frames inherit this policy. Only scripts are held this tightly: wallets talk
// to their own servers, images and styles from anywhere, and that stays open so every wallet in NEAR Connect works.

export function walletPolicy(nonce: string, dev: boolean): string {
  return [
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ''} https: 'unsafe-inline'`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Who may frame the hire checkout: any page served over https (any NEAR app), this site, and a developer's own machine.
 * `HIRE_FRAME_ANCESTORS` narrows it to a list of sources, space-separated; anything in it that is not a plain source is
 * dropped, so the header cannot be bent by the variable.
 */
export function hireAncestors(env: string | undefined): string {
  const fixed = (env ?? '')
    .split(/\s+/)
    .filter((s) => /^('self'|'none'|https:|https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+|:\*)?)$/.test(s));
  return fixed.length ? fixed.join(' ') : "'self' https: http://localhost:* http://127.0.0.1:*";
}

/**
 * The hire checkout runs inside other sites' pages, so it is the one page here that may be framed; in exchange it may
 * do almost nothing else. Its scripts carry this response's nonce; it talks only to this site's own API (the 1Click key
 * stays on the server); it loads nothing from anywhere else and frames nothing itself.
 */
export function hirePolicy(nonce: string, dev: boolean, ancestors: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''} https: 'unsafe-inline'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}

/**
 * The checkout is a frame or nothing. Opened as a page of its own, a link to it would look like maskwars.xyz asking for
 * money with whatever job and vault the link names; so a browser that says it is not loading a frame
 * (`Sec-Fetch-Dest`) is sent to /hire instead, and the page itself draws nothing until it sees it is framed.
 */
export function notFramed(request: Pick<NextRequest, 'headers'>): boolean {
  const dest = request.headers.get('sec-fetch-dest');
  return dest !== null && dest !== 'iframe';
}

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const hire = path.startsWith('/hire/embed');
  if (hire && notFramed(request)) return NextResponse.redirect(new URL('/hire', request.url), 307);
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  const dev = process.env.NODE_ENV === 'development';
  // /hire/prove is the window where a payer proves the vault is theirs: a page of its own, held like /wallet.
  const policy = hire ? hirePolicy(nonce, dev, hireAncestors(process.env.HIRE_FRAME_ANCESTORS)) : walletPolicy(nonce, dev);
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);
  headers.set('x-nonce', nonce);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', policy);
  if (hire) {
    // Framed by strangers: links out (an explorer) carry no address of the checkout and its job, while its own calls
    // keep their Origin (a stricter policy would send `Origin: null` and /api would refuse them). Out of search too.
    res.headers.set('referrer-policy', 'same-origin');
    res.headers.set('x-robots-tag', 'noindex');
  } else {
    res.headers.set('x-frame-options', 'DENY');
    if (path.startsWith('/hire/prove')) {
      res.headers.set('referrer-policy', 'no-referrer');
      res.headers.set('x-robots-tag', 'noindex');
    }
  }
  return res;
}

// Literal, as Next.js reads it without running the file.
export const config = {
  matcher: [
    {
      source: '/wallet/:path*',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
    {
      source: '/hire/prove',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
    {
      source: '/hire/embed',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
