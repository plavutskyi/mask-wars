import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, type NearCoin, type SwapCatalog, type SwapProgress, type SwapQuoteView } from '@maskwars/pay';

// Swap against 1Click in memory (PAY_FIXTURE=1), its whole recorded token list, and swaps that move a step every few
// milliseconds. NEAR's RPC is stubbed: maskwars.near and kira.near are there, nobody.near is not, and neither is any
// implicit account.
process.env.PAY_FIXTURE = '1';
process.env.PAY_FIXTURE_STEP_MS = '5';

type Get = { GET: (req: Request) => Promise<Response> };
type Post = { POST: (req: Request) => Promise<Response> };
const catalogRoute = () => import('./route') as Promise<Get>;
const quoteRoute = () => import('./quote/route') as Promise<Post>;
const statusRoute = () => import('./status/route') as Promise<Get>;
const depositRoute = () => import('./deposit/route') as Promise<Post>;
const nearRoute = () => import('./near/route') as Promise<Get>;

const SITE = 'https://maskwars.xyz';
let ip = 0;
function page(path: string, o: { body?: unknown; site?: string | null; origin?: string | null } = {}): Request {
  const post = o.body !== undefined;
  const headers: Record<string, string> = { 'x-real-ip': `10.9.${Math.floor(++ip / 250)}.${ip % 250}` };
  if (o.site !== null) headers['sec-fetch-site'] = o.site ?? 'same-origin';
  if (post && o.origin !== null) headers.origin = o.origin ?? SITE;
  if (post) headers['content-type'] = 'application/json';
  return new Request(`${SITE}/api/pay/swap${path}`, { method: post ? 'POST' : 'GET', headers, ...(post ? { body: JSON.stringify(o.body) } : {}) });
}

const THERE = new Set(['maskwars.near', 'kira.near']);
function nearRpc(down = false) {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('1click.chaindefuser.com')) return real(input, init);
    if (down) return new Response('', { status: 503 });
    const id = JSON.parse(String(init?.body)).params.account_id as string;
    if (THERE.has(id)) return Response.json({ jsonrpc: '2.0', id: 'maskwars', result: { amount: '5000000000000000000000000', storage_usage: 500 } });
    return Response.json({ jsonrpc: '2.0', id: 'maskwars', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
  });
}

let catalog: SwapCatalog;
const coin = (chain: string, symbol: string): NearCoin => catalog.chains.find((c) => c.id === chain)!.coins.find((c) => c.symbol === symbol)!;
const SOL_WALLET = base58(ed25519.getPublicKey(new Uint8Array(32).fill(9)));
const PAYER = '0x1111111111111111111111111111111111111111';

beforeAll(async () => {
  catalog = await (await import('@/lib/swap')).swapCatalog();
});

beforeEach(() => nearRpc());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const json = async <T>(res: Response) => (await res.json()) as T;
const post = async (b: unknown, o: { origin?: string | null } = {}) => (await quoteRoute()).POST(page('/quote', { body: b, ...o }));
const usdt = () => coin('arb', 'USDT');
const usdc = () => coin('sol', 'USDC');

describe('/api/pay/swap', () => {
  it('lists every network a swap starts from, NEAR first, and which ones it pays out to, for this site’s page only', async () => {
    const { GET } = await catalogRoute();
    const res = await GET(page(''));
    expect(res.status).toBe(200);
    const c = await json<{ live: boolean; maxUsd: number; fee: unknown; chains: { id: string; to: boolean; address: boolean }[] }>(res);
    expect(c).toMatchObject({ live: true, maxUsd: 100, fee: { recipient: 'maskwars.near', fee: 25 } });
    // Only the listed networks: 21, of which 11 pay out.
    expect(c.chains).toHaveLength(21);
    expect(c.chains[0]).toMatchObject({ id: 'near', to: true, address: false });
    expect(c.chains.filter((x) => x.to)).toHaveLength(11);
    expect((await GET(page('', { site: 'cross-site' }))).status).toBe(403);
  });
});

