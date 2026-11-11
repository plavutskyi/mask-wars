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

describe('/api/check, as the repo stands: MASK CHECK not yet published in its TEE', () => {
  it('reads the chain itself and says plainly that nothing is signed', async () => {
    const r = await (await get('account=intents.near', '198.51.100.20')).json();
    expect(r.verdict).toBe('allow');
    expect(r.tee).toEqual({ signed: false, why: 'MASK CHECK is not published in its TEE yet: the site read this answer itself' });
  });
});

describe('/api/check, once the module is published and the site holds a payment key', () => {
  type Fixtures = typeof import('@/lib/check-tee.fixtures');
  let signed: typeof import('./route');
  let f: Fixtures;
  let outlayer: { url: string; body: unknown }[] = [];
  let reply: (account: string) => Response = () => new Response('{}', { status: 500 });

  beforeAll(async () => {
    f = await import('@/lib/check-tee.fixtures');
    vi.resetModules();
    vi.doMock('@/lib/check-tee', async (original) => {
      const real = await original<typeof import('@/lib/check-tee')>();
      return { ...real, createTees: (o: Parameters<typeof real.createTees>[0]) => real.createTees({ ...o, deployment: f.DEPLOYED, now: () => f.NOW }) };
    });
    vi.stubEnv('OUTLAYER_PAYMENT_KEY', 'maskwars.near:3:secret');
    const rpc = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://api.outlayer.ai/')) {
        const body = JSON.parse(String(init?.body)) as { input: { account: string } };
        outlayer.push({ url: String(input), body });
        return reply(body.input.account);
      }
      return rpc(input, init);
    }) as typeof fetch);
    signed = await import('./route');
    vi.unstubAllEnvs();
  });

  const ask = (query: string, ip: string) => signed.GET(new Request(`https://maskwars.xyz/api/check?${query}`, { headers: { 'x-real-ip': ip } }));

  it('hands on the answer signed in the TEE, with the key, the message and the signature', async () => {
    outlayer = [];
    reply = (account) => Response.json(f.run(f.signedAnswer(f.checkOf(account))));
    const r = await (await ask('account=Safe-0001.maskwars.near', '198.51.100.30')).json();
    expect(outlayer).toEqual([
      { url: 'https://api.outlayer.ai/call/maskwars.near/check', body: { input: { account: 'safe-0001.maskwars.near', network: 'mainnet', signed: true }, version_key: f.WASM } },
    ]);
    expect(r).toMatchObject({ ...f.checkOf(), tee: { signed: true, key: f.PROJECT.key, project: 'maskwars.near/check', requested_wasm_sha256: f.WASM } });
    expect(r.tee).not.toHaveProperty('wasm_sha256');
    expect(typeof r.tee.signature).toBe('string');
    expect(JSON.parse(r.tee.message)).toMatchObject({ maskwars_check: 2, account: 'safe-0001.maskwars.near', verdict: 'block' });
  });

  it('reads the chain itself when the TEE answer does not verify, and says why', async () => {
    reply = (account) => Response.json(f.run(f.signedAnswer(f.checkOf(account), { by: f.FORGER })));
    const r = await (await ask('account=intents.near', '198.51.100.31')).json();
    // The site's own read of the recorded chain, not the forged block.
    expect(r).toMatchObject({ account: 'intents.near', verdict: 'allow', rpc: ['https://rpc.mainnet.fastnear.com', 'https://near.drpc.org'] });
    expect(r.tee).toEqual({ signed: false, why: "the TEE's answer did not verify (signed by another key than the published one): the site read this one itself" });
  });

  it('never pays for what the check refuses anyway', async () => {
    outlayer = [];
    for (const query of ['account=Not%20an%20id', 'account=alice.near&network=testnet', 'account=nova.tinygif8324.testnet&network=mainnet']) {
      expect((await ask(query, '198.51.100.32')).status).toBe(400);
    }
    expect(outlayer).toEqual([]);
  });
});

describe('/api/check, when the TEE side goes wrong', () => {
  type Fixtures = typeof import('@/lib/check-tee.fixtures');
  type Tees = ReturnType<typeof import('@/lib/check-tee').createTees>;
  let route2: typeof import('./route');
  let f: Fixtures;
  let STALE = '';
  let behave: Tees['ask'] = async () => ({ signed: false, why: 'unset' });

  beforeAll(async () => {
    f = await import('@/lib/check-tee.fixtures');
    STALE = (await import('@/lib/check-tee')).STALE_RULES;
    vi.resetModules();
    vi.doMock('@/lib/check-tee', async (original) => {
      const real = await original<typeof import('@/lib/check-tee')>();
      return { ...real, createTees: (): Tees => ({ ready: true, ask: (...args) => behave(...args) }) };
    });
    route2 = await import('./route');
  });

  const ask = (query: string, ip: string) => route2.GET(new Request(`https://maskwars.xyz/api/check?${query}`, { headers: { 'x-real-ip': ip } }));

  it('serves its own verdict, not a signed one made by an older shared list, and says why', async () => {
    // The module's list had no word on this account, so it signed `block` by other rules; the site's own list rules.
    behave = async (account) => {
      const answer = f.signedAnswer(f.checkOf(account), { rules: 'f'.repeat(64) });
      return { check: f.checkOf(account), tee: { signed: true, outlayer: 'mainnet', project: 'maskwars.near/check', requested_wasm_sha256: f.WASM, key: f.PROJECT.key, module: answer.module, message: answer.signed.message, signature: answer.signed.signature, attestation_url: null, call_id: null } };
    };
    const res = await ask('account=intents.near', '198.51.100.40');
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ account: 'intents.near', verdict: 'allow', rpc: ['https://rpc.mainnet.fastnear.com', 'https://near.drpc.org'] });
    expect(r.tee).toEqual({ signed: false, why: STALE });
  });

  it('never fails the check when asking the TEE throws', async () => {
    behave = async () => {
      throw new TypeError("Invalid URL: 'http://['");
    };
    const res = await ask('account=intents.near', '198.51.100.41');
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ account: 'intents.near', verdict: 'allow' });
    expect(r.tee).toEqual({ signed: false, why: "the TEE's answer could not be read: the site read this one itself" });
  });
});
