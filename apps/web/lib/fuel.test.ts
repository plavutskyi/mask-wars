import { describe, expect, it } from 'vitest';
import { spendTransactions, spentOf } from '@maskwars/pay';

// A vault opened by a NEAR wallet fuels the minds of the masks it forged: the masks come from the mask factory on
// mainnet, the money moves in four transactions the wallet signs. Here against the factory and NEAR Intents in memory.
process.env.PAY_FIXTURE = '1';
process.env.PAY_FIXTURE_STEP_MS = '50';

const route = <T>(name: string) => import(`../app/api/pay/${name}/route.ts`) as Promise<T>;
type Post = { POST: (req: Request) => Promise<Response> };
type Get = { GET: (req: Request) => Promise<Response> };

const SITE = 'https://maskwars.xyz';
let ip = 0;
function page(path: string, body?: unknown): Request {
  const post = body !== undefined;
  return new Request(`${SITE}/api/pay/${path}`, {
    method: post ? 'POST' : 'GET',
    headers: { 'x-real-ip': `10.1.0.${++ip}`, 'sec-fetch-site': 'same-origin', ...(post ? { origin: SITE, 'content-type': 'application/json' } : {}) },
    ...(post ? { body: JSON.stringify(body) } : {}),
  });
}

const OWNER = 'kira.near';
const NEAR = 10n ** 24n;

describe('the masks a vault can fuel', () => {
  it('lists a NEAR wallet’s forged masks from the factory, with what their minds hold', async () => {
    const { GET } = await route<Get>('masks');
    const res = await GET(page(`masks?account=${OWNER}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ open: true, factory: 'masks.maskwars.near', minRefuel: (NEAR / 10n).toString() });
    expect(body.masks.map((m: { name: string }) => m.name)).toEqual(['kira', 'vex']);
    expect(body.masks[0]).toEqual({ name: 'kira', account: 'kira.masks.maskwars.near', look: 'crimson', brain: '240000000000000000000000', fuel: '1000000000000000000000000', state: 'ready' });
  });

  it('gives a passkey vault none, and an account with no masks none', async () => {
    const { GET } = await route<Get>('masks');
    expect((await (await GET(page(`masks?account=0x${'ab'.repeat(20)}`))).json()).masks).toEqual([]);
    expect((await (await GET(page('masks?account=nobody.near'))).json()).masks).toEqual([]);
    expect((await GET(page('masks?account=Not%20an%20account'))).status).toBe(400);
  });

  it('answers only the site’s own page', async () => {
    const { GET } = await route<Get>('masks');
    const res = await GET(new Request(`${SITE}/api/pay/masks?account=${OWNER}`));
    expect(res.status).toBe(403);
  });
});

describe('a NEAR wallet in the fixture', () => {
  const vex = (amount: bigint) => spendTransactions(OWNER, { receiver: 'masks.maskwars.near', method: 'refuel', args: { name: 'vex' }, amount, tgas: 30 });
  const send = async (txs: unknown) => {
    const { POST } = await route<Post>('fixture');
    return spentOf(((await (await POST(page('fixture', { signer: OWNER, txs }))).json()) as { outcomes: never }).outcomes);
  };

  it('stops at NEAR Intents while the vault is empty, then moves money landed from Solana into the mask’s tank', async () => {
    expect(await send(vex(NEAR))).toMatchObject({ ok: false, step: 2 });

    const { catalog } = await import('./pay');
    const usdc = (await catalog()).chains.find((c) => c.id === 'sol')!.coins.find((c) => c.symbol === 'USDC')!.assetId;
    const { POST: quote } = await route<Post>('quote');
    const q = (await (await quote(page('quote', { kind: 'in', account: OWNER, from: usdc, usd: 25, dry: false }))).json()).quote;
    const { GET: status } = await route<Get>('status');
    for (let i = 0; i < 40; i++) {
      const st = await (await status(page(`status?address=${q.depositAddress}`))).json();
      if (st.stage === 'done') break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const done = await send(vex(NEAR));
    expect(done).toMatchObject({ ok: true, value: { name: 'vex', brain: (NEAR + 910_000_000_000_000_000_000_000n).toString() } });
    const { GET } = await route<Get>('masks');
    const after = (await (await GET(page(`masks?account=${OWNER}`))).json()).masks.find((m: { name: string }) => m.name === 'vex');
    expect(after.brain).toBe((NEAR + 910_000_000_000_000_000_000_000n).toString());
  });

  it('refuses what is not an account or too many transactions', async () => {
    const { POST } = await route<Post>('fixture');
    expect((await POST(page('fixture', { signer: 'Bad Account', txs: [] }))).status).toBe(400);
    expect((await POST(page('fixture', { signer: OWNER, txs: Array(9).fill({}) }))).status).toBe(400);
  });
});
