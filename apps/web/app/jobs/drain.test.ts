// Posting a drain with a wallet: the call the browser builds is the one the arena's own builder gives and the contract's
// rules take, and nothing can be posted outside the window of the house's round (18:04 to 18:24 UTC on mainnet).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MAINNET_JOBS, type OpenInput, JOB_ID, nearCliCommand, openAction, openArgs, openCost, openProblems, outsideRules, outsideTermsBar } from '@maskwars/arena/jobs';
import { emptyJobs } from '@maskwars/arena/jobs/fixture';
import { ChainReader } from '@maskwars/check';
import { NETWORKS } from '@maskwars/network';
import { describe, expect, it } from 'vitest';
import { DRAIN, RECORD_KEEPS, type DrainJob, type HouseRound, briefProblem, defaultBrief, drainArgs, drainBack, drainCall, drainCommand, drainDeposit, freshSalt, jobIdOf, leastReward, nearText, postWindow, rewardProblem, rewardYocto, specOf } from './drain';
import { drainSheet } from './post';
import { arenaRoom, fixtureRound, houseRoundOf, waitingClients } from './round';
import type { Job, JobBoard } from '@maskwars/arena/jobs';

const NEAR = 10n ** 24n;
const MAINNET = NETWORKS.mainnet;
const at = (hh: number, mm: number, day = 13) => Date.UTC(2026, 10, day, hh, mm);
const MIN = 60_000;

// The mainnet jobs contract as it stands on 12.11: on chain, no job, no judge, following the house's bounty contract.
const deployed = await emptyJobs('deployed', MAINNET_JOBS).board();
const market = deployed.market!;
const round = (id: string, sealUntil: number, now: number): HouseRound => ({ live: true, bounty: MAINNET.bounty, round: { id, sealUntil }, now });
const none = (now: number): HouseRound => ({ live: true, bounty: MAINNET.bounty, round: null, now });

describe('the call a wallet signs to open a drain', () => {
  const sheet = drainSheet(deployed, MAINNET, round('race-0004', at(18, 49), at(18, 10)), MAINNET.explorer)!;
  const brief = 'Drain the house vault in race-0004.';
  const job: DrainJob = { id: jobIdOf('race-0004', 'k3x9qa'), brief, spec: createHash('sha256').update(brief).digest('hex'), reward: NEAR, round: { bounty: MAINNET.bounty, id: 'race-0004' }, workMinutes: 34 };
  const input: OpenInput = {
    id: job.id,
    kind: 'drain',
    brief,
    spec: job.spec,
    round: job.round,
    reward: NEAR.toString(),
    fuelPerMask: DRAIN.fuelPerMask,
    slots: DRAIN.slots,
    openTo: { who: 'anyone' },
    workMinutes: 34,
    revealMinutes: DRAIN.revealMinutes,
    appealMinutes: DRAIN.appealMinutes,
  };

  it('is the arena’s own `open` for that job, and the contract’s rules take it from any account', () => {
    expect(drainArgs(job)).toEqual(openArgs(input, market, 'alice.near'));
    expect(Object.keys(drainArgs(job))).toEqual(Object.keys(openArgs(input, market, 'alice.near')));
    expect(openProblems(input, market, 'alice.near')).toEqual([]);
    expect(drainArgs(job)).toMatchObject({
      id: 'race-0004-k3x9qa',
      kind: 'drain',
      round: { bounty: 'bounty.maskwars.near', id: 'race-0004' },
      reward: '1000000000000000000000000',
      fuel_per_mask: '50000000000000000000000',
      slots: 4,
      open_to: { who: 'anyone' },
      work_minutes: 34,
      reveal_minutes: 30,
      appeal_minutes: 10,
      judge_version: null,
      secrets: null,
      bar: null,
      client_key: null,
    });
  });

  it('attaches what the contract’s quote asks: 1.64 NEAR for a reward of 1 NEAR, as the sheet always said', () => {
    const action = openAction(MAINNET.jobs, 'alice.near', input, market);
    const call = drainCall(job, sheet.costs);
    expect(call).toEqual({ type: 'FunctionCall', params: { methodName: 'open', args: action.args, gas: action.gas, deposit: action.deposit } });
    expect(nearText(call.params.deposit)).toBe('1.64');
    expect(drainDeposit(5n * NEAR, sheet.costs)).toBe(BigInt(openCost((5n * NEAR).toString(), DRAIN.fuelPerMask, DRAIN.slots, market.judgeFee).total));
  });

  it('gives an agent the same call for the NEAR CLI, the arguments the contract reads as none left out', () => {
    const action = openAction(MAINNET.jobs, 'alice.near', input, market);
    const compact = Object.fromEntries(Object.entries(action.args).filter(([, v]) => v !== null));
    expect(drainCommand('mainnet', MAINNET.jobs, 'alice.near', job, sheet.costs)).toBe(nearCliCommand('mainnet', { ...action, args: compact }));
    expect(drainCommand('mainnet', MAINNET.jobs, 'alice.near', job, sheet.costs)).toMatch(/ attached-deposit '1\.64 NEAR' sign-as alice\.near network-config mainnet sign-with-keychain send$/);
  });

  it('takes the spec as the sha256 of the line, the way the browser computes it', async () => {
    expect(await specOf(brief)).toBe(job.spec);
    expect(await specOf('Ünïcode, ✓')).toBe(createHash('sha256').update('Ünïcode, ✓', 'utf8').digest('hex'));
  });

  it('names a new job by its round and six letters of its own, as the contract takes ids', () => {
    expect(jobIdOf('race-0004', 'K3-X9qa!')).toBe('race-0004-k3x9qa');
    expect(jobIdOf('r'.repeat(64), 'abcdef')).toHaveLength(64);
    for (let i = 0; i < 50; i++) expect(jobIdOf('race-0004', freshSalt())).toMatch(JOB_ID);
    expect(new Set(Array.from({ length: 200 }, freshSalt)).size).toBe(200);
  });
});

