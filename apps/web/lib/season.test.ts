// The daily round's clock against a stand-in for GitHub's API: what it reads, what it starts, and when it starts
// nothing. No network.
import { describe, expect, it } from 'vitest';
import { MIN_CRON_SECRET, SEASON_REPO, fromCron, tick, tickNeeds } from './season';

// Long enough, and plainly not a secret of anyone's.
const SECRET = 'c'.repeat(24);
const TOKEN = 'github_pat_test';
const ENV = { CRON_SECRET: SECRET, SEASON_DISPATCH_TOKEN: TOKEN };
// Mainnet's round as packages/network has it: daily at 18:00 UTC.
const ROUND = { live: true, first_minute: 1080, every_minutes: 1440 };
const AT = (h: number, m: number) => Date.UTC(2026, 10, 11, h, m);

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

/** GitHub as the tick sees it: the slot's runs, and what a start answers. */
function github(runs: Array<{ status: string; conclusion: string | null; created_at: string }>, start = 204) {
  const calls: Call[] = [];
  const answer = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/runs?')) return Response.json({ workflow_runs: runs.map((r, i) => ({ ...r, html_url: `https://github.com/${SEASON_REPO}/actions/runs/${i + 1}` })) });
    if (url.endsWith('/dispatches')) return new Response(start === 204 ? null : '{"message":"Unexpected inputs provided"}', { status: start });
    throw new TypeError(`fetch failed (not GitHub: ${url})`);
  }) as typeof fetch;
  return { calls, fetch: answer };
}

const run = (status: string, conclusion: string | null, created_at = '2026-11-11T18:04:30Z') => ({ status, conclusion, created_at });

describe('what the clock needs', () => {
  it('both variables, a secret nobody guesses, and a repository by owner/name', () => {
    expect(tickNeeds({})).toEqual(['CRON_SECRET: not set', 'SEASON_DISPATCH_TOKEN: not set']);
    expect(tickNeeds({ ...ENV, CRON_SECRET: 'short' })).toEqual([`CRON_SECRET: shorter than ${MIN_CRON_SECRET} characters`]);
    expect(tickNeeds({ ...ENV, SEASON_REPO: 'not a repo' })).toEqual(['SEASON_REPO: not owner/name']);
    expect(tickNeeds(ENV)).toEqual([]);
  });

  it('lets in only the call that carries the secret as Vercel sends it', () => {
    const call = (auth?: string) => new Request('https://maskwars.xyz/api/season/tick', auth ? { headers: { authorization: auth } } : {});
    expect(fromCron(call(`Bearer ${SECRET}`), ENV)).toBe(true);
    expect(fromCron(call(), ENV)).toBe(false);
    expect(fromCron(call(`Bearer ${SECRET}x`), ENV)).toBe(false);
    expect(fromCron(call(SECRET), ENV)).toBe(false);
    // No secret set: nobody gets in, not even with an empty bearer.
    expect(fromCron(call('Bearer '), {})).toBe(false);
  });
});

describe('a tick', () => {
  it('starts Season on the public repository at the slot that has no run, as the schedule would', async () => {
    const gh = github([]);
    const t = await tick({ env: ENV, fetch: gh.fetch, now: () => AT(18, 4), round: ROUND });
    expect(t).toEqual({ kind: 'started', slot: '2026-11-11T18:00:00Z', why: 'the slot had no run yet' });
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET https://api.github.com/repos/${SEASON_REPO}/actions/workflows/season.yml/runs?per_page=20&created=%3E%3D2026-11-11T18%3A00%3A00Z`,
      `POST https://api.github.com/repos/${SEASON_REPO}/actions/workflows/season.yml/dispatches`,
    ]);
    expect(gh.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(gh.calls[1]!.body).toEqual({ ref: 'main', inputs: { tick: 'true' } });
  });

  it('starts nothing while the slot has a run queued, running or green', async () => {
    for (const r of [run('queued', null), run('in_progress', null), run('completed', 'success')]) {
      const gh = github([r]);
      const t = await tick({ env: ENV, fetch: gh.fetch, now: () => AT(18, 14), round: ROUND });
      expect(t.kind, r.status).toBe('on');
      expect(gh.calls.filter((c) => c.method === 'POST'), r.status).toEqual([]);
    }
  });

  it('starts the slot again when its runs went red, and a run of yesterday does not count', async () => {
    const red = github([run('completed', 'failure'), run('completed', 'cancelled', '2026-11-11T18:04:10Z')]);
    expect(await tick({ env: ENV, fetch: red.fetch, now: () => AT(18, 34), round: ROUND })).toEqual({
      kind: 'started',
      slot: '2026-11-11T18:00:00Z',
      why: "the slot's last run ended failure",
    });
    const old = github([run('completed', 'success', '2026-11-10T22:54:06Z')]);
    expect((await tick({ env: ENV, fetch: old.fetch, now: () => AT(18, 4), round: ROUND })).kind).toBe('started');
  });

  it('before the slot, the slot is yesterday: its green run holds and nothing starts', async () => {
    const gh = github([run('completed', 'success', '2026-11-10T18:05:00Z')]);
    expect(await tick({ env: ENV, fetch: gh.fetch, now: () => AT(9, 0), round: ROUND })).toEqual({
      kind: 'on',
      slot: '2026-11-10T18:00:00Z',
      run: `https://github.com/${SEASON_REPO}/actions/runs/1`,
    });
  });

  it('asks nothing where the round is not live', async () => {
    const gh = github([]);
    expect(await tick({ env: ENV, fetch: gh.fetch, now: () => AT(18, 4), round: { ...ROUND, live: false } })).toEqual({
      kind: 'waiting',
      why: 'the round is not live on this network',
    });
    expect(gh.calls).toEqual([]);
  });

  it('says what GitHub answered when it refuses, so the next tick tries again', async () => {
    const gh = github([], 422);
    const t = await tick({ env: ENV, fetch: gh.fetch, now: () => AT(18, 4), round: ROUND });
    expect(t).toEqual({ kind: 'failed', why: 'GitHub answered 422 to the start: {"message":"Unexpected inputs provided"}' });
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await tick({ env: ENV, fetch: down, now: () => AT(18, 4), round: ROUND })).toEqual({ kind: 'failed', why: 'GitHub did not answer the list of runs: fetch failed' });
  });

  it('a test may point it at another repository', async () => {
    const gh = github([]);
    await tick({ env: { ...ENV, SEASON_REPO: 'someone/fork' }, fetch: gh.fetch, now: () => AT(18, 4), round: ROUND });
    expect(gh.calls[0]!.url).toContain('/repos/someone/fork/actions/workflows/season.yml/runs');
  });
});
