import { NETWORKS } from '@maskwars/network';
import { FRESH_MS, type Job, type JobBoard } from '@maskwars/arena/jobs';
import { emptyJobs, readRecording, replayJobs } from '@maskwars/arena/jobs/fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_DEFAULT, PAGE_MAX, pageOf } from '../api/jobs/paging';
import { postCalls } from './post';
import { KIND_JUDGE, KIND_LINE, KIND_WORD, boardMoving, clockTime, entrantName, eventLine, jobMoving, jobTitle, left, openWord, paidOf } from './show';
import { modeOf, waysOf } from './Ways';

// The sandbox world's board, as its chain answered: the jobs and crews contracts of this repository in a local NEAR
// sandbox, a job in every phase (packages/arena/test/fixtures/jobs-sandbox.json).
const FIXTURE = '../../packages/arena/test/fixtures/jobs-sandbox.json';
const board = await replayJobs(readRecording(new URL(`../../${FIXTURE}`, import.meta.url))).board();
const job = (id: string) => board.jobs.find((j) => j.id === id)!;

describe('how a job reads on the board and on its page', () => {
  it('titles every job by what is happening to it now', () => {
    expect(Object.fromEntries(board.jobs.map((j) => [j.id, jobTitle(j)]))).toEqual({
      'audit-0006': 'Open for masks',
      'drain-0007': 'Open for masks',
      'review-0009': 'Opening soon',
      'tests-0005': 'Masks show their work',
      'review-0010': 'The judge decides',
      'review-0004': 'TRIO won',
      'bench-0002': 'Never opened',
      'review-0003': 'Nobody won',
      'drain-0001': 'DUO got paid',
      'review-0001': 'DUO got paid',
    });
  });

  it('says who may take a job while its window is open: open, forged masks only, invite only, or full', () => {
    const audit = job('audit-0006');
    expect([openWord(audit), jobTitle(audit)]).toEqual(['Open', 'Open for masks']);
    // A job with room that only its client's listed masks may take is not open to anyone else, and says so.
    const listed: Job = { ...audit, takes: false, openTo: { who: 'masks', masks: ['nova.test.near'] } };
    expect([openWord(listed), jobTitle(listed)]).toEqual(['Invite only', 'Invite only']);
    const forged: Job = { ...audit, openTo: { who: 'registered', factories: ['masks.test.near'] } };
    expect([openWord(forged), jobTitle(forged)]).toEqual(['Open to forged masks', 'Open to forged masks']);
    const full: Job = { ...listed, room: false };
    expect([openWord(full), jobTitle(full)]).toEqual(['Full', 'Every slot is taken']);
  });

  it('names a crew by its id and a mask alone by its own name; the money paid is the settle event’s', () => {
    const paid = job('review-0001');
    expect(paid.entrants.map(entrantName)).toEqual(['DUO', 'onyx.test.near']);
    expect(paidOf(paid)).toBe(2_850_000_000_000_000_000_000_000n);
    expect(paid.settlement?.tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(paid.events.findLast((e) => e.kind === 'verdict')?.tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it('never prints a word of private work in a job’s course', () => {
    for (const j of board.jobs.filter((x) => x.private)) {
      const lines = j.events.map((e) => eventLine(e, j)).join('\n');
      expect(lines).not.toContain('mw1.');
      for (const e of j.events.filter((x) => x.kind === 'reveal')) expect(eventLine(e, j)).toMatch(/reveals its work, sealed for the judge$/);
    }
  });

  it('has a word for every kind the contract knows', () => {
    for (const k of ['drain', 'tee_tests', 'ai_review'] as const) {
      expect(KIND_WORD[k]).toBeTruthy();
      expect(KIND_LINE[k]).toMatch(/\.$/);
      expect(KIND_JUDGE[k]).toMatch(/^Judge: .* TEE$/);
    }
  });

  it('counts a window down in the fewest words', () => {
    expect(left(2 * 86_400_000 + 23 * 3_600_000 + 5)).toBe('2 d 23 h');
    expect(left(23 * 3_600_000 + 41 * 60_000 + 9_000)).toBe('23:41:09');
    expect(left(249_000)).toBe('4:09');
    expect(left(-5)).toBe('0:00');
  });
});

describe('LIVE is a real process, read just now', () => {
  // The recorded world as a real network would answer it: the same jobs, on testnet.
  const real: JobBoard = { ...board, network: 'testnet' };
  const audit = job('audit-0006');
  const moved = Math.max(...audit.events.map((e) => e.at));

  it('shows on a real network while a running job moved in the last minutes and the reading is fresh', () => {
    const now = real.readAt + 2_000;
    expect(moved).toBeGreaterThan(now - 15 * 60_000);
    expect(jobMoving(audit, real, now)).toBe(true);
    expect(boardMoving(real, now)).toBe(true);
    // A job that is over never moves, however recent its payout.
    const paid = job('review-0001');
    expect(jobMoving(paid, real, Math.max(...paid.events.map((e) => e.at)) + 1_000)).toBe(false);
  });

  it('never shows on a local chain or its recordings', () => {
    expect(board.network).toBe('sandbox');
    expect(boardMoving(board, board.readAt + 2_000)).toBe(false);
  });

  it('goes away when the last good reading is served: the chain stopped answering', () => {
    const stale: JobBoard = { ...real, stale: true };
    expect(jobMoving(audit, stale, real.readAt + 2_000)).toBe(false);
    expect(boardMoving(stale, real.readAt + 2_000)).toBe(false);
  });

  it('goes away once the block read is older than a minute and a half, by the server’s own clock', () => {
    expect(boardMoving(real, real.readAt + FRESH_MS)).toBe(true);
    expect(boardMoving(real, real.readAt + FRESH_MS + 1)).toBe(false);
    expect(jobMoving(audit, real, real.readAt + 10 * 60_000)).toBe(false);
  });

  it('counts a window down from the server’s clock to the deadline on chain, not from the time of an old block', () => {
    // What the pages pass to a countdown: the deadline less `now`. Ten minutes after the block, ten minutes less is left.
    const tests = job('tests-0005');
    const atBlock = tests.revealUntil - real.readAt;
    const later = tests.revealUntil - (real.readAt + 10 * 60_000);
    expect(atBlock - later).toBe(10 * 60_000);
    expect([left(atBlock), left(later)]).toEqual(['23:53:10', '23:43:10']);
    expect(clockTime(Date.UTC(2026, 10, 10, 12, 4, 59))).toBe('12:04 UTC');
  });
});

describe('posting a job', () => {
  it('offers the open call for every kind the contract can judge, with the contract, its judge and the quoted deposit', () => {
    const calls = postCalls(board);
    expect(calls.map((c) => [c.kind, c.word])).toEqual([
      ['drain', 'Break a contract'],
      ['tee_tests', 'Private tests'],
      ['ai_review', 'AI review'],
    ]);
    const review = calls.find((c) => c.kind === 'ai_review')!;
    const judge = board.market!.judges.find((j) => j.kind === 'ai_review')!;
    expect(review.command).toMatch(/^near contract call-function as-transaction jobs\.test\.near open json-args '\{"id":"YOUR-JOB-ID","kind":"ai_review",/);
    expect(review.command).toContain(`"judge_version":"${judge.version}"`);
    expect(review.command).toMatch(/ prepaid-gas '100 Tgas' attached-deposit '1\.64 NEAR' sign-as YOUR_ACCOUNT\.test\.near network-config sandbox sign-with-keychain send$/);
    // An argument the contract reads as "none" is left out; nothing in the call is a made-up value of the client's.
    expect(review.command).not.toContain('null');
    expect(review.deposit).toBe('1.64');
    expect(review.parts.map((x) => x.value)).toEqual(['1 NEAR', '0.2 NEAR', '0.08 NEAR', '0.36 NEAR']);
    // Every stand-in the client must replace is named in the sheet's details.
    for (const c of calls) for (const m of c.command.match(/YOUR[A-Z_-]*|SHA256_OF_[A-Z_]+|ONE LINE: WHAT TO DO|THE-ROUND-ID/g) ?? []) expect(c.fill.some((f) => f.name.includes(m)), `${c.kind}: ${m}`).toBe(true);
    const drain = calls.find((c) => c.kind === 'drain')!;
    expect(drain.command).toContain(`"round":{"bounty":"${board.market!.bounties[0]}","id":"THE-ROUND-ID"}`);
  });

  it('offers nothing while the contract is not on chain, and only what it can open right after its deployment', async () => {
    expect(postCalls(await emptyJobs('undeployed').board())).toEqual([]);
    const fresh = postCalls(await emptyJobs('deployed').board());
    expect(fresh.map((c) => c.kind)).toEqual(['drain']);
    expect(fresh[0]!.command).toContain(`near contract call-function as-transaction ${NETWORKS.testnet.jobs} open `);
    expect(fresh[0]!.command).toContain(`"bounty":"${NETWORKS.testnet.bounty}"`);
    expect(fresh[0]!.command).toMatch(/sign-as YOUR_ACCOUNT\.testnet network-config testnet /);
    // A contract with no judge that follows no round opens nothing: the board offers no way to post.
    const deployed = await emptyJobs('deployed').board();
    expect(postCalls({ ...deployed, market: { ...deployed.market!, bounties: [] } })).toEqual([]);
    expect(postCalls({ ...board, market: { ...board.market!, changing: true } })).toEqual([]);
  });
});

describe('the two ways in speak only of the kinds a job can open with now', () => {
  const lines = (kinds: Parameters<typeof modeOf>[0]) =>
    waysOf(modeOf(kinds))
      .flatMap((w) => w.stops.map((x) => x.line))
      .join('\n');

  it('a contract that opens only drains promises no TEE, no judge’s key and no delivery: its plans are public once revealed', async () => {
    const fresh = postCalls(await emptyJobs('deployed').board()).map((c) => c.kind);
    expect(fresh).toEqual(['drain']);
    const text = lines(fresh);
    expect(text).not.toMatch(/TEE|judge’s key|comes to you alone|nobody reads it but the judge|rubric|private test/);
    expect(text).toContain('Each plan is sealed while the round runs, and public once revealed.');
    expect(text).toContain('then the plan is revealed for anyone to read');
  });

  it('a contract with a judge in a TEE for a kind says its work is sealed for that judge and delivered to the client', () => {
    const text = lines(['tee_tests', 'ai_review']);
    expect(text).toContain('Their work is sealed: nobody reads it but the judge.');
    expect(text).toContain('A judge in a TEE decides, the contract pays the winner by its crew’s split, and the winning work comes to you alone.');
    expect(text).not.toMatch(/round/);
    const both = lines(postCalls(board).map((c) => c.kind));
    expect(both).toMatch(/drain’s plan is sealed while the round runs and public once revealed/);
    expect(both).toMatch(/judge in a TEE decides/);
  });

  it('a contract that can open nothing yet promises neither', () => {
    expect(lines([])).not.toMatch(/TEE|judge’s key|comes to you alone|round/);
  });
});

describe('the open API serves the board a page at a time', () => {
  const many: JobBoard = { ...board, jobs: Array.from({ length: 57 }, (_, i): Job => ({ ...board.jobs[i % board.jobs.length]!, id: `job-${String(i).padStart(4, '0')}` })) };

  it('answers the first page by default, never the whole list', () => {
    const first = pageOf(many, null, null);
    expect(first.jobs.length).toBe(PAGE_DEFAULT);
    expect(first.page).toEqual({ offset: 0, limit: PAGE_DEFAULT, shown: PAGE_DEFAULT, of: 57, next: PAGE_DEFAULT });
    // The board's own totals stay whole: they are not of the page.
    expect(first).toMatchObject({ open: board.open, waiting: board.waiting, paid: board.paid, total: board.total });
  });

  it('walks to the end by `next`, and holds `limit` to its bound', () => {
    const seen: string[] = [];
    for (let next: number | null = 0; next !== null; ) {
      const page = pageOf(many, String(next), '50');
      seen.push(...page.jobs.map((j) => j.id));
      next = page.page.next;
    }
    expect(seen).toEqual(many.jobs.map((j) => j.id));
    expect(pageOf(many, '0', '5000').page.limit).toBe(PAGE_MAX);
    expect(pageOf(many, '0', '0').page.limit).toBe(1);
    expect(pageOf(many, '50', '50').page).toEqual({ offset: 50, limit: 50, shown: 7, of: 57, next: null });
  });

  it('falls back to the first page on a query it cannot read', () => {
    for (const bad of ['-1', '1e3', 'all', '', ' 5']) expect(pageOf(many, bad, bad).page).toMatchObject({ offset: 0, limit: PAGE_DEFAULT });
    expect(pageOf(many, '9999', null).page).toMatchObject({ offset: 57, shown: 0, next: null });
  });
});

describe('the one reader of this server', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('reads the jobs contract packages/network names, with no variable set', async () => {
    const { getJobs } = await import('./reader');
    expect(getJobs().config).toMatchObject({ network: 'testnet', contract: NETWORKS.testnet.jobs, crews: NETWORKS.testnet.crews, explorer: NETWORKS.testnet.explorer });
  });

  it('shows the empty board, not deployed or deployed, and a recording, when JOBS_FIXTURE says so', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'undeployed');
    let reader = await import('./reader');
    expect(await reader.readJobs()).toMatchObject({ deployed: false, contract: NETWORKS.testnet.jobs, jobs: [] });
    vi.resetModules();
    vi.stubEnv('JOBS_FIXTURE', 'deployed');
    reader = await import('./reader');
    expect(await reader.readJobs()).toMatchObject({ deployed: true, jobs: [], open: 0 });
    vi.resetModules();
    vi.stubEnv('JOBS_FIXTURE', FIXTURE);
    reader = await import('./reader');
    expect(await reader.readJobs()).toMatchObject({ network: 'sandbox', contract: 'jobs.test.near', open: 2 });
  });

  it('never answers from a fixture in production: it asks the chain', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'deployed');
    vi.stubEnv('VERCEL_ENV', 'production');
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(String(url));
      throw new TypeError('fetch failed (no network in this test)');
    });
    try {
      const { readJobs } = await import('./reader');
      await expect(readJobs()).rejects.toThrow(/the jobs could not be read/);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.every((u) => NETWORKS.testnet.rpc.includes(u))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