describe('what the person types', () => {
  it('reads a reward as NEAR, exactly', () => {
    expect(rewardYocto('1')).toBe(NEAR);
    expect(rewardYocto(' 2.5 ')).toBe(25n * 10n ** 23n);
    expect(rewardYocto('0,75')).toBe(75n * 10n ** 22n);
    expect(rewardYocto('.5')).toBe(5n * 10n ** 23n);
    expect(rewardYocto('3.')).toBe(3n * NEAR);
    expect(rewardYocto('0.000001')).toBe(10n ** 18n);
    for (const bad of ['', '.', 'abc', '1e3', '-1', '1.2.3', '0.0000001', '12345678']) expect(rewardYocto(bad), bad).toBeNull();
  });

  it('asks for a reward that covers the fuel of four masks, 0.2 NEAR, and the contract’s least', () => {
    expect(leastReward()).toBe(2n * 10n ** 23n);
    expect(openProblems({ ...baseInput(), reward: (2n * 10n ** 23n - 1n).toString() }, market, 'alice.near')).toContain('fuel for all the slots is at most the reward');
    expect(openProblems({ ...baseInput(), reward: (2n * 10n ** 23n).toString() }, market, 'alice.near')).toEqual([]);
    expect(rewardProblem('0.2')).toBeNull();
    expect(rewardProblem('0.19')).toMatch(/at least 0\.2 NEAR/);
    expect(rewardProblem('lots')).toMatch(/amount of NEAR/);
  });

  it('on the sheet, asks the least the arena’s masks take a job from outside for: 0.5 NEAR on mainnet', () => {
    const sheet = drainSheet(deployed, MAINNET, none(at(10, 0)), MAINNET.explorer)!;
    expect(nearText(sheet.minReward)).toBe('0.5');
    expect(leastReward(sheet.minReward)).toBe(5n * 10n ** 23n);
    expect(rewardProblem('0.49', sheet.minReward)).toBe('The reward is at least 0.5 NEAR: the arena’s masks take a job from that.');
    expect(rewardProblem('0.5', sheet.minReward)).toBeNull();
  });

  it('says what comes back after the round: all of the 0.64 beside the reward but the job’s record, at most 0.02', () => {
    const sheet = drainSheet(deployed, MAINNET, none(at(10, 0)), MAINNET.explorer)!;
    expect(nearText(drainBack(sheet.costs))).toBe('0.62');
    expect(nearText(RECORD_KEEPS)).toBe('0.02');
    // The masks' bonds are MASK WARS's own: three, of the fuel of one mask each, the person locks none of them.
    expect(sheet.arena).toEqual({ masks: ['NOVA', 'ONYX', 'ORACLE'], bond: DRAIN.fuelPerMask });
    expect(drainCall({ id: 'x', brief: 'x', spec: 'a'.repeat(64), reward: NEAR, round: { bounty: MAINNET.bounty, id: 'race-0004' }, workMinutes: 34 }, sheet.costs).params.deposit).toBe(drainDeposit(NEAR, sheet.costs).toString());
  });

  it('takes one line of 1 to 280 bytes, as the contract does', () => {
    expect(briefProblem(defaultBrief('race-0004'))).toBeNull();
    expect(briefProblem('   ')).toMatch(/one line/);
    expect(briefProblem('x'.repeat(280))).toBeNull();
    expect(briefProblem('x'.repeat(281))).toMatch(/280 bytes/);
    // Bytes, not letters: 94 of these are 282 bytes.
    expect(briefProblem('✓'.repeat(94))).toMatch(/282/);
  });
});

