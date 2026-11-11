import { describe, expect, it, vi } from 'vitest';
import { createLimiter } from './limit';
import { budgeted, listingReader, marketNeeds, marketSecrets } from './market';

const TOKEN = 'aat_00000000000000000000000000000000';
const SECRET = 'test-webhook-secret-0123456789abcdef';

const agent = (over: Record<string, unknown> = {}) => ({ agent_id: 'a', handle: 'maskwars', name: 'MASK CHECK by MASK WARS', listing_status: 'live', ...over });
const market = (answer: () => { status: number; body: unknown } | Error) => {
  const asked: string[] = [];
  const f = (async (input: string | URL | Request) => {
    asked.push(String(input));
    const a = answer();
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, asked };
};

describe('marketSecrets', () => {
  it('needs the token and the secret, both well formed', () => {
    expect(marketSecrets({})).toBeNull();
    expect(marketNeeds({})).toEqual(['MARKET_API_TOKEN: not set', 'MARKET_WEBHOOK_SECRET: not set']);
    expect(marketNeeds({ MARKET_API_TOKEN: 'Bearer x', MARKET_WEBHOOK_SECRET: 'short' })).toEqual(['MARKET_API_TOKEN: not an aat_ token', 'MARKET_WEBHOOK_SECRET: shorter than 32 characters']);
    expect(marketSecrets({ MARKET_API_TOKEN: TOKEN })).toBeNull();
    expect(marketSecrets({ MARKET_API_TOKEN: ` ${TOKEN}\n`, MARKET_WEBHOOK_SECRET: SECRET })).toEqual({ token: TOKEN, secret: SECRET, origin: 'https://market.near.ai' });
    expect(marketSecrets({ MARKET_API_TOKEN: TOKEN, MARKET_WEBHOOK_SECRET: SECRET, MARKET_ORIGIN: 'https://staging.example/' })?.origin).toBe('https://staging.example');
  });
});

describe('budgeted', () => {
  it('refuses a check over the budget without reading the chain', async () => {
    const check = vi.fn(async () => ({ verdict: 'allow' }) as never);
    const limited = budgeted(check, createLimiter({ perWindow: 2, windowMs: 60_000 }));
    await limited('a.near', 'mainnet');
    await limited('b.near', 'mainnet');
    await expect(limited('c.near', 'mainnet')).rejects.toThrow('too many checks right now');
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('listingReader', () => {
  it('without MARKET_AGENT_HANDLE nothing is listed and nothing is asked', async () => {
    const m = market(() => ({ status: 200, body: agent() }));
    expect(await listingReader({ env: {}, fetch: m.fetch })()).toBeNull();
    expect(await listingReader({ env: { MARKET_AGENT_HANDLE: 'https://evil.example/' }, fetch: m.fetch })()).toBeNull();
    expect(m.asked).toEqual([]);
  });

  it('a live agent under that handle is the listing, with its own page', async () => {
    const m = market(() => ({ status: 200, body: agent() }));
    expect(await listingReader({ env: { MARKET_AGENT_HANDLE: 'maskwars' }, fetch: m.fetch })()).toEqual({ handle: 'maskwars', name: 'MASK CHECK by MASK WARS', url: 'https://maskwars.market.near.ai' });
    expect(m.asked).toEqual(['https://market.near.ai/v1/agents/maskwars']);
  });

  it('no agent, a draft, a paused one, another handle, a failure: not listed', async () => {
    const env = { MARKET_AGENT_HANDLE: 'maskwars' };
    for (const answer of [
      { status: 404, body: { error: 'not_found', message: 'not found' } },
      { status: 200, body: agent({ listing_status: 'draft' }) },
      { status: 200, body: agent({ listing_status: 'paused' }) },
      { status: 200, body: agent({ handle: 'maskwars2' }) },
      { status: 500, body: { error: 'internal' } },
      new TypeError('fetch failed'),
    ]) {
      expect(await listingReader({ env, fetch: market(() => answer).fetch })()).toBeNull();
    }
  });

  it('keeps an answer for five minutes and a failure for half a minute, and asks once for callers that come together', async () => {
    let now = 0;
    let live = true;
    let down = false;
    const m = market(() => (down ? new TypeError('fetch failed') : live ? { status: 200, body: agent() } : { status: 404, body: { error: 'not_found' } }));
    const read = listingReader({ env: { MARKET_AGENT_HANDLE: 'maskwars' }, fetch: m.fetch, now: () => now });
    expect((await Promise.all([read(), read(), read()])).every((l) => l?.handle === 'maskwars')).toBe(true);
    expect(m.asked).toHaveLength(1);

    live = false;
    now = 4 * 60_000;
    expect(await read()).not.toBeNull();
    now = 5 * 60_000;
    expect(await read()).toBeNull();
    expect(m.asked).toHaveLength(2);

    live = true;
    down = true;
    now = 10 * 60_000;
    expect(await read()).toBeNull();
    down = false;
    now = 10 * 60_000 + 29_000;
    expect(await read()).toBeNull();
    now = 10 * 60_000 + 30_000;
    expect(await read()).not.toBeNull();
    expect(m.asked).toHaveLength(4);
  });
});