describe('/api/pay/swap/quote', () => {
  it('prices a preview between any two coins for anyone, and names nobody in it', async () => {
    const res = await post({ from: usdt().assetId, to: usdc().assetId, amount: '25000000', dry: true });
    expect(res.status).toBe(200);
    const { quote } = await json<{ quote: SwapQuoteView }>(res);
    expect(quote).toMatchObject({ dry: true, recipient: null, refundTo: null, depositAddress: null, originAsset: usdt().assetId, destinationAsset: usdc().assetId, amountIn: '25000000' });
    expect(BigInt(quote.amountOut)).toBeGreaterThan(0n);
    expect(quote.fees).toEqual([{ recipient: 'maskwars.near', fee: 25 }]);
    // The same coins and amount within 10 s: the same preview, without asking 1Click again.
    const again = await json<{ quote: SwapQuoteView }>(await post({ from: usdt().assetId, to: usdc().assetId, amount: '25000000', dry: true }));
    expect(again.quote.correlationId).toBe(quote.correlationId);
    // To a token on NEAR itself, and from one.
    expect((await post({ from: usdt().assetId, to: coin('near', 'USDC').assetId, amount: '25000000', dry: true })).status).toBe(200);
    expect((await post({ from: coin('near', 'NEAR').assetId, to: usdc().assetId, amount: (5n * 10n ** 24n).toString(), dry: true })).status).toBe(200);
  });

  it('takes $1 to the limit, two different coins it lists, a payout only where it reads addresses, and nothing else', async () => {
    const from = usdt().assetId;
    const to = usdc().assetId;
    expect([(await post({ from, to, amount: '500000', dry: true })).status]).toEqual([422]);
    const over = await post({ from, to, amount: '102000000', dry: true });
    expect([over.status, await over.json()]).toEqual([422, { error: 'limit', max: 100 }]);
    for (const b of [
      { from, to: from, amount: '25000000', dry: true },
      { from, to: catalog.chains.find((c) => c.id === 'ton')!.coins[0]!.assetId, amount: '25000000', dry: true },
      { from, to, amount: 25, dry: true },
      { from, to, amount: '25.5', dry: true },
      { from, to, amount: '025000000', dry: true },
      { from, to: 'nep141:nope.near', amount: '25000000', dry: true },
      { from, to, amount: '25000000' },
    ]) {
      expect((await post(b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await post({ from, to, amount: '25000000', dry: true }, { origin: 'https://app.example' })).status).toBe(403);
  });

  it('never prices a coin 1Click lists but the site does not, however the request is crafted', async () => {
    const from = usdt().assetId;
    const to = usdc().assetId;
    // A meme coin, a vault share 1Click prices at a millionth of a dollar, a synthetic dollar, the old bridged USDT on
    // Optimism, a "(DEPRECATED)" double and Hyperliquid's USDC: all real 1Click asset ids, none on the list.
    for (const unlisted of [
      'nep141:blackdragon.tkn.near',
      'nep141:eth-0xaf08e292d62df255f7953665a44ed65f0380aa60.omft.near',
      'nep141:eth-0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d.omft.near',
      'nep245:v2_1.omni.hot.tg:10_359RPSJVdTxwTJT9TyGssr2rFoWo',
      'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g',
      '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054',
    ]) {
      expect((await post({ from: unlisted, to, amount: '25000000', dry: true })).status, unlisted).toBe(400);
      expect((await post({ from, to: unlisted, amount: '25000000', dry: true })).status, unlisted).toBe(400);
    }
  });

  it('paying from a wallet: the refund goes back to that wallet on its own network', async () => {
    const res = await post({ from: usdt().assetId, to: usdc().assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, payer: PAYER });
    expect(res.status).toBe(200);
    const { quote } = await json<{ quote: SwapQuoteView }>(res);
    expect(quote).toMatchObject({ recipient: SOL_WALLET, recipientType: 'DESTINATION_CHAIN', refundTo: PAYER, refundType: 'ORIGIN_CHAIN', amountIn: '25000000' });
    expect(quote.depositAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('paying from an exchange to another network: a refund address on the paying network, read with certainty', async () => {
    const ask = async (refund?: string) => {
      const res = await post({ from: usdt().assetId, to: usdc().assetId, amount: '26000000', dry: false, recipient: SOL_WALLET, ...(refund !== undefined ? { refund } : {}) });
      return [res.status, await res.json()] as const;
    };
    expect(await ask()).toEqual([422, { error: 'refund', why: 'empty' }]);
    expect(await ask('kira.near')).toEqual([422, { error: 'refund', why: 'other', other: 'a NEAR' }]);
    expect(await ask('0x71C7656EC7ab88b098defB751B7401B5f6d8976f')).toEqual([422, { error: 'refund', why: 'checksum' }]);
    const [status, body] = await ask('0x71C7656EC7ab88b098defB751B7401B5f6d8976F');
    expect(status).toBe(200);
    expect((body as { quote: SwapQuoteView }).quote).toMatchObject({ refundTo: '0x71c7656ec7ab88b098defb751b7401b5f6d8976f', refundType: 'ORIGIN_CHAIN' });
  });

  it('from a network whose addresses it cannot read, the refund waits in NEAR Intents for a NEAR account that is there', async () => {
    const ton = catalog.chains.find((c) => c.id === 'ton')!.coins.find((c) => c.symbol === 'USDT')!;
    const ask = async (refund: string) => post({ from: ton.assetId, to: usdc().assetId, amount: '27000000', dry: false, recipient: SOL_WALLET, refund });
    const ok = await ask('Kira.near');
    expect(ok.status).toBe(200);
    expect((await json<{ quote: SwapQuoteView }>(ok)).quote).toMatchObject({ refundTo: 'kira.near', refundType: 'INTENTS' });
    expect([(await ask('nobody.near')).status, await (await ask('nobody.near')).json()]).toEqual([422, { error: 'refund', why: 'missing' }]);
    expect((await ask('UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG')).status).toBe(422);
    // 64 hex digits typed here are also a Sui or Aptos address without its 0x: only an account that is there counts.
    const hex = await ask('ab'.repeat(32));
    expect([hex.status, await hex.json()]).toEqual([422, { error: 'refund', why: 'missing' }]);
  });

  it('to NEAR from an exchange: the refund waits for the receiving account in NEAR Intents, which must be there', async () => {
    const near = coin('near', 'NEAR').assetId;
    const ok = await post({ from: usdt().assetId, to: near, amount: '28000000', dry: false, recipient: 'MaskWars.near' });
    expect(ok.status).toBe(200);
    expect((await json<{ quote: SwapQuoteView }>(ok)).quote).toMatchObject({ recipient: 'maskwars.near', refundTo: 'maskwars.near', refundType: 'INTENTS' });
    const missing = await post({ from: usdt().assetId, to: near, amount: '28000000', dry: false, recipient: 'nobody.near' });
    expect([missing.status, await missing.json()]).toEqual([422, { error: 'account', why: 'missing' }]);
    // Native NEAR opens a new implicit account by itself; a token needs one that is there.
    const fresh = 'ab'.repeat(32);
    expect((await post({ from: usdt().assetId, to: near, amount: '28000000', dry: false, recipient: fresh })).status).toBe(200);
    const token = await post({ from: usdt().assetId, to: coin('near', 'USDC').assetId, amount: '28000000', dry: false, recipient: fresh });
    expect([token.status, await token.json()]).toEqual([422, { error: 'account', why: 'missing' }]);
  });

  it('a coin on NEAR is paid only from a NEAR wallet that is there, never by a deposit address an exchange could use', async () => {
    const from = coin('near', 'USDT').assetId;
    expect((await post({ from, to: usdc().assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, refund: 'kira.near' })).status).toBe(400);
    expect((await post({ from, to: usdc().assetId, amount: '25000000', dry: false, recipient: SOL_WALLET })).status).toBe(400);
    const ghost = await post({ from, to: usdc().assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, payer: 'nobody.near' });
    expect([ghost.status, await ghost.json()]).toEqual([422, { error: 'refund', why: 'missing' }]);
    const res = await post({ from, to: usdc().assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, payer: 'kira.near' });
    expect(res.status).toBe(200);
    const { quote } = await json<{ quote: SwapQuoteView }>(res);
    expect(quote).toMatchObject({ refundTo: 'kira.near', refundType: 'ORIGIN_CHAIN' });
    expect(quote.depositAddress).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a receiver that is not an address of the receiving network, saying which network it looks like', async () => {
    const ask = async (recipient: unknown) => {
      const res = await post({ from: usdt().assetId, to: usdc().assetId, amount: '25000000', dry: false, recipient, payer: PAYER });
      return [res.status, await res.json()];
    };
    expect(await ask(PAYER)).toEqual([422, { error: 'account', why: 'other', other: 'an Ethereum' }]);
    expect(await ask(undefined)).toEqual([422, { error: 'account', why: 'empty' }]);
    const { associatedTokenAccount } = await import('@maskwars/pay');
    expect(await ask(associatedTokenAccount(SOL_WALLET, usdc().contract!))).toEqual([422, { error: 'account', why: 'token-account' }]);
  });

  it('ignores fees, refund types and receivers the body carries: only its own fields reach 1Click', async () => {
    const { nearClient } = await import('@/lib/getnear');
    const asked: unknown[] = [];
    const real = nearClient.quote.bind(nearClient);
    vi.spyOn(nearClient, 'quote').mockImplementation(async (r) => {
      asked.push(r);
      return real(r);
    });
    const res = await post({
      from: usdt().assetId,
      to: usdc().assetId,
      amount: '29000000',
      dry: false,
      recipient: SOL_WALLET,
      payer: PAYER,
      refundTo: 'thief.near',
      refundType: 'INTENTS',
      appFees: [{ recipient: 'thief.near', fee: 500 }],
      recipientType: 'INTENTS',
      slippageTolerance: 5000,
      depositType: 'INTENTS',
    });
    expect(res.status).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      refundTo: PAYER,
      refundType: 'ORIGIN_CHAIN',
      recipient: SOL_WALLET,
      recipientType: 'DESTINATION_CHAIN',
      depositType: 'ORIGIN_CHAIN',
      slippageTolerance: 100,
      appFees: [{ recipient: 'maskwars.near', fee: 25 }],
    });
    expect(JSON.stringify(asked[0])).not.toContain('thief');
  });

  it('reads a real quote back on the server and keeps its address when 1Click’s terms are not the ones asked', async () => {
    const { nearClient } = await import('@/lib/getnear');
    const real = nearClient.quote.bind(nearClient);
    type Q = Awaited<ReturnType<typeof real>>;
    const bent = [
      (q: Q) => ({ ...q, quoteRequest: { ...q.quoteRequest, recipient: PAYER } }),
      (q: Q) => ({ ...q, quoteRequest: { ...q.quoteRequest, refundTo: 'thief.near' } }),
      (q: Q) => ({ ...q, quoteRequest: { ...q.quoteRequest, refundType: 'INTENTS' as const } }),
      (q: Q) => ({ ...q, quoteRequest: { ...q.quoteRequest, destinationAsset: usdt().assetId } }),
      (q: Q) => ({ ...q, quote: { ...q.quote, amountIn: '1' } }),
      (q: Q) => ({ ...q, quote: { ...q.quote, minAmountOut: '1' } }),
      (q: Q) => ({ ...q, quote: { ...q.quote, depositAddress: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' } }),
      (q: Q) => ({ ...q, quoteRequest: { ...q.quoteRequest, appFees: [{ recipient: 'maskwars.near', fee: 300 }] } }),
      // Our share as asked, but someone else's on top: more inside the price than ours and 1Click's most.
      (q: Q) => ({ ...q, quoteRequest: { ...q.quoteRequest, appFees: [{ recipient: 'maskwars.near', fee: 13 }, { recipient: 'thief.near', fee: 200 }] } }),
    ];
    for (const bend of bent) {
      vi.spyOn(nearClient, 'quote').mockImplementationOnce(async (r) => bend(await real(r)));
      const res = await post({ from: usdt().assetId, to: usdc().assetId, amount: '30000000', dry: false, recipient: SOL_WALLET, payer: PAYER });
      const body = await res.text();
      expect([res.status, body.includes('depositAddress')]).toEqual([502, false]);
    }
  });

  it('takes 1Click’s own echo of the fee: our share split with its own, within ours and its most', async () => {
    const { nearClient } = await import('@/lib/getnear');
    const real = nearClient.quote.bind(nearClient);
    vi.spyOn(nearClient, 'quote').mockImplementationOnce(async (r) => {
      const q = await real(r);
      return { ...q, quoteRequest: { ...q.quoteRequest, appFees: [{ recipient: 'maskwars.near', fee: 13 }, { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 20 }] } };
    });
    const res = await post({ from: usdt().assetId, to: usdc().assetId, amount: '35000000', dry: false, recipient: SOL_WALLET, payer: PAYER });
    expect(res.status).toBe(200);
  });

  it('opens with SWAP_LIVE, its own switch: neither PAY_LIVE nor GET_NEAR_LIVE opens it', async () => {
    vi.resetModules();
    vi.stubEnv('PAY_FIXTURE', '');
    vi.stubEnv('PAY_LIVE', '1');
    vi.stubEnv('GET_NEAR_LIVE', '1');
    vi.stubEnv('SWAP_LIVE', '');
    const closed = await (await quoteRoute()).POST(page('/quote', { body: { from: usdt().assetId, to: usdc().assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, payer: PAYER } }));
    expect([closed.status, await closed.json()]).toEqual([403, { error: 'closed' }]);
    expect((await import('@/lib/swap')).swapLive).toBe(false);
    vi.resetModules();
    vi.stubEnv('SWAP_LIVE', '1');
    expect((await import('@/lib/swap')).swapLive).toBe(true);
    // Back to the stand-in for the tests after this one: nothing here may reach the real 1Click.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('says what 1Click refused in its own words: too small with the least, a paused route, a receiver it would not take', async () => {
    const { nearClient } = await import('@/lib/getnear');
    const { OneClickError } = await import('@maskwars/pay');
    vi.spyOn(nearClient, 'quote').mockRejectedValueOnce(new OneClickError(400, 'Temporary swap limits: minimum swap amount is $100'));
    const small = await post({ from: usdt().assetId, to: usdc().assetId, amount: '31000000', dry: true });
    expect([small.status, await small.json()]).toEqual([422, { error: 'small', min: 100 }]);
    vi.spyOn(nearClient, 'quote').mockRejectedValueOnce(new OneClickError(400, 'Quoting for this pair is not available'));
    const paused = await post({ from: usdt().assetId, to: usdc().assetId, amount: '32000000', dry: true });
    expect([paused.status, await paused.json()]).toEqual([422, { error: 'route' }]);
    vi.spyOn(nearClient, 'quote').mockRejectedValueOnce(new OneClickError(400, 'recipient is not valid'));
    const bad = await post({ from: usdt().assetId, to: usdc().assetId, amount: '33000000', dry: false, recipient: SOL_WALLET, payer: PAYER });
    expect([bad.status, await bad.json()]).toEqual([422, { error: 'account', why: 'bad' }]);
  });
});

describe('/api/pay/swap/status', () => {
  it('follows a swap to the transaction that paid the receiver, linked on the explorer of its network', async () => {
    const res = await post({ from: coin('sol', 'SOL').assetId, to: coin('arb', 'USDT').assetId, amount: '200000000', dry: false, recipient: PAYER, payer: SOL_WALLET });
    expect(res.status).toBe(200);
    const { quote } = await json<{ quote: SwapQuoteView }>(res);
    const { GET } = await statusRoute();
    let p: SwapProgress | null = null;
    for (let i = 0; i < 40 && p?.stage !== 'done'; i++) {
      p = await json<SwapProgress>(await GET(page(`/status?address=${quote.depositAddress}`)));
      await new Promise((r) => setTimeout(r, 6));
    }
    expect(p).toMatchObject({ stage: 'done', status: 'SUCCESS', amountOut: quote.amountOut });
    expect(p!.landed?.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(p!.landed?.link).toBe(`https://arbiscan.io/tx/${p!.landed!.hash}`);
  });

  it('refuses an address that is not one', async () => {
    const { GET } = await statusRoute();
    expect((await GET(page('/status?address=<script>'))).status).toBe(400);
    expect((await GET(page('/status?address=0x9d366cbb21925d26e60b58124f3dba9474b208b8'))).status).toBe(404);
  });
});

describe('/api/pay/swap/deposit', () => {
  it('tells 1Click the transaction a wallet sent, a NEAR wallet with its sender, and takes nothing else', async () => {
    const { nearClient } = await import('@/lib/getnear');
    const told: unknown[] = [];
    const real = nearClient.submitDeposit.bind(nearClient);
    vi.spyOn(nearClient, 'submitDeposit').mockImplementation(async (o) => {
      told.push(o);
      return real(o);
    });
    const { quote } = await json<{ quote: SwapQuoteView }>(
      await post({ from: coin('near', 'USDT').assetId, to: usdc().assetId, amount: '34000000', dry: false, recipient: SOL_WALLET, payer: 'kira.near' }),
    );
    const { POST } = await depositRoute();
    const nearTx = 'HYZ4ycqXgR4yEMhfsYgvkZjiU5V6YtbW2D5vhNVF2wWy';
    const ok = await POST(page('/deposit', { body: { address: quote.depositAddress, txHash: nearTx, nearSender: 'kira.near' } }));
    expect([ok.status, await ok.json()]).toEqual([200, { told: true }]);
    expect(told).toEqual([{ txHash: nearTx, depositAddress: quote.depositAddress, nearSenderAccount: 'kira.near' }]);
    for (const b of [
      { address: quote.depositAddress, txHash: nearTx, nearSender: '0x3602b546589a8fcafdce7fad64a46f91db0e4d50' },
      { address: quote.depositAddress, txHash: '0x12' },
      { address: 'x', txHash: nearTx },
    ]) {
      expect((await POST(page('/deposit', { body: b }))).status).toBe(400);
    }
    expect((await POST(page('/deposit', { body: { address: quote.depositAddress, txHash: nearTx }, origin: 'https://evil.example' }))).status).toBe(403);
  });
});

describe('/api/pay/swap/near', () => {
  const deposit = 'ff586ca661152445c7a3925587cb6a66a4f4906d04506e50b92316e280261794';

  it('reads what registering the deposit account costs and what the wallet holds, for a coin on NEAR only', async () => {
    const { GET } = await nearRoute();
    const ask = async (asset: string, payer = 'kira.near') => GET(page(`/near?asset=${encodeURIComponent(asset)}&deposit=${deposit}&payer=${payer}`));
    const native = await json<Record<string, string>>(await ask(coin('near', 'NEAR').assetId));
    // The stand-in chain knows no account on any token: the deposit account and the payer both need registering.
    // 50 NEAR on the account, less what its 500 bytes of storage hold: NEAR never lets that leave.
    const spendable = (50n * 10n ** 24n - 500n * 10n ** 19n).toString();
    expect(native).toEqual({ depositStorage: '1250000000000000000000', payerStorage: '1250000000000000000000', balance: spendable, near: spendable });
    const token = await json<Record<string, string>>(await ask(coin('near', 'USDT').assetId));
    expect(token).toMatchObject({ depositStorage: '1250000000000000000000', payerStorage: '0', balance: (10n ** 30n).toString() });
    expect((await ask(usdt().assetId)).status).toBe(400);
    expect((await ask(coin('near', 'USDT').assetId, '0x3602b546589a8fcafdce7fad64a46f91db0e4d50')).status).toBe(400);
    expect((await GET(page(`/near?asset=${encodeURIComponent(coin('near', 'USDT').assetId)}&deposit=maskwars.near&payer=kira.near`))).status).toBe(400);
  });
});
