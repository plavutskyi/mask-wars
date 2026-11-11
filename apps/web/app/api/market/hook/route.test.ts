// POST /api/market/hook, the agent's webhook, with a stand-in for the marketplace (packages/market/test/a2a.ts) and the
// chain as NEAR RPC answered it (packages/market/test/fixtures/recorded/check.json). No network.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Recording, bodyOf, keyOf } from '../../../../../../packages/check/test/replay';
import { FakeMarketplace } from '../../../../../../packages/market/test/a2a';
import { PRICE, signature } from '@maskwars/market';

const TOKEN = 'aat_00000000000000000000000000000000';
const SECRET = 'test-webhook-secret-0123456789abcdef';
const DRAINED = 'safe-0001.maskwars.near';
const TESTNET_SAFE = 'safe-0001.tinygif8324.testnet';
const RECIPIENT = { network: 'near:mainnet', asset: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', payTo: 'ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc' };

const recorded = JSON.parse(readFileSync(new URL('../../../../../../packages/market/test/fixtures/recorded/check.json', import.meta.url), 'utf8')) as Record<'mainnet' | 'testnet', Recording>;
const rpc = new Map([...recorded.mainnet.exchanges, ...recorded.testnet.exchanges].map((e) => [keyOf(e.url, e.method, e.params), e]));

// What runs after the response, as Next.js would run it; a test waits for it by hand.
const later: Promise<unknown>[] = [];
vi.mock('next/server', () => ({ after: (task: Promise<unknown>) => void later.push(task) }));
const idle = async () => {
  while (later.length > 0) await later.shift();
};

type Route = typeof import('./route');

/** The route as one deployment has it: its variables, the marketplace it talks to, and the chain it reads. */
async function deployment(env: Record<string, string>, market?: FakeMarketplace): Promise<{ route: Route; outside: string[] }> {
  vi.resetModules();
  for (const name of ['MARKET_API_TOKEN', 'MARKET_WEBHOOK_SECRET', 'MARKET_ORIGIN', 'MARKET_AGENT_HANDLE']) vi.stubEnv(name, env[name] ?? '');
  vi.stubEnv('MASKWARS_NETWORK', env.MASKWARS_NETWORK ?? 'mainnet');
  const outside: string[] = [];
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    outside.push(url);
    if (url.startsWith('https://market.near.ai/')) {
      if (!market) throw new TypeError('fetch failed (no marketplace in this test)');
      return market.fetch(input, init);
    }
    const { method, params } = bodyOf(init);
    const hit = rpc.get(keyOf(url, method, params));
    if (!hit) throw new TypeError(`fetch failed (not recorded: ${url} ${method})`);
    return new Response(JSON.stringify(hit.response), { status: hit.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  return { route: await import('./route'), outside };
}

const unsignedPost = (route: Route, ip: string, headers: Record<string, string> = {}) =>
  route.POST(new Request('https://maskwars.xyz/api/market/hook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...headers }, body: '{"event":"hire.created"}' }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(recorded.mainnet.recorded_at) });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  later.length = 0;
});

describe('/api/market/hook before the owner opens it', () => {
  it('says it is not open, names what is missing, and does nothing else', async () => {
    const { route, outside } = await deployment({});
    for (const res of [route.GET(), await unsignedPost(route, '198.51.100.20')]) {
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        service: 'MASK CHECK on Agent Market',
        open: false,
        message: 'Not open yet: the paid listing is being set up. The same check is free now at GET /api/check?account=<id>.',
        needs: ['MARKET_API_TOKEN', 'MARKET_WEBHOOK_SECRET'],
      });
    }
    expect(outside).toEqual([]);
    expect(later).toEqual([]);
  });

  it('stays closed on a token or a secret that is not well formed, without repeating either', async () => {
    const { route } = await deployment({ MARKET_API_TOKEN: 'Bearer aat_00000000000000000000000000000000', MARKET_WEBHOOK_SECRET: 'short' });
    const res = route.GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).needs).toEqual(['MARKET_API_TOKEN', 'MARKET_WEBHOOK_SECRET']);
    expect(text).not.toMatch(/aat_|short/);
  });

  it('one of the two is not enough', async () => {
    const { route } = await deployment({ MARKET_API_TOKEN: TOKEN });
    expect(((await route.GET().json()) as { needs: string[] }).needs).toEqual(['MARKET_WEBHOOK_SECRET']);
  });
});

