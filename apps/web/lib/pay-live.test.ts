import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakePay } from '@maskwars/pay/fake';
import oneclick from '@maskwars/pay/fixtures/oneclick.json';
import masks from '@maskwars/pay/fixtures/masks.json';

// The owner's switch as a production build reads it (no PAY_FIXTURE): PAY_LIVE opens money in, deposit addresses and
// Fuel for a forged mask's mind; a cash-out of a person's own money never waits for it, so turning PAY_LIVE off never
// locks a vault. 1Click and the chain answer from memory here, through the same fetch the real ones would get.

type Post = { POST: (req: Request) => Promise<Response> };
type Get = { GET: (req: Request) => Promise<Response> | Response };

const SITE = 'https://maskwars.xyz';
const VAULT = '0x3602b546589a8fcafdce7fad64a46f91db0e4d50';
const OWNER = 'kira.near';
const BASE = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const NEAR = 10n ** 24n;

let ip = 0;
function page(path: string, body?: unknown): Request {
  const post = body !== undefined;
  return new Request(`${SITE}/api/pay/${path}`, {
    method: post ? 'POST' : 'GET',
    headers: { 'x-real-ip': `10.2.0.${++ip}`, 'sec-fetch-site': 'same-origin', ...(post ? { origin: SITE, 'content-type': 'application/json' } : {}) },
    ...(post ? { body: JSON.stringify(body) } : {}),
  });
}

/** A production deployment with PAY_LIVE as given, and the factory on chain or not: what each route reads at start. */
async function deployment(o: { live: boolean; forge: boolean }) {
  vi.resetModules();
  vi.stubEnv('VERCEL_ENV', 'production');
  vi.stubEnv('PAY_FIXTURE', '1');
  vi.stubEnv('PAY_LIVE', o.live ? '1' : '');
  vi.doMock('@maskwars/network', async (real) => {
    const m = await real<typeof import('@maskwars/network')>();
    const mainnet = { ...m.NETWORKS.mainnet, sections: { ...m.NETWORKS.mainnet.sections, forge: o.forge } };
    return { ...m, NETWORKS: { ...m.NETWORKS, mainnet } };
  });
  const world = fakePay({ tokens: oneclick.tokens as never, stepMs: 50, factory: 'masks.maskwars.near', masks: masks.masks as never });
  const asked: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    asked.push(url.hostname === '1click.chaindefuser.com' ? url.pathname : `rpc ${JSON.parse(String(init?.body ?? '{}')).params?.method_name ?? ''}`);
    return world.fetch(input, init);
  });
  const lib = await import('./pay');
  const route = <T>(name: string) => import(`../app/api/pay/${name}/route.ts`) as Promise<T>;
  return { lib, route, world, asked };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('@maskwars/network');
  vi.resetModules();
});