function baseInput(): OpenInput {
  return { id: 'race-0004-abcdef', kind: 'drain', brief: 'x', spec: 'a'.repeat(64), round: { bounty: MAINNET.bounty, id: 'race-0004' }, reward: NEAR.toString(), fuelPerMask: DRAIN.fuelPerMask, slots: DRAIN.slots, openTo: { who: 'anyone' }, workMinutes: 34, revealMinutes: 30, appealMinutes: 10 };
}

describe('the window: a job opens only while the house’s round seals, with time for the masks to take it', () => {
  const S = MAINNET.round;

  it('is open from the round’s opening until 25 minutes before its seals end, with a work window of at most 40 minutes', () => {
    const r = (now: number) => postWindow(round('race-0004', at(18, 49), now), now, S);
    expect(r(at(18, 4))).toEqual({ state: 'open', round: 'race-0004', bounty: 'bounty.maskwars.near', closesAt: at(18, 24), workMinutes: 40 });
    expect(r(at(18, 10))).toMatchObject({ state: 'open', workMinutes: 34 });
    expect(r(at(18, 24))).toMatchObject({ state: 'open', closesAt: at(18, 24), workMinutes: 20 });
    // The work window ends 5 minutes before the seals: the crew enlists while every mask may still seal in the round.
    const open = r(at(18, 20));
    expect(open.state === 'open' && at(18, 20) + open.workMinutes * MIN).toBe(at(18, 44));
  });

  it('is closed outside it and says when the next one opens: today’s at 18:04 UTC, or tomorrow’s', () => {
    expect(postWindow(none(at(10, 0)), at(10, 0), S)).toEqual({ state: 'closed', opensAt: at(18, 4) });
    expect(postWindow(none(at(18, 2)), at(18, 2), S)).toEqual({ state: 'closed', opensAt: at(18, 4) });
    // Too late today: the round seals for less than 25 minutes more.
    expect(postWindow(round('race-0004', at(18, 49), at(18, 25)), at(18, 25), S)).toEqual({ state: 'closed', opensAt: at(18, 4, 14) });
    expect(postWindow(round('race-0004', at(18, 49), at(20, 0)), at(20, 0), S)).toEqual({ state: 'closed', opensAt: at(18, 4, 14) });
    // Yesterday's round still racing in the morning is not a window.
    expect(postWindow(round('race-0003', at(18, 49, 12), at(9, 0)), at(9, 0), S)).toEqual({ state: 'closed', opensAt: at(18, 4) });
  });

  it('says the round is opening while it is due and not on chain yet, and not after posting would have closed', () => {
    expect(postWindow(none(at(18, 5)), at(18, 5), S)).toEqual({ state: 'opening', opensAt: at(18, 4) });
    expect(postWindow(round('race-0003', at(18, 49, 12), at(18, 6)), at(18, 6), S)).toEqual({ state: 'opening', opensAt: at(18, 4) });
    expect(postWindow(none(at(18, 24)), at(18, 24), S)).toEqual({ state: 'closed', opensAt: at(18, 4, 14) });
  });

  it('follows the chain when the house opens late: a round sealing at 18:40 is open until 19:00', () => {
    expect(postWindow(round('race-0004', at(19, 25), at(18, 41)), at(18, 41), S)).toMatchObject({ state: 'open', closesAt: at(19, 0), workMinutes: 39 });
  });

  it('is booked while the round takes no more jobs from outside: the next window is tomorrow’s', () => {
    const full = { ...round('race-0004', at(18, 49), at(18, 10)), arena: { left: 0, full: [] } };
    expect(postWindow(full, at(18, 10), S)).toEqual({ state: 'booked', round: 'race-0004', opensAt: at(18, 4, 14) });
    expect(postWindow({ ...full, arena: { left: 1, full: [] } }, at(18, 10), S)).toMatchObject({ state: 'open' });
    // Room not known: the sheet posts, and the masks' pass decides.
    expect(postWindow({ ...full, arena: null }, at(18, 10), S)).toMatchObject({ state: 'open' });
  });

  it('has no window where the house’s round does not run on schedule', () => {
    expect(postWindow({ ...none(at(18, 10)), live: false }, at(18, 10), S)).toEqual({ state: 'off' });
  });

  it('opens with the site’s clock: its first tick is the slot and the delay, and posting fits inside the seals', () => {
    const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as { crons: { path: string; schedule: string }[] };
    const [minute, hour] = vercel.crons.find((c) => c.path === '/api/season/tick')!.schedule.split(' ').map(Number);
    expect(hour! * 60 + minute!).toBe((S.first_minute % 1440) + DRAIN.openDelayMinutes);
    expect(DRAIN.leadMinutes).toBeLessThan(S.commit_minutes);
    expect(DRAIN.marginMinutes).toBeLessThan(DRAIN.leadMinutes);
  });
});

