// The masks' clock on the jobs market against a stand-in for GitHub's API and boards made here: when it starts the Jobs
// workflow, when it starts nothing, and what it asks GitHub. No network.
import { MAINNET_JOBS, type Job, type JobBoard } from '@maskwars/arena/jobs';
import { emptyJobs } from '@maskwars/arena/jobs/fixture';
import { JOBS_TICK_MINUTES, NETWORKS } from '@maskwars/network';
import { describe, expect, it } from 'vitest';
import { JOBS_WORKFLOW, jobsDue, jobsTick } from './jobs-tick';
import { SEASON_REPO } from './season';

const NET = NETWORKS.mainnet;
const NEAR = 10n ** 24n;
const NOW = Date.UTC(2026, 11 - 1, 13, 18, 12);
const MIN = 60_000;
const ENV = { CRON_SECRET: 'c'.repeat(24), SEASON_DISPATCH_TOKEN: 'github_pat_test' };
const empty = await emptyJobs('deployed', MAINNET_JOBS).board();

const member = (account: string) => ({ mask: { account, name: null, slug: null, forged: false }, role: 'striker', left: false });
/** A drain on the house's round as /jobs opens it: 1 NEAR, bonds of 0.05, four slots, working until 18:44. */
function job(change: Record<string, unknown> = {}): Job {
  return {
    id: 'race-0004-k3x9qa',
    kind: 'drain',
    client: 'alice.near',
    reward: NEAR.toString(),
    bond: (NEAR / 20n).toString(),
    phase: 'enlisting',
    room: true,
    judge: { by: 'round', bounty: NET.bounty, round: 'race-0004', state: 'open', winner: null },
    openedAt: Date.UTC(2026, 10, 13, 18, 5),
    workUntil: Date.UTC(2026, 10, 13, 18, 44),
    revealUntil: Date.UTC(2026, 10, 13, 19, 14),
    appealMinutes: 10,
    judgeUntil: Date.UTC(2026, 10, 15, 7, 12),
    entrants: [],
    steps: [],
    verdict: null,
    ...change,
  } as unknown as Job;
}
const board = (...jobs: Job[]): JobBoard => ({ ...empty, readAt: NOW, jobs });
const onIt = { entrants: [{ index: 0, members: [member(NET.masks.NOVA!), member(NET.masks.ONYX!)] }] };

describe('when the masks have something to move', () => {
  it('a person’s drain on our round that takes masks, while a step can still be sealed', () => {
    expect(jobsDue(board(job()), NOW, NET)).toBe('race-0004-k3x9qa takes masks until 18:44 UTC');
    expect(jobsDue(board(job()), Date.UTC(2026, 10, 13, 18, 43), NET)).toBeNull();
  });

  it('not a job its reward or its bond keeps from them, nor one on a round not ours or not open, nor one with no room', () => {
    expect(jobsDue(board(job({ reward: (NEAR / 5n).toString() })), NOW, NET)).toBeNull();
    expect(jobsDue(board(job({ bond: (NEAR / 5n).toString() })), NOW, NET)).toBeNull();
    expect(jobsDue(board(job({ judge: { by: 'round', bounty: 'bounty.someone.near', round: 'r', state: 'open', winner: null } })), NOW, NET)).toBeNull();
    expect(jobsDue(board(job({ judge: { by: 'round', bounty: NET.bounty, round: 'race-0004', state: 'drained', winner: null } })), NOW, NET)).toBeNull();
    expect(jobsDue(board(job({ room: false })), NOW, NET)).toBeNull();
    // Nor one with windows the masks never take a job from outside with: three days of work, a day of reveals. The
    // plan refuses it by the same bar (`outsideTermsBar`), so no run is started for it, however many anyone posts.
    const day = 24 * 60 * MIN;
    expect(jobsDue(board(job({ workUntil: Date.UTC(2026, 10, 16, 18, 5), revealUntil: Date.UTC(2026, 10, 17, 18, 5) })), NOW, NET)).toBeNull();
    expect(jobsDue(board(job({ revealUntil: Date.UTC(2026, 10, 13, 18, 44) + day })), NOW, NET)).toBeNull();
    expect(jobsDue(board(job({ appealMinutes: 24 * 60 })), NOW, NET)).toBeNull();
    // Our own job asks no limit: a small reward is the team's to set.
    expect(jobsDue(board(job({ client: NET.house, reward: (NEAR / 5n).toString() })), NOW, NET)).not.toBeNull();
  });

  it('a step of ours to seal, to reveal; a round over under a job of ours; a verdict to pay', () => {
    expect(jobsDue(board(job({ ...onIt, room: false })), NOW, NET)).toBe('race-0004-k3x9qa takes masks until 18:44 UTC');
    const step = (mask: string, revealed: boolean) => ({ seq: 0, mask: { account: mask }, role: 'striker', revealed, copyOf: null });
    expect(jobsDue(board(job({ ...onIt, phase: 'revealing', steps: [step(NET.masks.NOVA!, false)] })), NOW, NET)).toBe('the masks reveal their steps on race-0004-k3x9qa');
    expect(jobsDue(board(job({ ...onIt, phase: 'revealing', steps: [step(NET.masks.NOVA!, true)] })), NOW, NET)).toBeNull();
    const waiting = (state: string) => job({ ...onIt, phase: 'waiting', steps: [step(NET.masks.NOVA!, true)], judge: { by: 'round', bounty: NET.bounty, round: 'race-0004', state, winner: null } });
    expect(jobsDue(board(waiting('open')), NOW, NET)).toBeNull();
    expect(jobsDue(board(waiting('drained')), NOW, NET)).toBe('race-0004-k3x9qa waits for its judge');
    expect(jobsDue(board(job({ ...onIt, phase: 'decided', verdict: { final: true, appealUntil: null } })), NOW, NET)).toBe('race-0004-k3x9qa is decided: it pays');
    // Somebody else's job in those phases is not ours to move.
    expect(jobsDue(board(job({ phase: 'decided', verdict: { final: true, appealUntil: null } })), NOW, NET)).toBeNull();
  });
});

