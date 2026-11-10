import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QuoteView } from '@maskwars/pay';

// The routes run against 1Click and NEAR Intents in memory (PAY_FIXTURE=1), set before anything reads it.
process.env.PAY_FIXTURE = '1';
process.env.PAY_FIXTURE_STEP_MS = '50';

const lib = () => import('./pay');
const route = <T>(name: string) => import(`../app/api/pay/${name}/route.ts`) as Promise<T>;
type Post = { POST: (req: Request) => Promise<Response> };
type Get = { GET: (req: Request) => Promise<Response> };

const SITE = 'https://maskwars.xyz';
let ip = 0;
/** A request as the site's own page sends it, from its own address unless `as` names one. */
function page(path: string, o: { body?: unknown; headers?: Record<string, string>; site?: string | null; origin?: string | null; as?: string } = {}): Request {
  const post = o.body !== undefined;
  const headers: Record<string, string> = { 'x-real-ip': o.as ?? `10.0.0.${++ip}` };
  if (o.site !== null) headers['sec-fetch-site'] = o.site ?? 'same-origin';
  if (post && o.origin !== null) headers.origin = o.origin ?? SITE;
  if (post) headers['content-type'] = 'application/json';
  return new Request(`${SITE}/api/pay/${path}`, {
    method: post ? 'POST' : 'GET',
    headers: { ...headers, ...o.headers },
    ...(post ? { body: JSON.stringify(o.body) } : {}),
  });
}

const VAULT = '0x3602b546589a8fcafdce7fad64a46f91db0e4d50';
const OTHER = '0x7edf07ede58238026db3f90fc8032633b69b8de5';
const BASE = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
let usdcSol = '';
let usdcBase = '';