describe('the sheet the board hands the browser', () => {
  it('posts with a wallet on mainnet, where the contract follows the house’s bounty contract and the house’s round runs', () => {
    const sheet = drainSheet(deployed, MAINNET, none(at(10, 0)), MAINNET.explorer);
    expect(sheet).toMatchObject({ network: 'mainnet', contract: 'jobs.maskwars.near', bounty: 'bounty.maskwars.near', explorer: 'https://nearblocks.io', feeBps: 500 });
    expect(sheet!.schedule).toEqual({ first_minute: 1080, every_minutes: 1440, commit_minutes: 45 });
    // What a job locks beside its reward: 0.2 fuel, 0.08 for the judge's runs, 0.36 of storage at most.
    expect([sheet!.costs.fuel, sheet!.costs.judge, sheet!.costs.storage].map(nearText)).toEqual(['0.2', '0.08', '0.36']);
  });

  it('is none where the house’s round does not run, the contract follows another bounty contract, or opens nothing', async () => {
    const testnet = await emptyJobs('deployed').board();
    expect(NETWORKS.testnet.round.live).toBe(false);
    expect(drainSheet(testnet, NETWORKS.testnet, null, null)).toBeNull();
    expect(drainSheet({ ...deployed, market: { ...market, bounties: ['bounty.someone.near'] } }, MAINNET, null, null)).toBeNull();
    expect(drainSheet({ ...deployed, market: { ...market, changing: true } }, MAINNET, null, null)).toBeNull();
    expect(drainSheet(await emptyJobs('undeployed', MAINNET_JOBS).board(), MAINNET, null, null)).toBeNull();
    // A round the chain did not give now: the sheet reads it again when it opens.
    expect(drainSheet(deployed, MAINNET, null, null)?.house).toBeNull();
  });
});

