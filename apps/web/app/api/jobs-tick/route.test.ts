// GET /api/jobs-tick as Vercel Cron calls it, and as anyone else might. GitHub is a stand-in; the board is an empty one
// of mainnet's (JOBS_FIXTURE), so nothing reads the network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'c'.repeat(24);
type Route = typeof import('./route');

async function deployment(env: Record<string, string>): Promise<{ route: Route; asked: string[] }> {
  vi.resetModules();
  for (const name of ['CRON_SECRET', 'SEASON_DISPATCH_TOKEN', 'SEASON_REPO']) vi.stubEnv(name, env[name] ?? '');
  vi.stubEnv('MASKWARS_NETWORK', 'mainnet');
  vi.stubEnv('JOBS_FIXTURE', 'deployed');
  const asked: string[] = [];
  vi.stubGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    throw new TypeError(`fetch failed (${url})`);
  }) as typeof fetch);
  return { route: await import('./route'), asked };
}

const call = (route: Route, auth?: string) => route.GET(new Request('https://maskwars.xyz/api/jobs-tick', auth ? { headers: { authorization: auth } } : {}));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the masks’ clock', () => {
  it('is closed until the owner sets the secret, and lets in only the call that carries it', async () => {
    const closed = await deployment({});
    const res = await call(closed.route, 'Bearer anything');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ open: false, needs: ['CRON_SECRET', 'SEASON_DISPATCH_TOKEN'] });
    const { route, asked } = await deployment({ CRON_SECRET: SECRET, SEASON_DISPATCH_TOKEN: 'github_pat_test' });
    for (const auth of [undefined, 'Bearer wrong', SECRET]) expect((await call(route, auth)).status).toBe(401);
    expect(asked).toEqual([]);
  });

  it('reads the board and, with nothing for the masks to move, asks GitHub nothing', async () => {
    const { route, asked } = await deployment({ CRON_SECRET: SECRET, SEASON_DISPATCH_TOKEN: 'github_pat_test' });
    const res = await call(route, `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ kind: 'waiting', why: 'nothing for the masks to move now' });
    expect(asked).toEqual([]);
  });
});