beforeAll(async () => {
  const { catalog } = await lib();
  const c = await catalog();
  usdcSol = c.chains.find((x) => x.id === 'sol')!.coins.find((x) => x.symbol === 'USDC')!.assetId;
  usdcBase = c.chains.find((x) => x.id === 'base')!.coins.find((x) => x.symbol === 'USDC')!.assetId;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('only the site’s own page', () => {
  it('reads with Sec-Fetch-Site: same-origin, and posts with the site’s Origin', async () => {
    const { fromPage } = await lib();
    expect(fromPage(page('vault'))).toBe(true);
    expect(fromPage(page('quote', { body: {} }))).toBe(true);
  });

  it('refuses a script without the browser’s headers, another site, and a post without Origin', async () => {
    const { fromPage } = await lib();
    expect(fromPage(page('vault', { site: null }))).toBe(false);
    expect(fromPage(page('vault', { site: 'cross-site' }))).toBe(false);
    expect(fromPage(page('vault', { site: 'same-site' }))).toBe(false);
    expect(fromPage(page('vault', { headers: { origin: 'https://evil.example' } }))).toBe(false);
    expect(fromPage(page('quote', { body: {}, origin: null }))).toBe(false);
    expect(fromPage(page('quote', { body: {}, site: null }))).toBe(false);
    expect(fromPage(page('quote', { body: {}, origin: 'https://evil.example' }))).toBe(false);
    expect(fromPage(page('quote', { body: {}, origin: 'https://maskwars.xyz.evil.example' }))).toBe(false);
  });

  it('takes a local run’s own origin outside production, and only APP_ORIGIN in production', async () => {
    const { fromPage } = await lib();
    const local = new Request('http://localhost:3211/api/pay/quote', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', origin: 'http://localhost:3211', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(fromPage(local)).toBe(true);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(fromPage(local)).toBe(false);
    expect(fromPage(page('quote', { body: {} }))).toBe(true);
    vi.stubEnv('APP_ORIGIN', 'https://www.maskwars.xyz');
    expect(fromPage(page('quote', { body: {} }))).toBe(false);
  });

  it('is what every /api/pay route checks first', async () => {
    const posts: [string, unknown][] = [
      ['quote', { kind: 'in', account: VAULT, from: 'x', usd: 10, dry: true }],
      ['intent', { depositAddress: 'ab', signer: VAULT, standard: 'webauthn' }],
      ['submit', { signed: {} }],
      ['passkey', { id: 'x', key: 'y' }],
    ];
    for (const [name, b] of posts) {
      const { POST } = await route<Post>(name);
      expect([name, (await POST(page(name, { body: b, origin: null }))).status]).toEqual([name, 403]);
      expect([name, (await POST(page(name, { body: b, origin: 'https://evil.example' }))).status]).toEqual([name, 403]);
    }
    for (const path of ['catalog', `vault?account=${VAULT}`, `status?address=${'a'.repeat(64)}`, `key?account=maskfan.near&key=x`, 'passkey?id=x']) {
      const { GET } = await route<Get>(path.split('?')[0]!);
      expect([path, (await GET(page(path, { site: null }))).status]).toEqual([path, 403]);
      expect([path, (await GET(page(path, { site: 'cross-site' }))).status]).toEqual([path, 403]);
    }
    const { GET } = await route<Get>('catalog');
    expect((await GET(page('catalog'))).status).toBe(200);
  });
});

describe('quotes', () => {
  const quote = async (b: Record<string, unknown>, as?: string) => {
    const { POST } = await route<Post>('quote');
    const res = await POST(page('quote', { body: b, ...(as ? { as } : {}) }));
    return { status: res.status, json: (await res.json()) as { quote: QuoteView; error?: string } };
  };

  it('hands the page 1Click’s terms to read back: receiver, coins, refunds, the promised minimum', async () => {
    // The vault, funded in the in-memory NEAR Intents: 3 NEAR.
    const fake = await (globalThis as unknown as { __maskwarsFakePay: Promise<{ ledger: Map<string, Map<string, bigint>> }> }).__maskwarsFakePay;
    fake.ledger.set(VAULT, new Map([['nep141:wrap.near', 3n * 10n ** 24n]]));
    const out = await quote({ kind: 'out', account: VAULT, from: 'nep141:wrap.near', to: usdcBase, recipient: ` ${BASE} `, units: '1000000000000000000000000', dry: false });
    expect(out.status).toBe(200);
    expect(out.json.quote).toMatchObject({
      dry: false,
      originAsset: 'nep141:wrap.near',
      destinationAsset: usdcBase,
      recipient: BASE,
      recipientType: 'DESTINATION_CHAIN',
      refundTo: VAULT,
      refundType: 'INTENTS',
      amountIn: '1000000000000000000000000',
    });
    expect(Date.parse(out.json.quote.deadline) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const top = await quote({ kind: 'in', account: VAULT, from: usdcSol, usd: 25, dry: false });
    expect(top.status).toBe(200);
    expect(top.json.quote).toMatchObject({
      dry: false,
      originAsset: usdcSol,
      destinationAsset: 'nep141:wrap.near',
      recipient: VAULT,
      recipientType: 'INTENTS',
      refundTo: VAULT,
      refundType: 'INTENTS',
      amountIn: '25000000',
    });
    expect(BigInt(top.json.quote.minAmountOut)).toBeGreaterThan(0n);
    expect(top.json.quote.depositAddress).toBeTruthy();
  });

  it('shares a preview of the same coins and amount for 10 s, naming no one', async () => {
    const { oneClick } = await lib();
    const spy = vi.spyOn(oneClick, 'quote');
    const a = await quote({ kind: 'in', account: VAULT, from: usdcSol, usd: 37, dry: true });
    const b = await quote({ kind: 'in', account: OTHER, from: usdcSol, usd: 37, dry: true });
    expect(a.status).toBe(200);
    expect(b.json.quote).toEqual(a.json.quote);
    expect(a.json.quote).toMatchObject({ dry: true, recipient: null, refundTo: null, depositAddress: null });
    expect(spy).toHaveBeenCalledTimes(1);
    await quote({ kind: 'in', account: VAULT, from: usdcSol, usd: 38, dry: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('takes a top-up of at most PAY_USD_MAX dollars, the season’s limit, and the coin list says it', async () => {
    const { PAY_USD_MAX } = await lib();
    expect(PAY_USD_MAX).toBe(100);
    expect((await quote({ kind: 'in', account: VAULT, from: usdcSol, usd: 100, dry: true })).status).toBe(200);
    const over = await quote({ kind: 'in', account: VAULT, from: usdcSol, usd: 100.01, dry: true });
    expect([over.status, over.json.error]).toEqual([400, 'bad']);
    const { GET } = await route<{ GET: (req: Request) => Promise<Response> }>('catalog');
    expect(await (await GET(page('catalog'))).json()).toMatchObject({ maxUsd: 100 });
  });

  it('keeps answering a busy shared address from the shared previews', async () => {
    const as = '203.0.113.7';
    let busy = 0;
    // Fifty different amounts within one top-up's limit (PAY_USD_MAX), none priced by an earlier test.
    for (let k = 0; k < 50; k++) if ((await quote({ kind: 'in', account: VAULT, from: usdcSol, usd: 50.25 + k, dry: true }, as)).status === 429) busy += 1;
    // Past 40 new prices a minute one address waits…
    expect(busy).toBe(10);
    // …yet the prices already out there still reach everyone behind it.
    for (let i = 0; i < 20; i++) expect((await quote({ kind: 'in', account: OTHER, from: usdcSol, usd: 51.25, dry: true }, as)).status).toBe(200);
  });
});

describe('the preview cache', () => {
  it('forgets a price after 10 seconds', async () => {
    const { keepPreview, preview, PREVIEW_MS } = await lib();
    const v = { amountOut: '1' } as QuoteView;
    keepPreview('k', v, 1_000);
    expect(preview('k', 1_000 + PREVIEW_MS - 1)).toBe(v);
    expect(preview('k', 1_000 + PREVIEW_MS)).toBeNull();
  });
});