describe('/api/market/hook, open', () => {
  const open = async (network = 'mainnet', now = Date.now()) => {
    const market = new FakeMarketplace({ price: PRICE.price_amount, slaSeconds: 300, recipient: RECIPIENT, token: TOKEN, secret: SECRET, now: () => now });
    const { route, outside } = await deployment({ MARKET_API_TOKEN: TOKEN, MARKET_WEBHOOK_SECRET: SECRET, MASKWARS_NETWORK: network }, market);
    market.connect((request) => route.POST(request), idle);
    return { market, route, outside, wallet: market.wallet('caller.near') };
  };

  it('GET says the hook is open and gives nothing away', async () => {
    const { route } = await open();
    const res = route.GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ service: 'MASK CHECK on Agent Market', open: true });
    expect(text).not.toMatch(/aat_|whsec_/);
  });

  it('a paid call: the hire is read back, checked on mainnet from two providers and delivered', async () => {
    const { market, outside, wallet } = await open();
    const res = await market.call(`Check before paying\n${DRAINED}`, market.pay(wallet, market.row));
    const task = res.body.result?.task;
    expect(task?.status.state).toBe('TASK_STATE_COMPLETED');
    const text = task?.artifacts?.[0]?.parts[0]?.text ?? '';
    expect(text.split('\n')[0]).toBe('# MASK CHECK: BLOCK');
    expect(text).toMatch(/\[Transaction\]\(https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{32,44}\)/);
    const answer = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)?.[1] ?? 'null') as { results: Array<{ network: string; verdict: string; rpc: string[]; reasons: Array<{ code: string }> }> };
    expect(answer.results[0]).toMatchObject({ network: 'mainnet', verdict: 'block', rpc: ['https://rpc.mainnet.fastnear.com', 'https://near.drpc.org'] });
    expect(answer.results[0]?.reasons.map((r) => r.code)).toEqual(recorded.mainnet.checks.find((c) => c.account === DRAINED)?.codes);
    expect(market.settled).toHaveLength(1);
    expect(market.calls).toEqual(['GET /v1/agents/me/assignments', expect.stringMatching(/\/start$/), expect.stringMatching(/\/submit$/)]);
    // The agent's token went to the marketplace only; the chain was read from mainnet nodes only.
    expect(outside.filter((u) => !u.startsWith('https://market.near.ai/')).every((u) => /^https:\/\/(rpc\.mainnet\.fastnear\.com|near\.drpc\.org|archival-rpc\.mainnet\.fastnear\.com)/.test(u))).toBe(true);
  });

  it('the mainnet site answers for mainnet only: a testnet name is refused, the caller is not charged, no testnet node is asked', async () => {
    const { market, outside, wallet } = await open('mainnet');
    const res = await market.call(TESTNET_SAFE, market.pay(wallet, market.row));
    expect(res.body.result?.task.status.state).toBe('TASK_STATE_REJECTED');
    expect([...market.hires.values()][0]?.item.assignment.cancelDetail).toContain(`${TESTNET_SAFE} (a testnet name; this agent reads mainnet)`);
    expect(market.settled).toEqual([]);
    expect(outside.every((u) => u.startsWith('https://market.near.ai/'))).toBe(true);
  });

  it('a site built for testnet answers for testnet only: a mainnet name is refused and no mainnet node is asked', async () => {
    const { market, outside, wallet } = await open('testnet');
    const refused = await market.call(DRAINED, market.pay(wallet, market.row));
    expect(refused.body.result?.task.status.state).toBe('TASK_STATE_REJECTED');
    const res = await market.call(TESTNET_SAFE, market.pay(wallet, market.row));
    expect(res.body.result?.task.artifacts?.[0]?.parts[0]?.text).toMatch(/^# MASK CHECK: BLOCK\n\n## `safe-0001\.tinygif8324\.testnet`\n\nNEAR testnet,/);
    expect(outside.some((u) => /mainnet|drpc/.test(u))).toBe(false);
  });

  it('a request without the marketplace\'s signature is refused and reaches neither the marketplace nor the chain', async () => {
    const { market, route, outside, wallet } = await open();
    const res = await unsignedPost(route, '198.51.100.21', { 'x-payment': market.pay(wallet, market.row) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
    expect(outside).toEqual([]);
    expect(later).toEqual([]);
  });

  it('30 unsigned requests a minute from one address, then 429; the marketplace\'s own events still get through', async () => {
    const { market, route, wallet } = await open();
    const ip = '198.51.100.22';
    const ts = String(Math.floor(Date.now() / 1000));
    for (let i = 0; i < 30; i++) expect((await unsignedPost(route, ip, { 'x-market-timestamp': ts, 'x-market-signature': signature('another-secret-0123456789abcdefghij', ts, '{"event":"hire.created"}') })).status).toBe(401);
    const over = await unsignedPost(route, ip);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    // The stand-in's events come without an address at all, as from another caller.
    expect((await market.call(DRAINED, market.pay(wallet, market.row))).body.result?.task.status.state).toBe('TASK_STATE_COMPLETED');
  });
});
