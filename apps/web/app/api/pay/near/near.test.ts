import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NearCatalog, NearCoin, NearProgress, NearQuoteView } from '@maskwars/pay';

// Get NEAR against 1Click in memory (PAY_FIXTURE=1), its whole recorded token list, and swaps that move a step every
// few milliseconds. NEAR's RPC is stubbed: maskwars.near is there, nobody.near is not.
process.env.PAY_FIXTURE = '1';
process.env.PAY_FIXTURE_STEP_MS = '5';

type Get = { GET: (req: Request) => Promise<Response> };
type Post = { POST: (req: Request) => Promise<Response> };
const catalogRoute = () => import('./route') as Promise<Get>;
const quoteRoute = () => import('./quote/route') as Promise<Post>;
const accountRoute = () => import('./account/route') as Promise<Get>;
const statusRoute = () => import('./status/route') as Promise<Get>;
const depositRoute = () => import('./deposit/route') as Promise<Post>;
const solanaRoute = () => import('./solana/route') as Promise<Get>;

const SITE = 'https://maskwars.xyz';
let ip = 0;
function page(path: string, o: { body?: unknown; site?: string | null; origin?: string | null } = {}): Request {
  const post = o.body !== undefined;
  const headers: Record<string, string> = { 'x-real-ip': `10.7.${Math.floor(++ip / 250)}.${ip % 250}` };
  if (o.site !== null) headers['sec-fetch-site'] = o.site ?? 'same-origin';
  if (post && o.origin !== null) headers.origin = o.origin ?? SITE;
  if (post) headers['content-type'] = 'application/json';
  return new Request(`${SITE}/api/pay/near${path}`, { method: post ? 'POST' : 'GET', headers, ...(post ? { body: JSON.stringify(o.body) } : {}) });
}

let rpcCalls = 0;
function nearRpc(down = false) {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('1click.chaindefuser.com')) return real(input, init);
    rpcCalls++;
    if (down) return new Response('', { status: 503 });
    const id = JSON.parse(String(init?.body)).params.account_id as string;
    if (id === 'maskwars.near') return Response.json({ jsonrpc: '2.0', id: 'maskwars', result: { amount: '5000000000000000000000000', storage_usage: 500 } });
    return Response.json({ jsonrpc: '2.0', id: 'maskwars', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
  });
}

let catalog: NearCatalog;
let usdt: NearCoin;

beforeAll(async () => {
  catalog = await (await import('@/lib/getnear')).nearCatalog();
  usdt = catalog.chains.find((c) => c.id === 'arb')!.coins.find((c) => c.symbol === 'USDT')!;
});

