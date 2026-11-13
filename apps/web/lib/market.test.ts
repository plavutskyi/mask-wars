import { describe, expect, it, vi } from 'vitest';
import { createLimiter } from './limit';
import { budgeted, listingReader, marketNeeds, marketSecrets, priceText } from './market';

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
    expect(await listingReader({ env: { MARKET_AGENT_HANDLE: 'maskwars' }, fetch: m.fetch })()).toMatchObject({ handle: 'maskwars', name: 'MASK CHECK by MASK WARS', url: 'https://maskwars.market.near.ai' });
    expect(m.asked[0]).toBe('https://market.near.ai/v1/agents/maskwars');
  });

  // The marketplace's own answers, by address: the agent under its handle, its plans under its id.
  const priced = (plans: unknown, status = 200) => {
    const asked: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const body = url.endsWith('/pricing-plans') ? plans : agent({ agent_id: '40d1a8da-c27c-4c81-a3f5-a32036099206' });
      return new Response(JSON.stringify(body), { status: url.endsWith('/pricing-plans') ? status : 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { fetch: f, asked };
  };
  const plan = (over: Record<string, unknown> = {}) => ({ pricing_plan_id: 'p', model: 'per_call', price_amount: '0.1000', is_default: true, listing_status: 'live', ...over });

  it('reads the price of a call from the marketplace and sends people to the agent’s page there', async () => {
    const m = priced([plan({ price_amount: '9.0000', is_default: false }), plan()]);
    const listing = await listingReader({ env: { MARKET_AGENT_HANDLE: 'maskwars' }, fetch: m.fetch })();
    expect(listing).toEqual({ handle: 'maskwars', name: 'MASK CHECK by MASK WARS', url: 'https://maskwars.market.near.ai', page: 'https://market.near.ai/a/maskwars', price: '0.10' });
    expect(m.asked).toEqual(['https://market.near.ai/v1/agents/maskwars', 'https://market.near.ai/v1/agents/40d1a8da-c27c-4c81-a3f5-a32036099206/pricing-plans']);

    // Another marketplace origin and another handle: the page follows both, nothing is written in.
    const staging = await listingReader({ env: { MARKET_AGENT_HANDLE: 'maskwars', MARKET_ORIGIN: 'https://staging.example/' }, fetch: priced([plan({ price_amount: '0.5' })]).fetch })();
    expect(staging).toMatchObject({ page: 'https://staging.example/a/maskwars', url: 'https://maskwars.staging.example', price: '0.50' });
  });

  it('a marketplace that states no price leaves the listing without one', async () => {
    const env = { MARKET_AGENT_HANDLE: 'maskwars' };
    for (const m of [
      priced([]),
      priced([plan({ is_default: false })]),
      priced([plan({ listing_status: 'draft' })]),
      priced([plan({ price_amount: 'free' })]),
      priced([plan({ price_amount: '0.0000' })]),
      priced({ error: 'internal' }, 500),
      priced({ plans: [] }),
    ]) {
      expect(await listingReader({ env, fetch: m.fetch })()).toMatchObject({ handle: 'maskwars', page: 'https://market.near.ai/a/maskwars', price: null });
    }
  });

  it('writes a price the way people read it', () => {
    expect(['0.1000', '0.5', '1', '2.50', '0.125000', '12.3456', ' 0.10 '].map(priceText)).toEqual(['0.10', '0.50', '1.00', '2.50', '0.125', '12.3456', '0.10']);
    expect([undefined, null, 0.1, '', '0', '0.00', '-1', '1e3', '0.1234567', 'abc'].map(priceText)).toEqual(Array(10).fill(null));
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
    const all = market(() => (down ? new TypeError('fetch failed') : live ? { status: 200, body: agent() } : { status: 404, body: { error: 'not_found' } }));
    // The questions about the listing itself; each live answer is followed by one about its price.
    const m = {
      fetch: all.fetch,
      get asked() {
        return all.asked.filter((url) => !url.endsWith('/pricing-plans'));
      },
    };
    const read = listingReader({ env: { MARKET_AGENT_HANDLE: 'maskwars' }, fetch: m.fetch, now: () => now });
    expect((await Promise.all([read(), read(), read()])).every((l) => l?.handle === 'maskwars')).toBe(true);
    expect(m.asked).toHaveLength(1);
    expect(all.asked).toHaveLength(2);

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
