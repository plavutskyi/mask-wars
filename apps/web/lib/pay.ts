import { catalogOf, Ledger, MAINNET_RPCS, OneClick, OneClickError, tooSmall, type Catalog, type QuoteView } from '@maskwars/pay';
import type { FakePay } from '@maskwars/pay/fake';
import { NETWORKS } from '@maskwars/network';
import { callerOf, createLimiter, type Limiter } from './limit';

// Money for a person: the server side of /wallet. 1Click's partner key and the switch that opens real deposits live
// only here. With PAY_FIXTURE=1 (local runs and screenshots, never production) 1Click and NEAR Intents are simulated in
// memory from recorded answers, so the whole round trip can be walked without money.

const fixtureMode = process.env.PAY_FIXTURE === '1' && process.env.VERCEL_ENV !== 'production';

/** Real deposit addresses and cash-outs: on with PAY_LIVE=1, the owner's switch for season 0 on mainnet. */
export const live = fixtureMode || process.env.PAY_LIVE === '1';

/**
 * The most one top-up may bring, in dollars: limits.pay_usd_max of packages/network/mainnet.json (the vault is always on
 * mainnet). Small while season 0 is new; a cash-out of the person's own money has no such limit.
 */
export const PAY_USD_MAX = NETWORKS.mainnet.limits.pay_usd_max ?? 9_999;

const globals = globalThis as unknown as { __maskwarsFakePay?: Promise<FakePay> };
function fake(): Promise<FakePay> {
  globals.__maskwarsFakePay ??= Promise.all([import('@maskwars/pay/fake'), import('@maskwars/pay/fixtures/oneclick.json')]).then(([m, f]) =>
    m.fakePay({ tokens: f.default.tokens, stepMs: Number(process.env.PAY_FIXTURE_STEP_MS) || 4000 }),
  );
  return globals.__maskwarsFakePay;
}
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => (await fake()).fetch(input, init);

export const oneClick = new OneClick({
  token: process.env.ONE_CLICK_API_KEY ?? '',
  ...(fixtureMode ? { fetch: fakeFetch } : {}),
});

const rpcs = process.env.PAY_RPC?.split(',').map((s) => s.trim()).filter(Boolean);
export const ledger = new Ledger({
  rpcs: rpcs?.length ? rpcs : [...MAINNET_RPCS],
  ...(fixtureMode ? { fetch: fakeFetch } : {}),
});

let cached: { at: number; catalog: Catalog } | null = null;

/** The coins on offer with their prices, from 1Click's token list, kept for a minute. */
export async function catalog(): Promise<Catalog> {
  if (cached && Date.now() - cached.at < 60_000) return cached.catalog;
  const c = catalogOf(await oneClick.tokens());
  if (!c) throw new Error('1Click does not list NEAR');
  cached = { at: Date.now(), catalog: c };
  return c;
}

export const NO_STORE = { 'cache-control': 'no-store' };

export function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/** What the page shows for a failure: a short code, never a raw message from upstream. */
export type Problem = 'small' | 'route' | 'closed' | 'busy' | 'bad' | 'signature';

export function problem(code: Problem, status: number): Response {
  return reply({ error: code }, status);
}

/** 1Click's refusal as the page's own code. */
export function upstream(error: unknown): Response {
  if (error instanceof OneClickError) {
    if (error.status === 400 && tooSmall(error.message)) return problem('small', 422);
    if (error.status === 400) return problem('route', 422);
    if (error.status === 404) return problem('bad', 404);
  }
  return problem('busy', 503);
}

const limiters = new Map<string, Limiter>();

/** Per caller and per instance, so one visitor cannot turn these endpoints into a flood on 1Click or the RPC nodes. */
export function limited(req: Request, name: string, perMinute: number): Response | null {
  let l = limiters.get(name);
  if (!l) limiters.set(name, (l = createLimiter({ perWindow: perMinute, windowMs: 60_000 })));
  const wait = l.take(callerOf(req));
  if (wait === null) return null;
  return Response.json({ error: 'busy' }, { status: 429, headers: { ...NO_STORE, 'retry-after': String(wait) } });
}

/**
 * The origins whose page may call /api/pay: the site (`APP_ORIGIN`, maskwars.xyz) and, outside production, the
 * request's own origin, so a local run or a preview works with its own page.
 */
export function origins(req: Request): string[] {
  const app = (process.env.APP_ORIGIN || 'https://maskwars.xyz').replace(/\/+$/, '');
  if (process.env.VERCEL_ENV === 'production') return [app];
  const own = new URL(req.url).origin;
  return own === app ? [app] : [app, own];
}

/**
 * Whether a request comes from this site's own page in a browser: `Sec-Fetch-Site: same-origin` always, and for a POST
 * an `Origin` that is the site's. Requests without these headers (a script, another site's page) are refused, so the
 * partner key behind these routes does not serve anyone else's page. A script can still forge headers: the shared
 * limit for that is the Vercel firewall rule on /api/pay/*.
 */
export function fromPage(req: Request): boolean {
  if (req.headers.get('sec-fetch-site') !== 'same-origin') return false;
  const origin = req.headers.get('origin');
  if (req.method === 'GET' || req.method === 'HEAD') return origin === null || origins(req).includes(origin);
  return origin !== null && origins(req).includes(origin);
}

/** The page-only check and then the per-caller limit, the first thing every /api/pay route does. */
export function guard(req: Request, name: string, perMinute: number): Response | null {
  if (!fromPage(req)) return problem('bad', 403);
  return limited(req, name, perMinute);
}

/** A JSON body, at most `max` bytes. Only after `guard`: it checks the shape, not the sender. */
export async function body(req: Request, max = 8_000): Promise<Record<string, unknown> | null> {
  const type = req.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type.trim())) return null;
  const raw = await req.text();
  if (raw.length > max) return null;
  try {
    const b = JSON.parse(raw);
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** How long a preview price is shared: everyone pricing the same coins and amount gets the same answer for 10 s. */
export const PREVIEW_MS = 10_000;
const previews = new Map<string, { at: number; view: QuoteView }>();

export function preview(key: string, now = Date.now()): QuoteView | null {
  const hit = previews.get(key);
  if (!hit) return null;
  if (now - hit.at < PREVIEW_MS) return hit.view;
  previews.delete(key);
  return null;
}

export function keepPreview(key: string, view: QuoteView, now = Date.now()): void {
  if (previews.size >= 500) {
    for (const [k, v] of previews) if (now - v.at >= PREVIEW_MS) previews.delete(k);
    if (previews.size >= 500) previews.delete(previews.keys().next().value as string);
  }
  previews.set(key, { at: now, view });
}

export const isFixture = fixtureMode;