describe('PAY_LIVE off (never set, or turned off to roll back)', () => {
  it('reads as a production build: no sandbox, money in closed, Fuel closed even with the factory on chain', async () => {
    const { lib } = await deployment({ live: false, forge: true });
    expect(lib.isFixture).toBe(false);
    expect(lib.live).toBe(false);
    expect(lib.forgeLive).toBe(false);
  });

  it('gives no deposit address', async () => {
    const { route, asked } = await deployment({ live: false, forge: true });
    const { POST } = await route<Post>('quote');
    const res = await POST(page('quote', { kind: 'in', account: VAULT, from: 'x', usd: 10, dry: false }));
    expect([res.status, await res.json()]).toEqual([403, { error: 'closed' }]);
    expect(asked).toEqual([]);
  });

  it('shows no masks to fuel and does not read the factory', async () => {
    const { route, asked } = await deployment({ live: false, forge: true });
    const { GET } = await route<Get>('masks');
    const res = await GET(page(`masks?account=${OWNER}`));
    expect(await res.json()).toEqual({ open: false, factory: 'masks.maskwars.near', minRefuel: (NEAR / 10n).toString(), masks: [] });
    expect(asked).toEqual([]);
  });

  it('still lets a person take their money out: a real cash-out quote, its intent and its submission all reach 1Click', async () => {
    const { lib, route, world, asked } = await deployment({ live: false, forge: false });
    world.ledger.set(VAULT, new Map([['nep141:wrap.near', 3n * NEAR]]));
    const usdcBase = (await lib.catalog()).chains.find((c) => c.id === 'base')!.coins.find((c) => c.symbol === 'USDC')!.assetId;

    const { POST: quote } = await route<Post>('quote');
    const q = await quote(page('quote', { kind: 'out', account: VAULT, from: 'nep141:wrap.near', to: usdcBase, recipient: BASE, units: NEAR.toString(), dry: false }));
    expect(q.status).toBe(200);
    const { depositAddress } = (await q.json()).quote as { depositAddress: string };
    expect(depositAddress).toBeTruthy();

    const { POST: intent } = await route<Post>('intent');
    const i = await intent(page('intent', { depositAddress, signer: VAULT, standard: 'webauthn' }));
    expect(i.status).toBe(200);
    expect((await i.json()).intent).toBeTruthy();

    // A well-shaped signature goes on to 1Click, which judges it: the switch is no longer what answers.
    const { POST: submit } = await route<Post>('submit');
    const signed = { standard: 'nep413', payload: { message: '{}', nonce: 'AA==', recipient: 'intents.near' }, public_key: 'ed25519:x', signature: 'ed25519:y' };
    const s = await submit(page('submit', { signed }));
    expect(s.status).not.toBe(403);
    expect(asked).toEqual(expect.arrayContaining(['/v0/quote', '/v0/generate-intent', '/v0/submit-intent']));
  });
});

describe('PAY_LIVE on', () => {
  it('gives a deposit address', async () => {
    const { lib, route } = await deployment({ live: true, forge: false });
    const usdcSol = (await lib.catalog()).chains.find((c) => c.id === 'sol')!.coins.find((c) => c.symbol === 'USDC')!.assetId;
    const { POST } = await route<Post>('quote');
    const res = await POST(page('quote', { kind: 'in', account: VAULT, from: usdcSol, usd: 10, dry: false }));
    expect(res.status).toBe(200);
    expect((await res.json()).quote.depositAddress).toBeTruthy();
  });

  it('opens Fuel only once the factory is on chain', async () => {
    const before = await deployment({ live: true, forge: false });
    expect(before.lib.forgeLive).toBe(false);
    const closed = await (await before.route<Get>('masks')).GET(page(`masks?account=${OWNER}`));
    expect(await closed.json()).toMatchObject({ open: false, masks: [] });

    const after = await deployment({ live: true, forge: true });
    expect(after.lib.forgeLive).toBe(true);
    const open = await (await after.route<Get>('masks')).GET(page(`masks?account=${OWNER}`));
    const body = await open.json();
    expect(body.open).toBe(true);
    expect(body.masks.map((m: { name: string }) => m.name)).toEqual(['kira', 'vex']);
  });
});

describe('the switch line the owner opens after a release', () => {
  it('answers straight from the address bar, with what is open and nothing else', async () => {
    for (const [o, want] of [
      [{ live: false, forge: false }, { deposits: false, fuel: false, maxUsd: 100 }],
      [{ live: true, forge: false }, { deposits: true, fuel: false, maxUsd: 100 }],
      [{ live: true, forge: true }, { deposits: true, fuel: true, maxUsd: 100 }],
      [{ live: false, forge: true }, { deposits: false, fuel: false, maxUsd: 100 }],
    ] as const) {
      const { route, asked } = await deployment(o);
      const { GET } = await route<Get>('live');
      // As a browser sends a typed address: Sec-Fetch-Site none, no Origin.
      const res = await GET(new Request(`${SITE}/api/pay/live`, { headers: { 'sec-fetch-site': 'none', 'x-real-ip': `10.3.0.${++ip}` } }));
      expect([o, res.status, await res.json()]).toEqual([o, 200, want]);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(asked).toEqual([]);
    }
  });
});