beforeEach(() => {
  rpcCalls = 0;
  nearRpc();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = async <T>(res: Response) => (await res.json()) as T;

describe('/api/pay/near', () => {
  it('lists every network 1Click reaches but NEAR itself, with the fee and the limit, for this site’s page only', async () => {
    const { GET } = await catalogRoute();
    const res = await GET(page(''));
    expect(res.status).toBe(200);
    const c = await json<{ live: boolean; maxUsd: number; fee: unknown; chains: { id: string }[] }>(res);
    expect(c.live).toBe(true);
    expect(c.maxUsd).toBe(100);
    expect(c.fee).toEqual({ recipient: 'maskwars.near', fee: 25 });
    // Only the listed networks: 20 besides NEAR itself.
    expect(c.chains).toHaveLength(20);
    expect(c.chains.map((x) => x.id)).not.toContain('near');
    expect((await GET(page('', { site: 'cross-site' }))).status).toBe(403);
  });
});

describe('/api/pay/near/account', () => {
  const ask = async (id: string) => json<Record<string, unknown>>(await (await accountRoute()).GET(page(`/account?id=${encodeURIComponent(id)}`)));

  it('finds a name on NEAR, says when one is not there, and takes an implicit address that is not there yet', async () => {
    expect(await ask('MaskWars.near')).toEqual({ ok: true, id: 'maskwars.near', kind: 'named', exists: true });
    expect(await ask('nobody.near')).toEqual({ ok: true, id: 'nobody.near', kind: 'named', exists: false });
    const hex = 'df9cf2a975739a9a181c56a271421ad94217c22b252eafb933e523aa0aac63d4';
    expect(await ask(hex)).toEqual({ ok: true, id: hex, kind: 'implicit', exists: false });
  });

  it('refuses an Ethereum address and a testnet account without asking NEAR', async () => {
    expect(await ask('0x3602b546589a8fcafdce7fad64a46f91db0e4d50')).toEqual({ ok: false, why: 'eth' });
    expect(await ask('alice.testnet')).toEqual({ ok: false, why: 'testnet' });
    expect(rpcCalls).toBe(0);
  });

  it('never reads a silent node as "no such account"', async () => {
    vi.resetModules();
    nearRpc(true);
    const res = await (await accountRoute()).GET(page('/account?id=someone.near'));
    expect(res.status).toBe(503);
    const hex = 'ab'.repeat(32);
    expect(await json(await (await accountRoute()).GET(page(`/account?id=${hex}`)))).toEqual({ ok: true, id: hex, kind: 'implicit', exists: null });
  });
});

describe('/api/pay/near/quote', () => {
  const post = async (b: unknown, o: { origin?: string | null } = {}) => (await quoteRoute()).POST(page('/quote', { body: b, ...o }));

  it('prices a preview for anyone and names nobody in it', async () => {
    const res = await post({ from: usdt.assetId, usd: 25, dry: true });
    expect(res.status).toBe(200);
    const { quote } = await json<{ quote: NearQuoteView }>(res);
    expect(quote).toMatchObject({ dry: true, recipient: null, refundTo: null, depositAddress: null, destinationAsset: 'nep141:wrap.near', amountIn: '25000000' });
    expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
    expect(quote.fees).toEqual([{ recipient: 'maskwars.near', fee: 25 }]);
  });

  it('takes $1 to the season’s limit, a coin it lists and nothing else', async () => {
    for (const b of [
      { from: usdt.assetId, usd: 0.5, dry: true },
      { from: usdt.assetId, usd: 100.01, dry: true },
      { from: usdt.assetId, usd: '25', dry: true },
      { from: 'nep141:wrap.near', usd: 25, dry: true },
      { from: usdt.assetId, usd: 25 },
    ]) {
      expect((await post(b)).status).toBe(400);
    }
    expect((await post({ from: usdt.assetId, usd: 25, dry: true }, { origin: 'https://app.example' })).status).toBe(403);
  });

  it('never prices a coin 1Click lists but the site does not, however the request is crafted', async () => {
    for (const unlisted of [
      'nep141:base-0x532f27101965dd16442e59d40670faf5ebb142e4.omft.near', // BRETT
      'nep141:base-0x0bb69b79bc829e1cfcc34a740110886d98d2bd14.omft.near', // gtUSDCp, a vault share
      'nep141:sol-0x936420c6ae310eb29511d139991654f922456fbe.omdep.near', // USD1
      'nep245:v2_1.omni.hot.tg:137_3hpYoaLtt8MP1Z2GH1U473DMRKgr', // USDT(DEPRECATED) on Polygon
      'nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et', // USDT0 on Monad, a network not listed
    ]) {
      expect((await post({ from: unlisted, usd: 25, dry: true })).status, unlisted).toBe(400);
    }
  });

  it('gives a deposit address paying native NEAR to the account, refunds to the same account in NEAR Intents', async () => {
    const res = await post({ from: usdt.assetId, usd: 25, recipient: 'maskwars.near', dry: false });
    expect(res.status).toBe(200);
    const { quote } = await json<{ quote: NearQuoteView }>(res);
    expect(quote).toMatchObject({
      dry: false,
      recipient: 'maskwars.near',
      recipientType: 'DESTINATION_CHAIN',
      refundTo: 'maskwars.near',
      refundType: 'INTENTS',
      originAsset: usdt.assetId,
      destinationAsset: 'nep141:wrap.near',
    });
    expect(quote.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('ignores a refund address or fees the body carries: only coin, amount and receiver reach 1Click', async () => {
    const { nearClient } = await import('@/lib/getnear');
    const asked: unknown[] = [];
    const real = nearClient.quote.bind(nearClient);
    vi.spyOn(nearClient, 'quote').mockImplementation(async (r) => {
      asked.push(r);
      return real(r);
    });
    const res = await post({
      from: usdt.assetId,
      usd: 31,
      recipient: 'maskwars.near',
      dry: false,
      refundTo: 'thief.near',
      refundType: 'ORIGIN_CHAIN',
      appFees: [{ recipient: 'thief.near', fee: 500 }],
      recipientType: 'INTENTS',
      slippageTolerance: 5000,
    });
    expect(res.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      refundTo: 'maskwars.near',
      refundType: 'INTENTS',
      recipient: 'maskwars.near',
      recipientType: 'DESTINATION_CHAIN',
      slippageTolerance: 100,
      appFees: [{ recipient: 'maskwars.near', fee: 25 }],
    });
    expect(JSON.stringify(asked[0])).not.toContain('thief');
  });

  it('reads a real quote back on the server and keeps its address when 1Click’s terms are not the ones asked', async () => {
    const { nearClient } = await import('@/lib/getnear');
    const real = nearClient.quote.bind(nearClient);
    const bent = [
      (q: Awaited<ReturnType<typeof real>>) => ({ ...q, quoteRequest: { ...q.quoteRequest, recipient: 'thief.near' } }),
      (q: Awaited<ReturnType<typeof real>>) => ({ ...q, quoteRequest: { ...q.quoteRequest, refundTo: 'thief.near' } }),
      (q: Awaited<ReturnType<typeof real>>) => ({ ...q, quoteRequest: { ...q.quoteRequest, destinationAsset: usdt.assetId } }),
      (q: Awaited<ReturnType<typeof real>>) => ({ ...q, quote: { ...q.quote, minAmountOut: '1' } }),
      (q: Awaited<ReturnType<typeof real>>) => ({ ...q, quoteRequest: { ...q.quoteRequest, appFees: [{ recipient: 'maskwars.near', fee: 300 }] } }),
    ];
    for (const bend of bent) {
      vi.spyOn(nearClient, 'quote').mockImplementationOnce(async (r) => bend(await real(r)));
      const res = await post({ from: usdt.assetId, usd: 32, recipient: 'maskwars.near', dry: false });
      const body = await res.text();
      expect([res.status, body.includes('depositAddress')]).toEqual([502, false]);
    }
  });

  it('gives no address for a name NEAR does not know, an Ethereum address, or no account at all', async () => {
    const ask = async (recipient: unknown) => {
      const res = await post({ from: usdt.assetId, usd: 25, recipient, dry: false });
      return [res.status, await res.json()];
    };
    expect(await ask('nobody.near')).toEqual([422, { error: 'account', why: 'missing' }]);
    expect(await ask('0x3602b546589a8fcafdce7fad64a46f91db0e4d50')).toEqual([422, { error: 'account', why: 'eth' }]);
    expect(await ask(undefined)).toEqual([422, { error: 'account', why: 'empty' }]);
  });

  it('opens with GET_NEAR_LIVE, its own switch: PAY_LIVE for the vault does not open it', async () => {
    vi.resetModules();
    vi.stubEnv('PAY_FIXTURE', '');
    vi.stubEnv('PAY_LIVE', '1');
    vi.stubEnv('GET_NEAR_LIVE', '');
    const closed = await (await quoteRoute()).POST(page('/quote', { body: { from: usdt.assetId, usd: 25, recipient: 'maskwars.near', dry: false } }));
    expect([closed.status, await closed.json()]).toEqual([403, { error: 'closed' }]);
    expect((await import('@/lib/getnear')).nearLive).toBe(false);

    vi.resetModules();
    vi.stubEnv('PAY_LIVE', '');
    vi.stubEnv('GET_NEAR_LIVE', '1');
    expect((await import('@/lib/getnear')).nearLive).toBe(true);
    expect((await import('@/lib/pay')).live).toBe(false);
    // Back to the stand-in for the tests after this one: nothing here may reach the real 1Click.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('names the least a paused-small route takes, from 1Click’s own words', async () => {
    const { nearClient } = await import('@/lib/getnear');
    const { OneClickError } = await import('@maskwars/pay');
    vi.spyOn(nearClient, 'quote').mockRejectedValueOnce(new OneClickError(400, 'Temporary swap limits: minimum swap amount is $100'));
    const small = await post({ from: usdt.assetId, usd: 26, dry: true });
    expect([small.status, await small.json()]).toEqual([422, { error: 'small', min: 100 }]);
    vi.spyOn(nearClient, 'quote').mockRejectedValueOnce(new OneClickError(400, 'Quoting for this pair is not available'));
    const paused = await post({ from: usdt.assetId, usd: 27, dry: true });
    expect([paused.status, await paused.json()]).toEqual([422, { error: 'route' }]);
  });
});

describe('/api/pay/near/status', () => {
  it('follows a swap to the NEAR transaction that paid the account', async () => {
    const res = await (await quoteRoute()).POST(page('/quote', { body: { from: usdt.assetId, usd: 30, recipient: 'maskwars.near', dry: false } }));
    const { quote } = await json<{ quote: NearQuoteView }>(res);
    const { GET } = await statusRoute();
    let p: NearProgress | null = null;
    for (let i = 0; i < 40 && p?.stage !== 'done'; i++) {
      p = await json<NearProgress>(await GET(page(`/status?address=${quote.depositAddress}`)));
      await new Promise((r) => setTimeout(r, 6));
    }
    expect(p).toMatchObject({ stage: 'done', status: 'SUCCESS', amountOut: quote.amountOut });
    expect(p!.landedTx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it('refuses an address that is not one', async () => {
    const { GET } = await statusRoute();
    expect((await GET(page('/status?address=<script>'))).status).toBe(400);
    expect((await GET(page('/status?address=0x9d366cbb21925d26e60b58124f3dba9474b208b8'))).status).toBe(404);
  });
});

describe('the stand-in’s other endings', () => {
  it('can end refunded or failed, or come in short and wait for the rest until the deadline, as 1Click words each', async () => {
    const { settleFixture } = await import('@/lib/getnear');
    const at = (status: string) =>
      ({
        correlationId: 'c',
        updatedAt: '',
        status,
        quoteResponse: { quote: { amountIn: '25000000' }, quoteRequest: { recipientType: 'DESTINATION_CHAIN', deadline: '2026-11-11T22:00:00.000Z' } },
        swapDetails: { amountOut: '1', destinationChainTxHashes: [] },
      }) as unknown as Parameters<typeof settleFixture>[0];
    const done = at('SUCCESS');
    const before = Date.parse('2026-11-11T21:30:00.000Z');
    const after = Date.parse('2026-11-11T22:00:01.000Z');
    expect(settleFixture(done, 'a', 'refunded')).toMatchObject({ status: 'REFUNDED', swapDetails: { refundedAmount: '25000000' } });
    expect(settleFixture(at('PENDING_DEPOSIT'), 'a', 'short', before).status).toBe('PENDING_DEPOSIT');
    expect(settleFixture(at('KNOWN_DEPOSIT_TX'), 'a', 'short', before)).toMatchObject({ status: 'INCOMPLETE_DEPOSIT', swapDetails: { depositedAmount: '24500000' } });
    expect(settleFixture(done, 'a', 'short', before).status).toBe('INCOMPLETE_DEPOSIT');
    expect(settleFixture(done, 'a', 'short', after)).toMatchObject({ status: 'REFUNDED', swapDetails: { refundedAmount: '24500000' } });
    // As 1Click may answer: short, without saying how much came.
    const unknown = settleFixture(done, 'a', 'short-unknown', before);
    expect(unknown.status).toBe('INCOMPLETE_DEPOSIT');
    expect(unknown.swapDetails.depositedAmount).toBeUndefined();
    expect(settleFixture(done, 'a', 'failed').status).toBe('FAILED');
    expect(settleFixture(done, 'a', 'refunded').swapDetails.amountOut).toBeUndefined();
    expect(settleFixture(done, 'a', undefined).swapDetails.destinationChainTxHashes?.[0]?.explorerUrl).toBe('');
  });
});

describe('/api/pay/near/deposit', () => {
  it('tells 1Click the transaction a wallet sent, and takes only an address and a transaction id', async () => {
    const quote = await json<{ quote: NearQuoteView }>(
      await (await quoteRoute()).POST(page('/quote', { body: { from: usdt.assetId, usd: 33, recipient: 'maskwars.near', dry: false } })),
    );
    const { POST } = await depositRoute();
    const ok = await POST(page('/deposit', { body: { address: quote.quote.depositAddress, txHash: `0x${'ab'.repeat(32)}` } }));
    expect([ok.status, await ok.json()]).toEqual([200, { told: true }]);
    // 1Click not knowing the address is no error for the page: the deposit lands either way.
    const unknown = await POST(page('/deposit', { body: { address: `0x${'12'.repeat(20)}`, txHash: `0x${'ab'.repeat(32)}` } }));
    expect([unknown.status, await unknown.json()]).toEqual([200, { told: false }]);
    for (const b of [{ address: 'x', txHash: `0x${'ab'.repeat(32)}` }, { address: quote.quote.depositAddress, txHash: '0x12' }, { address: quote.quote.depositAddress }]) {
      expect((await POST(page('/deposit', { body: b }))).status).toBe(400);
    }
    expect((await POST(page('/deposit', { body: { address: quote.quote.depositAddress, txHash: `0x${'ab'.repeat(32)}` }, origin: 'https://evil.example' }))).status).toBe(403);
  });
});

describe('/api/pay/near/solana', () => {
  const sol = () => catalog.chains.find((c) => c.id === 'sol')!;

  it('gives a blockhash and the mint as the chain has it, only for a Solana coin on offer', async () => {
    const usdc = sol().coins.find((c) => c.symbol === 'USDC')!;
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (_: RequestInfo | URL, init?: RequestInit) => {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      asked.push(method);
      if (method === 'getLatestBlockhash') {
        expect(params).toEqual([{ commitment: 'confirmed' }]);
        return Response.json({ jsonrpc: '2.0', id: 1, result: { value: { blockhash: '6G5bT82cfu1WVFDJsGhvr4AJS26L6F3jPxmtekZZ7S7p' } } });
      }
      if (method === 'getBalance') return Response.json({ jsonrpc: '2.0', id: 1, result: { value: 5_000_000 } });
      if (method === 'getTokenAccountBalance') {
        // The payer's USDC account, as the payer's address and the mint give it.
        expect(params[0]).toBe('FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B');
        return Response.json({ jsonrpc: '2.0', id: 1, result: { value: { amount: '1108538251' } } });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: ['AQAAAJj+huiNm+Lqi8HMpIeLKYjCQPUrhCS/tA7Rot3LXhmbMFC27lm+HwAGAQEAAABicKqKWcWUBbRShshncubNEm6bil06OFNtN/e0FOi2Zw==', 'base64'] } },
      });
    });
    const { GET } = await solanaRoute();
    const res = await GET(page(`/solana?asset=${encodeURIComponent(usdc.assetId)}`));
    expect(await res.json()).toEqual({
      blockhash: '6G5bT82cfu1WVFDJsGhvr4AJS26L6F3jPxmtekZZ7S7p',
      mint: { address: usdc.contract, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals: 6 },
      lamports: null,
      balance: null,
    });
    expect(asked).toEqual(['getLatestBlockhash', 'getAccountInfo']);
    // With the payer: what it holds, SOL and the token, so a payment that cannot go through is not offered.
    const owner = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const withOwner = await GET(page(`/solana?asset=${encodeURIComponent(usdc.assetId)}&owner=${owner}`));
    expect(await withOwner.json()).toMatchObject({ lamports: '5000000', balance: '1108538251', mint: { decimals: 6 } });
    const solCoin = sol().coins.find((c) => c.symbol === 'SOL')!;
    expect(await (await GET(page(`/solana?asset=${encodeURIComponent(solCoin.assetId)}&owner=${owner}`))).json()).toEqual({
      blockhash: '6G5bT82cfu1WVFDJsGhvr4AJS26L6F3jPxmtekZZ7S7p',
      mint: null,
      lamports: '5000000',
      balance: '5000000',
    });
    expect((await GET(page(`/solana?asset=${encodeURIComponent(solCoin.assetId)}&owner=0xnot`))).status).toBe(400);
  });

  it('is no open door to a Solana node: another network’s coin or an unknown asset is refused', async () => {
    const { GET } = await solanaRoute();
    expect((await GET(page(`/solana?asset=${encodeURIComponent(usdt.assetId)}`))).status).toBe(400);
    expect((await GET(page('/solana?asset=whatever'))).status).toBe(400);
    expect((await GET(page('/solana?asset=x', { site: 'cross-site' }))).status).toBe(403);
  });
});