describe('the house’s round, read from the chain', () => {
  /** A chain whose vault names `id` on the house's bounty contract, in `state`, sealing until `sealUntil`. */
  function chain(lock: unknown, state = 'open', sealUntil = at(18, 49), owners: Record<string, string> = {}) {
    const views: string[] = [];
    const fetch = (async (_: unknown, init?: RequestInit) => {
      const { params } = JSON.parse(String(init?.body)) as { params: { account_id: string; method_name: string; args_base64: string } };
      views.push(`${params.account_id}.${params.method_name}`);
      const answer = (v: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result: { result: [...Buffer.from(JSON.stringify(v))], logs: [], block_height: 1, block_hash: 'h' } });
      if (params.account_id === MAINNET.vault && params.method_name === 'get_round') {
        if (lock === undefined) return Response.json({ jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} }, code: -32000, message: 'Server error', data: `account ${MAINNET.vault} does not exist while viewing` } });
        return answer(lock);
      }
      const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString()) as { id: string };
      if (params.method_name === 'get') return answer({ owner: owners[args.id] ?? MAINNET.house, status: { state }, id: args.id });
      if (params.method_name === 'get_round') return answer({ commit_until: `${BigInt(sealUntil) * 1_000_000n}`, seals: [] });
      throw new Error(`unexpected ${params.method_name}`);
    }) as typeof globalThis.fetch;
    return { rpc: new ChainReader({ endpoints: ['https://rpc.test'], fetch }), views };
  }

  it('is the round the vault names, while it is open, with the end of its seal window', async () => {
    const { rpc, views } = chain({ arbiter: MAINNET.bounty, bounty: 'race-0004' });
    expect(await houseRoundOf(MAINNET, rpc, at(18, 10))).toEqual({ live: true, bounty: MAINNET.bounty, round: { id: 'race-0004', sealUntil: at(18, 49) }, now: at(18, 10) });
    expect(views.sort()).toEqual([`${MAINNET.bounty}.get`, `${MAINNET.bounty}.get_round`, `${MAINNET.vault}.get_round`]);
  });

  it('is no round between two rounds, for a round that is over, or one on another contract', async () => {
    expect((await houseRoundOf(MAINNET, chain(undefined).rpc, at(10, 0))).round).toBeNull();
    expect((await houseRoundOf(MAINNET, chain(null).rpc, at(10, 0))).round).toBeNull();
    expect((await houseRoundOf(MAINNET, chain({ arbiter: MAINNET.bounty, bounty: 'race-0003' }, 'drained').rpc, at(10, 0))).round).toBeNull();
    expect((await houseRoundOf(MAINNET, chain({ arbiter: 'bounty.someone.near', bounty: 'race-0004' }).rpc, at(18, 10))).round).toBeNull();
  });

  it('reads nothing where the house’s round does not run on schedule', async () => {
    const { rpc, views } = chain({ arbiter: NETWORKS.testnet.bounty, bounty: 'race-0004' });
    expect(await houseRoundOf(NETWORKS.testnet, rpc, at(18, 10))).toEqual({ live: false, bounty: NETWORKS.testnet.bounty, round: null, now: at(18, 10) });
    expect(views).toEqual([]);
  });

  it('with the board, gives the arena’s room on the round too; a room it cannot read leaves the round as it is', async () => {
    const lock = { arbiter: MAINNET.bounty, bounty: 'race-0004' };
    const { rpc } = chain(lock);
    // This chain answers no account: the house's balance is not known, and the room counts only the limits.
    const r = await houseRoundOf(MAINNET, rpc, at(18, 10), async () => ({ ...deployed, readAt: at(18, 10) }));
    expect(r.round).toEqual({ id: 'race-0004', sealUntil: at(18, 49) });
    expect(r.arena).toEqual({ left: 2, full: [] });
    // MASK CHECK's word on the clients waiting ahead: a blocked one's job holds no place.
    const posted = (id: string, client: string, round = 'race-0004') =>
      ({ id, kind: 'drain', client, reward: NEAR.toString(), bond: DRAIN.fuelPerMask, phase: 'enlisting', room: true, judge: { by: 'round', bounty: MAINNET.bounty, round, state: 'open', winner: null }, openedAt: at(18, 5), workUntil: at(18, 44), revealUntil: at(19, 14), appealMinutes: 10, entrants: [], steps: [], bonds: [] }) as unknown as Job;
    const waiting = { ...deployed, readAt: at(18, 10), jobs: ['bad1.near', 'bad2.near'].map((c, i) => posted(`race-0004-bad00${i}`, c)) };
    const asked: string[] = [];
    const checked = await houseRoundOf(MAINNET, chain(lock).rpc, at(18, 10), async () => waiting, async (a) => (asked.push(a), 'block'));
    expect(checked.arena).toEqual({ left: 2, full: [] });
    expect(asked).toEqual(['bad1.near', 'bad2.near']);
    expect((await houseRoundOf(MAINNET, chain(lock).rpc, at(18, 10), async () => waiting)).arena).toEqual({ left: 0, full: ['bad1.near', 'bad2.near'] });
    const broken = await houseRoundOf(MAINNET, chain(lock).rpc, at(18, 10), async () => {
      throw new Error('every endpoint failed');
    });
    expect(broken).toMatchObject({ round: { id: 'race-0004' }, arena: null });

    // Jobs that wait on another round take a place of each mask only when that round is ours: the chain says who
    // opened it. Two on a round somebody else opened book nothing; two on a round of the admin's hand do.
    const elsewhere = { ...deployed, readAt: at(18, 10), jobs: [posted('hand-0009-aaa001', 'ann.near', 'hand-0009'), posted('hand-0009-bbb001', 'bob.near', 'hand-0009')] };
    const theirs = chain(lock, 'open', at(18, 49), { 'hand-0009': 'attacker.near' });
    expect((await houseRoundOf(MAINNET, theirs.rpc, at(18, 10), async () => elsewhere)).arena).toEqual({ left: 2, full: [] });
    expect(theirs.views).toContain(`${MAINNET.bounty}.get`);
    const handRound = chain(lock, 'open', at(18, 49), { 'hand-0009': MAINNET.admin });
    expect((await houseRoundOf(MAINNET, handRound.rpc, at(18, 10), async () => elsewhere)).arena).toEqual({ left: 0, full: ['ann.near', 'bob.near'] });

    // A round the house opened so late that no two runs of the site's clock fall inside a posted job's reveal window:
    // the masks would not take a job posted now, so the page offers none.
    const night = chain(lock, 'open', at(3, 45));
    expect((await houseRoundOf(MAINNET, night.rpc, at(3, 10), async () => ({ ...deployed, readAt: at(3, 10) }))).arena).toEqual({ left: 0, full: [] });
  });

  it('has fixtures for local checks: a round open to posting, one booked, one too late, none', () => {
    const now = at(12, 0);
    expect(postWindow(fixtureRound('open', now, MAINNET), now, MAINNET.round).state).toBe('open');
    expect(postWindow(fixtureRound('booked', now, MAINNET), now, MAINNET.round).state).toBe('booked');
    expect(postWindow(fixtureRound('late', now, MAINNET), now, MAINNET.round).state).toBe('closed');
    expect(postWindow(fixtureRound('closed', now, MAINNET), now, MAINNET.round)).toEqual({ state: 'closed', opensAt: at(18, 4) });
  });
});