/** GitHub as the tick sees it: the workflow's runs, and what a start answers. */
function github(runs: { status: string }[], start = 204) {
  const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
  const answer = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes('/runs?')) return Response.json({ workflow_runs: runs.map((r, i) => ({ ...r, html_url: `https://github.com/${SEASON_REPO}/actions/runs/${i + 1}` })) });
    if (url.endsWith('/dispatches')) return new Response(start === 204 ? null : '{"message":"Unexpected inputs provided"}', { status: start });
    throw new TypeError(`fetch failed (not GitHub: ${url})`);
  }) as typeof fetch;
  return { calls, fetch: answer };
}

describe('a tick of the masks’ clock', () => {
  it('starts Jobs on the public repository as the schedule would, when the masks have a job to take', async () => {
    const gh = github([{ status: 'completed' }, { status: 'in_progress' }]);
    const t = await jobsTick({ net: NET, board: async () => board(job()), env: ENV, fetch: gh.fetch });
    expect(t).toEqual({ kind: 'started', why: 'race-0004-k3x9qa takes masks until 18:44 UTC' });
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET https://api.github.com/repos/${SEASON_REPO}/actions/workflows/${JOBS_WORKFLOW}/runs?per_page=20`,
      `POST https://api.github.com/repos/${SEASON_REPO}/actions/workflows/${JOBS_WORKFLOW}/dispatches`,
    ]);
    expect(gh.calls.every((c) => c.auth === `Bearer ${ENV.SEASON_DISPATCH_TOKEN}`)).toBe(true);
    expect(gh.calls[1]!.body).toEqual({ ref: 'main', inputs: { tick: 'true' } });
  });

  it('starts nothing while a run waits in the queue, nor when nothing moves, and asks GitHub nothing then', async () => {
    for (const status of ['queued', 'waiting', 'pending', 'requested']) {
      const gh = github([{ status }]);
      expect((await jobsTick({ net: NET, board: async () => board(job()), env: ENV, fetch: gh.fetch })).kind, status).toBe('on');
      expect(gh.calls.filter((c) => c.method === 'POST'), status).toEqual([]);
    }
    const quiet = github([]);
    expect(await jobsTick({ net: NET, board: async () => board(), env: ENV, fetch: quiet.fetch })).toEqual({ kind: 'waiting', why: 'nothing for the masks to move now' });
    const undeployed = await emptyJobs('undeployed', MAINNET_JOBS).board();
    expect(await jobsTick({ net: NET, board: async () => undeployed, env: ENV, fetch: quiet.fetch })).toEqual({ kind: 'waiting', why: 'the jobs contract is not on chain' });
    expect(quiet.calls).toEqual([]);
  });

  it('says what went wrong, so the next tick tries again', async () => {
    expect(await jobsTick({ net: NET, board: async () => board(job()), env: ENV, fetch: github([], 422).fetch })).toEqual({
      kind: 'failed',
      why: 'GitHub answered 422 to the start: {"message":"Unexpected inputs provided"}',
    });
    expect(
      await jobsTick({
        board: async () => {
          throw new Error('every endpoint failed');
        },
        env: ENV,
        fetch: github([]).fetch,
      }),
    ).toEqual({ kind: 'failed', why: 'the board could not be read: every endpoint failed' });
  });

  it('runs a little before every window of the house’s round: posting, the work, the reveals, the payouts', async () => {
    const { readFileSync } = await import('node:fs');
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as { crons: { path: string; schedule: string }[] };
    const minutes = vercel.crons.filter((c) => c.path === '/api/jobs-tick').map((c) => c.schedule.split(' ').slice(0, 2).map(Number)).map(([m, h]) => h! * 60 + m!);
    // Once a day each, at a fixed minute: a form every plan of Vercel takes.
    for (const c of vercel.crons.filter((c) => c.path === '/api/jobs-tick')) expect(c.schedule).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/);
    const slot = NET.round.first_minute % 1440;
    // The masks' plan counts on exactly these runs: it takes a job from outside only with two of them inside its
    // reveal window (packages/network `JOBS_TICK_MINUTES`, packages/arena `outsideTermsBar`). A minute changed here
    // and not there would have the plan count on a run that never comes.
    expect(minutes.map((m) => m - slot)).toEqual([...JOBS_TICK_MINUTES]);
    // While people post (the round opens 4 minutes after the slot, posting closes 25 minutes before its seals end),
    // every five minutes; then through the reveals and the round's end.
    const posting = minutes.filter((m) => m > slot + 4 && m <= slot + NET.round.commit_minutes - 25 + 10);
    expect(posting.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < posting.length; i++) expect(posting[i]! - posting[i - 1]!).toBeLessThanOrEqual(5);
    expect(minutes.some((m) => m > slot + NET.round.commit_minutes && m < slot + NET.round.commit_minutes + 30)).toBe(true);
    expect(Math.max(...minutes)).toBeGreaterThanOrEqual(slot + NET.round.hours * 60);
  });
});
