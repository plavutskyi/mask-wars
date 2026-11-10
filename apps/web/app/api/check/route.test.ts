// GET and POST /api/check over what NEAR mainnet and testnet RPC answered (packages/check/test/recorded), no network.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Exchange = { url: string; method: string; params: unknown; status: number; response: unknown };

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]));
  return v;
}
const keyOf = (url: string, method: string, params: unknown) => `${url} ${method} ${JSON.stringify(sorted(params))}`;
const recorded = (network: string) =>
  (JSON.parse(readFileSync(new URL(`../../../../../packages/check/test/recorded/${network}.json`, import.meta.url), 'utf8')) as { exchanges: Exchange[] }).exchanges;
const answers = new Map([...recorded('mainnet'), ...recorded('testnet')].map((e) => [keyOf(e.url, e.method, e.params), e]));

let route: typeof import('./route');
beforeAll(async () => {
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    const hit = answers.get(keyOf(String(input), method, params));
    if (!hit) throw new TypeError('fetch failed (not recorded)');
    return new Response(JSON.stringify(hit.response), { status: hit.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  route = await import('./route');
});

const get = (query: string, ip = '198.51.100.10') => route.GET(new Request(`https://maskwars.xyz/api/check?${query}`, { headers: { 'x-real-ip': ip } }));
const post = (body: unknown, ip = '198.51.100.11') =>
  route.POST(new Request('https://maskwars.xyz/api/check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify(body) }));

describe('/api/check', () => {
  it('reads a .near account on mainnet by itself, from two providers that agree', async () => {
    const res = await get('account=intents.near');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const r = await res.json();
    expect(r).toMatchObject({ account: 'intents.near', network: 'mainnet', verdict: 'allow', rpc: ['https://rpc.mainnet.fastnear.com', 'https://near.drpc.org'] });
    expect(r.reasons.map((x: { code: string }) => x.code)).toEqual(['account_age', 'contract', 'rpc_agree']);
  });

  it('reads a .testnet account on testnet, as before', async () => {
    const r = await (await get('account=safe-0001.tinygif8324.testnet')).json();
    expect(r).toMatchObject({ network: 'testnet', verdict: 'block', rpc: ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'] });
    expect(r.reasons.map((x: { code: string }) => x.code)).toEqual(['arena_drained', 'account_age', 'contract']);
  });

  it('takes the network from the request when it is named', async () => {
    const r = await (await get('account=intents.near&network=mainnet')).json();
    expect(r.network).toBe('mainnet');
    const wrong = await get('account=nova.tinygif8324.testnet&network=mainnet');
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'nova.tinygif8324.testnet is a testnet name; this check reads mainnet' });
    const moon = await get('account=intents.near&network=moon');
    expect(moon.status).toBe(400);
    expect(await moon.json()).toEqual({ error: 'network: testnet or mainnet' });
  });

  it('POST: blocks a mainnet account that does not exist, and refuses a mainnet name on testnet', async () => {
    const r = await (await post({ account: 'treasury.intents.near' })).json();
    expect(r).toMatchObject({ network: 'mainnet', verdict: 'block', summary: 'BLOCK: No such account on mainnet: a payment cannot arrive.' });
    const wrong = await post({ account: 'alice.near', network: 'testnet' });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'alice.near is a mainnet name; this check reads testnet' });
  });

  it('gives one caller 30 checks a minute on both networks together', async () => {
    const ip = '198.51.100.99';
    for (let i = 0; i < 30; i++) expect((await get(`account=x&network=${i % 2 ? 'mainnet' : 'testnet'}`, ip)).status).toBe(400);
    const res = await get('account=intents.near', ip);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