describe('the arena’s room for jobs from outside on the round', () => {
  const NOW = at(18, 12);
  const R = { id: 'race-0004', bounty: MAINNET.bounty };
  const seat = (account: string) => ({ mask: { account }, role: 'striker', left: false });
  const crew = { entrants: [{ index: 0, members: Object.values(MAINNET.masks).map(seat) }] };
  /** A drain on the house's round as /jobs opens it, from `client`. */
  function job(id: string, client: string, change: Record<string, unknown> = {}): Job {
    return {
      id,
      kind: 'drain',
      client,
      reward: NEAR.toString(),
      bond: DRAIN.fuelPerMask,
      phase: 'enlisting',
      room: true,
      judge: { by: 'round', bounty: MAINNET.bounty, round: 'race-0004', state: 'open', winner: null },
      openedAt: at(18, 5),
      workUntil: at(18, 44),
      revealUntil: at(19, 14),
      appealMinutes: DRAIN.appealMinutes,
      entrants: [],
      steps: [],
      bonds: [],
      ...change,
    } as unknown as Job;
  }
  const on = (...jobs: Job[]): JobBoard => ({ ...deployed, readAt: NOW, jobs });
  const NEAR_ = NEAR;

  it('two a round: the jobs the masks are on and the ones posted first that they will take count', () => {
    expect(arenaRoom(on(), R, MAINNET, null)).toEqual({ left: 2, full: [] });
    expect(arenaRoom(on(job('a', 'ivy.near', crew)), R, MAINNET, null)).toEqual({ left: 1, full: ['ivy.near'] });
    expect(arenaRoom(on(job('a', 'ivy.near', crew), job('b', 'erin.near')), R, MAINNET, null)).toEqual({ left: 0, full: ['erin.near', 'ivy.near'] });
  });

  it('not a job the masks will not take: a small reward, a big bond, no room, a closed window, our own, another round', () => {
    const skipped = [
      job('small', 'dana.near', { reward: (NEAR_ / 5n).toString() }),
      job('dear', 'dana.near', { bond: (NEAR_ / 5n).toString() }),
      job('full', 'dana.near', { room: false }),
      job('late', 'dana.near', { workUntil: at(18, 13) }),
      job('ours', MAINNET.house),
      job('other', 'dana.near', { judge: { by: 'round', bounty: MAINNET.bounty, round: 'race-0003', state: 'open', winner: null } }),
    ];
    // The one on another round takes a place of each mask, not of this round, and only when that round is ours.
    expect(arenaRoom(on(...skipped), R, MAINNET, null, new Set(), new Set([`${MAINNET.bounty}/race-0003`]))).toEqual({ left: 1, full: ['dana.near'] });
    expect(arenaRoom(on(...skipped), R, MAINNET, null)).toEqual({ left: 2, full: [] });
    expect(arenaRoom(on(...skipped.slice(0, 5)), R, MAINNET, null)).toEqual({ left: 2, full: [] });
  });

  // The page showed "Booked" to everyone for two cheap jobs nobody would ever take: any reward from 0.5 NEAR and bond
  // up to 0.1 counted, whatever the windows and whatever the round. Now only what the plan itself would take counts.
  it('no room is taken by a job the plan refuses: windows of days, a reveal no run of ours reaches, a round that is not ours', () => {
    const rules = outsideRules(MAINNET);
    const days = (id: string, change: Record<string, unknown> = {}) => job(id, `${id}.near`, { workUntil: at(18, 5) + 3 * 24 * 60 * MIN, revealUntil: at(18, 5) + 4 * 24 * 60 * MIN, ...change });
    // Three days of work, a day of reveals: the contract takes it, the masks never do.
    expect(outsideTermsBar(days('junk1'), rules)).toMatch(/^a job from outside with a work window of 4320 min/);
    expect(arenaRoom(on(days('junk1'), days('junk2')), R, MAINNET, null)).toEqual({ left: 2, full: [] });
    // The same two on another round, as the finding had them: they took both places of every mask.
    const other = { judge: { by: 'round', bounty: MAINNET.bounty, round: 'race-0003', state: 'open', winner: null } };
    expect(arenaRoom(on(days('junk1', other), days('junk2', other)), R, MAINNET, null, new Set(), new Set([`${MAINNET.bounty}/race-0003`]))).toEqual({ left: 2, full: [] });
    // A day of reveals, a day of appeal, a reveal no run of ours falls in: each refused by the plan, none takes a place.
    const refused = [
      job('reveal', 'r.near', { revealUntil: at(18, 44) + 24 * 60 * MIN }),
      job('appeal', 'a.near', { appealMinutes: 24 * 60 }),
      // Reveals from 20:40 to 21:10: the site's clock runs at 20:29 and 21:29, never in between.
      job('unseen', 'n.near', { openedAt: at(20, 0), workUntil: at(20, 40), revealUntil: at(21, 10) }),
    ];
    for (const j of refused) expect(outsideTermsBar(j, rules), j.id).not.toBeNull();
    expect(arenaRoom(on(...refused), R, MAINNET, null)).toEqual({ left: 2, full: [] });
    // Jobs with good terms on a round that is not ours to play take no place either, however many.
    const strangers = ['s1', 's2', 's3'].map((id) => job(id, `${id}.near`, { judge: { by: 'round', bounty: MAINNET.bounty, round: 'their-0001', state: 'open', winner: null } }));
    expect(arenaRoom(on(...strangers), R, MAINNET, null)).toEqual({ left: 2, full: [] });
    // What the plan would take still counts, as before.
    expect(outsideTermsBar(job('a', 'ivy.near'), rules)).toBeNull();
    expect(arenaRoom(on(job('a', 'ivy.near'), days('junk1'), days('junk2')), R, MAINNET, null)).toEqual({ left: 1, full: ['ivy.near'] });
  });

  it('a job the house’s bonds wait on holds its place, whoever took its slots', () => {
    // Full of somebody else's masks, with the house's bonds still waiting for ours: the plan counts it until they are back.
    const bonds = Object.values(MAINNET.masks).map((mask) => ({ mask, by: MAINNET.house, amount: DRAIN.fuelPerMask }));
    const taken = job('a', 'ivy.near', { room: false, bonds });
    expect(arenaRoom(on(taken), R, MAINNET, null)).toEqual({ left: 1, full: ['ivy.near'] });
    // A bond somebody else locked for our masks is not one they take: it holds nothing.
    const foreign = job('b', 'erin.near', { room: false, bonds: bonds.map((b) => ({ ...b, by: 'erin.near' })) });
    expect(arenaRoom(on(foreign), R, MAINNET, null)).toEqual({ left: 2, full: [] });
  });

  it('a job posted on the page always clears the plan’s bar, and the page offers none when it would not', () => {
    const rules = outsideRules(MAINNET);
    const lim = MAINNET.limits.jobs;
    // The sheet's own windows fit the limits: 40 minutes of work at most, 30 of reveals, 10 of appeal.
    expect(DRAIN.maxWorkMinutes).toBeLessThanOrEqual(lim.max_work_minutes);
    expect(DRAIN.revealMinutes).toBeGreaterThanOrEqual(30);
    expect(DRAIN.revealMinutes).toBeLessThanOrEqual(lim.max_reveal_minutes);
    expect(DRAIN.appealMinutes).toBeLessThanOrEqual(lim.max_appeal_minutes);
    expect(BigInt(DRAIN.fuelPerMask)).toBeLessThanOrEqual(rules.maxBond);
    // Whenever the page says a job can be posted on the round of the day, the masks take a job posted then.
    for (let open = at(18, 4); open < at(18, 9); open += 30_000) {
      const sealUntil = open + MAINNET.round.commit_minutes * MIN;
      for (let now = open; now <= sealUntil; now += MIN) {
        const w = postWindow(round('race-0004', sealUntil, now), now, MAINNET.round);
        if (w.state !== 'open') continue;
        const posted = { reward: rules.minReward.toString(), bond: DRAIN.fuelPerMask, openedAt: now, workUntil: now + w.workMinutes * MIN, revealUntil: now + (w.workMinutes + DRAIN.revealMinutes) * MIN, appealMinutes: DRAIN.appealMinutes };
        expect(outsideTermsBar(posted, rules), new Date(now).toISOString()).toBeNull();
        expect(arenaRoom({ ...deployed, readAt: now, jobs: [] }, { ...R, sealUntil }, MAINNET, null).left).toBe(2);
      }
    }
    // A round sealing at an hour the site's clock does not run through: nothing is offered, though the round has room.
    expect(arenaRoom({ ...deployed, readAt: at(3, 10), jobs: [] }, { ...R, sealUntil: at(3, 45) }, MAINNET, null)).toEqual({ left: 0, full: [] });
    expect(arenaRoom({ ...deployed, readAt: at(3, 10), jobs: [] }, R, MAINNET, null)).toEqual({ left: 2, full: [] });
    expect(postWindow({ ...round('race-0004', at(3, 45), at(3, 10)), arena: { left: 0, full: [] } }, at(3, 10), MAINNET.round).state).toBe('booked');
  });

  it('two places of each mask: jobs it holds on other rounds count, so our own jobs always keep the rest', () => {
    const yesterday = (id: string) => job(id, `${id}.near`, { ...crew, phase: 'waiting', judge: { by: 'round', bounty: MAINNET.bounty, round: 'race-0003', state: 'open', winner: null } });
    expect(arenaRoom(on(yesterday('y1')), R, MAINNET, null).left).toBe(1);
    expect(arenaRoom(on(yesterday('y1'), yesterday('y2')), R, MAINNET, null).left).toBe(0);
  });

  it('only from what the house holds beyond its next round: 0.503 NEAR, and 0.172 a job with its gas', () => {
    const keeps = 503n * 10n ** 21n;
    const perJob = 172n * 10n ** 21n;
    expect(arenaRoom(on(), R, MAINNET, keeps + perJob - 1n).left).toBe(0);
    expect(arenaRoom(on(), R, MAINNET, keeps + perJob).left).toBe(1);
    expect(arenaRoom(on(), R, MAINNET, keeps + 5n * perJob).left).toBe(2);
    // A job posted before takes its share of the house first.
    expect(arenaRoom(on(job('a', 'ivy.near')), R, MAINNET, keeps + perJob).left).toBe(0);
  });

  it('a job of a client MASK CHECK blocks holds no place: the masks never take it', async () => {
    const two = on(job('a', 'mallory.near'), job('b', 'mallory2.near'));
    expect(arenaRoom(two, R, MAINNET, null).left).toBe(0);
    expect(arenaRoom(two, R, MAINNET, null, new Set(['mallory.near', 'mallory2.near']))).toEqual({ left: 2, full: [] });
    expect(waitingClients(two, MAINNET)).toEqual(['mallory.near', 'mallory2.near']);
  });
});
