// The server side of the picks: signed cookies, the record kept once per round, the table folded from it.
import type { Race, Who } from '@maskwars/arena';
import { beforeEach, describe, expect, it } from 'vitest';
import { HELD, raceKey, withPick } from './pick';
import { entriesCookie, entriesOf, filePick, forget, linkDevice, memoryPicks, newDevice, readBoard, ROOT, seal, settle, unseal, whoOf } from './picks';
import { readShare, shareToken } from './share';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 18, 4);
const who = (name: string): Who => ({ account: `${name.toLowerCase()}.maskwars.near`, slug: name.toLowerCase(), name, mask: true, model: null });
const ORACLE = who('ORACLE');
const NOVA = who('NOVA');

function race(id: string, at: number, end: Partial<Race>): Race {
  return {
    id,
    network: 'testnet',
    contract: 'bounty.maskwars.near',
    season: null,
    kind: 'safe',
    phase: 'broken',
    live: false,
    state: 'paid',
    team: 'house.maskwars.near',
    official: true,
    target: 'vault.house.maskwars.near',
    targetCode: null,
    locked: '1',
    bounty: '1',
    inSafe: null,
    safeFunded: '1',
    minLoot: '1',
    openedAt: at,
    startsAt: at + 45 * MIN,
    deadline: at + 240 * MIN,
    sealUntil: at + 45 * MIN,
    revealUntil: at + 105 * MIN,
    masks: [NOVA, ORACLE],
    winner: ORACLE,
    brokeAt: at + 60 * MIN,
    breakMs: 15 * MIN,
    loot: '1',
    payout: null,
    refund: null,
    takes: '1',
    prize: '1',
    events: [],
    txs: { open: null, drain: null, payout: null },
    judge: null,
    runId: null,
    ...end,
  };
}

beforeEach(() => forget());

describe('cookies: signed here, read only when this server signed them', () => {
  it('a person and their picks round-trip; anything edited is nobody', () => {
    const d = newDevice();
    expect(whoOf(seal(d))).toBe(d);
    expect(whoOf(`${d}.forged`)).toBeNull();
    expect(whoOf(seal('aalice.near').replace('alice', 'mallo'))).toBeNull();
    const entries = withPick([], { key: 't.1794335495048', choice: HELD, at: 1 });
    const c = entriesCookie(entries);
    expect(entriesOf(c)).toEqual(entries);
    expect(entriesOf(c.replace(/.$/, (x) => (x === 'A' ? 'B' : 'A')))).toEqual([]);
    expect(unseal('nothing')).toBeNull();
  });

  it('a share link carries a claim this server signed, and only that', () => {
    const t = shareToken({ race: 'race-0002', choice: ORACLE.account, streak: 3 });
    expect(readShare(t)).toEqual({ race: 'race-0002', choice: ORACLE.account, streak: 3 });
    const [body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify(['race-0002', ORACLE.account, 99])).toString('base64url');
    expect(readShare(`${forged}.${mac}`)).toBeNull();
    expect(readShare(`${body}.x`)).toBeNull();
  });
});

