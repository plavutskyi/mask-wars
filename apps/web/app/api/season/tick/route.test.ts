// GET /api/season/tick as Vercel Cron calls it, and as anyone else might. GitHub is a stand-in; no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Long enough, and plainly not a secret of anyone's.
const SECRET = 'c'.repeat(24);
type Route = typeof import('./route');

async function deployment(env: Record<string, string>): Promise<{ route: Route; asked: string[] }> {
  vi.resetModules();
  for (const name of ['CRON_SECRET', 'SEASON_DISPATCH_TOKEN', 'SEASON_REPO']) vi.stubEnv(name, env[name] ?? '');
  vi.stubEnv('MASKWARS_NETWORK', 'mainnet');
  const asked: string[] = [];
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/runs?')) return Response.json({ workflow_runs: [] });
    if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
    throw new TypeError(`fetch failed (${url})`);
  }) as typeof fetch);
  return { route: await import('./route'), asked };
}

const call = (route: Route, auth?: string) => route.GET(new Request('https://maskwars.xyz/api/season/tick', auth ? { headers: { authorization: auth } } : {}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 11, 18, 4, 2) });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the site clock', () => {
  it('is closed until the owner sets the secret, and then says only which variables wait', async () => {
    const { route, asked } = await deployment({});
    const res = await call(route, 'Bearer anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ open: false, needs: ['CRON_SECRET', 'SEASON_DISPATCH_TOKEN'] });
    expect(asked).toEqual([]);
  });

  it('refuses a call without the secret before it says anything else', async () => {
    const { route, asked } = await deployment({ CRON_SECRET: SECRET });
    for (const auth of [undefined, 'Bearer wrong', SECRET]) expect((await call(route, auth)).status).toBe(401);
    expect(asked).toEqual([]);
    // The secret is right, the token is missing: the clock says what waits.
    const res = await call(route, `Bearer ${SECRET}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ open: false, needs: ['SEASON_DISPATCH_TOKEN'] });
  });

  it("Vercel's call at 18:04 starts the slot's run on mainnet", async () => {
    const { route, asked } = await deployment({ CRON_SECRET: SECRET, SEASON_DISPATCH_TOKEN: 'github_pat_test' });
    const res = await call(route, `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ kind: 'started', slot: '2026-11-11T18:00:00Z', why: 'the slot had no run yet' });
    expect(asked.map((a) => a.split(' ')[0])).toEqual(['GET', 'POST']);
  });
});