describe('settling a round', () => {
  it('writes its tally once, from the picks made before the close, and folds the table', async () => {
    const store = memoryPicks();
    const r1 = race('race-0001', T0, { phase: 'held', state: 'refunded', winner: null });
    const r2 = race('race-0002', T0 + 24 * 60 * MIN, {});
    const A = 'dAAAAAAAAAAAAAAAAAAAAAA';
    const B = 'dBBBBBBBBBBBBBBBBBBBBBB';
    await filePick(store, raceKey(r1), { who: A, choice: HELD, from: 'aaaaaaaa', at: T0 + MIN });
    await filePick(store, raceKey(r1), { who: B, choice: ORACLE.account, from: 'bbbbbbbb', at: T0 + MIN });
    // Picked before r2 opened, under its scheduled time; then changed once it was open; then too late.
    await filePick(store, `t.${r2.openedAt! - 4 * MIN}`, { who: A, choice: NOVA.account, from: 'aaaaaaaa', at: T0 + 20 * 60 * MIN });
    await filePick(store, raceKey(r2), { who: A, choice: ORACLE.account, from: 'aaaaaaaa', at: r2.openedAt! + 10 * MIN });
    await filePick(store, raceKey(r2), { who: B, choice: ORACLE.account, from: 'bbbbbbbb', at: r2.openedAt! + 46 * MIN });

    const board = await settle({ races: [r2, r1] }, store, T0);
    expect(board.rounds.map((r) => [r.race, r.outcome, r.picks])).toEqual([
      ['race-0001', HELD, 2],
      ['race-0002', ORACLE.account, 1],
    ]);
    expect(board.callers[A]).toMatchObject({ right: 2, streak: 2 });
    expect(board.callers[B]).toMatchObject({ right: 0, streak: 0, last: null });

    // A pick filed after the round was settled changes nothing: the tally is written once.
    await filePick(store, raceKey(r2), { who: B, choice: ORACLE.account, from: 'bbbbbbbb', at: r2.openedAt! + MIN });
    forget();
    const again = await settle({ races: [r2, r1] }, store, T0 + 10 * MIN);
    expect(again.callers[B]).toMatchObject({ right: 0 });
    expect(JSON.parse((await store.read(`${ROOT}tally/${raceKey(r2)}.json`))!).picks).toEqual([[A, ORACLE.account, 1]]);
  });

  it('counts a round’s picks up to its first seal: one the store took after it is left out, one made before the round opened is in', async () => {
    const store = memoryPicks();
    const opened = T0 + 2 * MIN;
    const sealedAt = opened + 6 * MIN;
    const r = race('race-0005', opened, { events: [{ kind: 'seal', at: sealedAt, tx: 'seal-0', who: ORACLE, amount: null, ok: true, seq: 0 }] });
    const AHEAD = 'dAHEADXXXXXXXXXXXXXXXX';
    const EARLY = 'dEARLYXXXXXXXXXXXXXXXX';
    const LATE = 'dLATEXXXXXXXXXXXXXXXXX';
    const TURN = 'dTURNEDXXXXXXXXXXXXXXX';
    // Between rounds, under the scheduled time the round then opened for.
    await filePick(store, `t.${T0}`, { who: AHEAD, choice: ORACLE.account, from: 'aaaaaaaa', at: T0 - 5 * 60 * MIN });
    // In the open round, a second before its first seal.
    await filePick(store, raceKey(r), { who: EARLY, choice: ORACLE.account, from: 'bbbbbbbb', at: sealedAt - 1000 });
    // A second after it: the server's reading had not caught the seal yet, so the store took the pick.
    await filePick(store, raceKey(r), { who: LATE, choice: ORACLE.account, from: 'cccccccc', at: sealedAt + 1000 });
    // Picked NOVA in time, then switched to the mask that sealed first once the stage showed it.
    await filePick(store, raceKey(r), { who: TURN, choice: NOVA.account, from: 'dddddddd', at: opened + MIN });
    await filePick(store, raceKey(r), { who: TURN, choice: ORACLE.account, from: 'dddddddd', at: sealedAt + 20 * MIN });

    const board = await settle({ races: [r] }, store, T0 + 300 * MIN);
    expect(board.rounds).toEqual([{ key: raceKey(r), race: 'race-0005', outcome: ORACLE.account, picks: 3 }]);
    expect(board.callers[AHEAD]).toMatchObject({ calls: 1, right: 1, streak: 1 });
    expect(board.callers[EARLY]).toMatchObject({ calls: 1, right: 1, streak: 1 });
    expect(board.callers[LATE]).toBeUndefined();
    expect(board.callers[TURN]).toMatchObject({ calls: 1, right: 0, streak: 0 });
    expect(JSON.parse((await store.read(`${ROOT}tally/${raceKey(r)}.json`))!).picks).toEqual([
      [AHEAD, ORACLE.account, 1],
      [TURN, NOVA.account, 1],
      [EARLY, ORACLE.account, 1],
    ]);
  });

  // Race 10 on mainnet: refunded, and read as «the vault held» until the reader named NOVA, who drained the vault and
  // was never paid. A round settled with an end the chain no longer gives is tallied again from the picks on file.
  it('tallies a round again when the chain gives it another end than the one it was settled with', async () => {
    const store = memoryPicks();
    const held = race('race-0010', T0, { phase: 'held', state: 'refunded', winner: null, takes: null, loot: null });
    const broke = { ...held, phase: 'broken' as const, winner: NOVA, loot: '1', takes: '1' };
    const SAID_HELD = 'dHELDXXXXXXXXXXXXXXXXX';
    const SAID_NOVA = 'dNOVAXXXXXXXXXXXXXXXXX';
    await filePick(store, raceKey(held), { who: SAID_HELD, choice: HELD, from: 'aaaaaaaa', at: T0 + MIN });
    await filePick(store, raceKey(held), { who: SAID_NOVA, choice: NOVA.account, from: 'bbbbbbbb', at: T0 + MIN });

    const before = await settle({ races: [held] }, store, T0 + 300 * MIN);
    expect(before.rounds.map((r) => r.outcome)).toEqual([HELD]);
    expect([before.callers[SAID_HELD]?.right, before.callers[SAID_NOVA]?.right]).toEqual([1, 0]);

    const after = await settle({ races: [broke] }, store, T0 + 302 * MIN);
    expect(after.rounds).toEqual([{ key: raceKey(held), race: 'race-0010', outcome: NOVA.account, picks: 2 }]);
    expect([after.callers[SAID_HELD]?.right, after.callers[SAID_NOVA]?.right]).toEqual([0, 1]);
    expect(JSON.parse((await store.read(`${ROOT}tally/${raceKey(held)}.json`))!).outcome).toBe(NOVA.account);
    // Settled with its true end, it is not tallied again.
    expect(await settle({ races: [broke] }, store, T0 + 304 * MIN)).toEqual(after);
  });

  it('a server that kept the old tally reads it anew once another server tallied the round again', async () => {
    const store = memoryPicks();
    const held = race('race-0010', T0, { phase: 'held', state: 'refunded', winner: null, takes: null, loot: null });
    const broke = { ...held, phase: 'broken' as const, winner: NOVA, loot: '1', takes: '1' };
    const next = race('race-0011', T0 + 24 * 60 * MIN, { winner: ORACLE });
    const SAID_NOVA = 'dNOVAXXXXXXXXXXXXXXXXX';
    await filePick(store, raceKey(held), { who: SAID_NOVA, choice: NOVA.account, from: 'bbbbbbbb', at: T0 + MIN });
    // This server settles the round as it was read then, and keeps that tally.
    await settle({ races: [held] }, store, T0 + 300 * MIN);
    // Another server tallies it again with the true end and writes the board.
    const tally = JSON.parse((await store.read(`${ROOT}tally/${raceKey(held)}.json`))!);
    await store.write(`${ROOT}tally/${raceKey(held)}.json`, JSON.stringify({ ...tally, outcome: NOVA.account }));
    const board = JSON.parse((await store.read(`${ROOT}board.json`))!);
    await store.write(`${ROOT}board.json`, JSON.stringify({ ...board, rounds: board.rounds.map((r: object) => ({ ...r, outcome: NOVA.account })) }));

    // The next round settles here: the table it folds has race 10's true end, not the tally this server kept.
    const after = await settle({ races: [next, broke] }, store, T0 + 30 * 60 * MIN);
    expect(after.rounds.map((r) => [r.race, r.outcome])).toEqual([
      ['race-0010', NOVA.account],
      ['race-0011', ORACLE.account],
    ]);
    expect(after.callers[SAID_NOVA]).toMatchObject({ calls: 1, right: 1 });
  });

  it('a round still running, or with its judge at work, is not settled', async () => {
    const store = memoryPicks();
    const running = race('race-0003', T0, { phase: 'racing', live: true, state: 'open', winner: null });
    const judging = race('race-0004', T0, { live: true, state: 'judging' });
    const board = await settle({ races: [running, judging] }, store, T0);
    expect(board.rounds).toEqual([]);
    expect(await readBoard(store, T0 + 2 * MIN)).toEqual(board);
  });

  it('a device linked to a vault brings its calls with it', async () => {
    const store = memoryPicks();
    const r1 = race('race-0001', T0, {});
    const d = 'dDDDDDDDDDDDDDDDDDDDDDD';
    await filePick(store, raceKey(r1), { who: d, choice: ORACLE.account, from: 'aaaaaaaa', at: T0 + MIN });
    await linkDevice(store, d, 'a0xabc');
    const board = await settle({ races: [r1] }, store, T0);
    expect(board.callers['a0xabc']).toMatchObject({ right: 1, streak: 1 });
  });
});
