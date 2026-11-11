// Pick the breaker, the pure part: which round takes picks and until when (its first seal), how a round ended on
// chain, one pick per person, the per-address cap, the streak and the callers' table.
import type { NextRace, Race, RaceEvent, Who } from '@maskwars/arena';
import { describe, expect, it } from 'vitest';
import {
  boardOf,
  callerName,
  choiceIn,
  closesAt,
  type Filed,
  fileName,
  firstSealOf,
  HELD,
  keyIn,
  keyIs,
  lastDecided,
  nextKey,
  outcomeOf,
  parseFile,
  PER_ADDRESS,
  pickOn,
  pickView,
  raceAt,
  raceKey,
  sealedShut,
  tallyOf,
  topCallers,
  windowOf,
  withPick,
} from './pick';

const MIN = 60_000;
const who = (name: string): Who => ({ account: `${name.toLowerCase()}.maskwars.near`, slug: name.toLowerCase(), name, mask: true, model: null });
const NOVA = who('NOVA');
const ONYX = who('ONYX');
const ORACLE = who('ORACLE');
const T0 = Date.UTC(2026, 10, 12, 18, 4);

/** A round of the arena's own team, opened at `at`, sealing for 45 minutes, four hours long. */
function round(o: Partial<Race> & { at?: number } = {}): Race {
  const at = o.at ?? T0;
  return {
    id: 'race-0002',
    network: 'mainnet',
    contract: 'bounty.maskwars.near',
    season: null,
    kind: 'safe',
    phase: 'sealing',
    live: true,
    state: 'open',
    team: 'house.maskwars.near',
    official: true,
    target: 'vault.house.maskwars.near',
    targetCode: null,
    locked: '1',
    bounty: '1',
    inSafe: '1',
    safeFunded: '1',
    minLoot: '1',
    openedAt: at,
    startsAt: at + 45 * MIN,
    deadline: at + 240 * MIN,
    sealUntil: at + 45 * MIN,
    revealUntil: at + 105 * MIN,
    masks: [NOVA, ONYX, ORACLE],
    winner: null,
    brokeAt: null,
    breakMs: null,
    loot: null,
    payout: null,
    refund: null,
    takes: null,
    prize: '2000000000000000000000000',
    events: [],
    txs: { open: null, drain: null, payout: null },
    judge: null,
    runId: null,
    ...o,
  };
}

const SEC = 1000;
/** A mask's seal as the arena reads it from the round: its time on chain and its place, 0 first. */
const seal = (mask: Who, at: number, seq = 0): RaceEvent => ({ kind: 'seal', at, tx: `seal-${seq}`, who: mask, amount: null, ok: true, seq });
/** The first seal of the rounds below: seven minutes into the sealing window. */
const SEALED = T0 + 7 * MIN;

const broken = (o: Partial<Race> & { at?: number } = {}) => round({ phase: 'broken', live: false, state: 'paid', winner: ORACLE, breakMs: 984_000, takes: '1836000000000000000000000', ...o });
const held = (o: Partial<Race> & { at?: number } = {}) => round({ phase: 'held', live: false, state: 'refunded', ...o });

const next = (o: Partial<NextRace> = {}): NextRace => ({
  season: 'house.maskwars.near',
  at: T0 + 24 * 60 * MIN,
  n: 3,
  target: 'live-safe',
  targetCode: 'x',
  inSafe: '1',
  locked: '1',
  prize: '1850000000000000000000000',
  minLoot: '1',
  masks: [NOVA, ONYX, ORACLE],
  sealMinutes: 45,
  hours: 4,
  funded: true,
  ...o,
});

describe('the window: which round takes picks, until when', () => {
  it('a round nobody has sealed takes picks until its sealing window closes', () => {
    const r = round();
    const view = { now: r, next: null, races: [r] };
    const w = windowOf(view, T0 + 10 * MIN, false)!;
    expect(w).toMatchObject({ key: raceKey(r), closes: T0 + 45 * MIN, opens: null, race: r.id });
    expect(firstSealOf(r)).toBeNull();
    expect(closesAt(r)).toBe(T0 + 45 * MIN);
    expect(sealedShut(view)).toBeNull();
    // The masks in the stage's order: Ember (ONYX, ORACLE) left, Violet (NOVA) right.
    expect(w.masks.map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(windowOf(view, T0 + 45 * MIN, false)).toBeNull();
    expect(windowOf(view, T0 + 50 * MIN, false)).toBeNull();
  });

  it('picks close the moment the round’s first seal is on chain: the stage shows who sealed from then on', () => {
    const open = round();
    const sealed = round({ events: [seal(ONYX, SEALED)] });
    // A second before the seal the reading has none: the round takes picks. With the seal in the reading, none, though
    // the sealing window runs for another 38 minutes.
    expect(windowOf({ now: open, next: null, races: [open] }, SEALED - SEC, false)?.key).toBe(raceKey(open));
    for (const now of [SEALED, SEALED + SEC, T0 + 44 * MIN]) expect(windowOf({ now: sealed, next: null, races: [sealed] }, now, false)).toBeNull();
    expect(firstSealOf(sealed)).toBe(SEALED);
    expect(closesAt(sealed)).toBe(SEALED);
    expect(sealedShut({ now: sealed })).toBe(SEALED);
    // The page has the round locked, not gone, and offers no next round while this one runs.
    const v = pickView({ now: sealed, next: next(), races: [sealed] }, [], SEALED + SEC, false);
    expect(v.window).toBeNull();
    expect(v.running).toMatchObject({ id: sealed.id, sealing: true });
  });

  it('the first seal is the earliest one, whatever order the reading lists them in', () => {
    const r = round({ events: [seal(NOVA, SEALED + 3 * MIN, 1), seal(ONYX, SEALED, 0), seal(ORACLE, SEALED + 9 * MIN, 2)] });
    expect(firstSealOf(r)).toBe(SEALED);
    // Other events of the round are not seals: the opening, the safe being filled.
    const quiet = round({ events: [{ kind: 'open', at: T0, tx: 'o', who: null, amount: '1', ok: true }, { kind: 'fund', at: T0 + MIN, tx: 'f', who: null, amount: '1', ok: true }] });
    expect(firstSealOf(quiet)).toBeNull();
    expect(windowOf({ now: quiet, next: null, races: [quiet] }, T0 + 10 * MIN, false)).not.toBeNull();
  });

  it('a seal whose time the reading does not know closes picks from the round’s opening', () => {
    const r = round({ events: [seal(ONYX, 0)] });
    expect(firstSealOf(r)).toBe(T0);
    expect(closesAt(r)).toBe(T0);
    expect(windowOf({ now: r, next: null, races: [r] }, T0 + MIN, false)).toBeNull();
  });

  it('a reading too old to say what happens now takes no picks', () => {
    const r = round();
    expect(windowOf({ now: r, next: next(), races: [r] }, T0 + 10 * MIN, true)).toBeNull();
    // Between rounds too: the next round is open for picks only over a reading of now.
    const last = broken();
    expect(windowOf({ now: last, next: next(), races: [last] }, T0 + 6 * 60 * MIN, false)).not.toBeNull();
    expect(windowOf({ now: last, next: next(), races: [last] }, T0 + 6 * 60 * MIN, true)).toBeNull();
  });

  it('the next round takes picks once the schedule names it and the round before it has ended', () => {
    const last = broken();
    const n = next();
    const w = windowOf({ now: last, next: n, races: [last] }, T0 + 6 * 60 * MIN, false)!;
    // Its start is the one time known ahead; `closes` is the latest its picks can stay open.
    expect(w).toMatchObject({ key: nextKey(n.at), opens: n.at, closes: n.at + 45 * MIN, race: null });
    // A round that ended sealed does not hold the next one back: its seals are its own.
    const sealedLast = broken({ events: [seal(ORACLE, SEALED)] });
    expect(windowOf({ now: sealedLast, next: n, races: [sealedLast] }, T0 + 6 * 60 * MIN, false)?.key).toBe(nextKey(n.at));
    expect(sealedShut({ now: sealedLast })).toBeNull();
    // Not before the round on stage has ended: while it runs or its judge is on it, the page is that round's.
    for (const now of [round({ phase: 'racing' }), broken({ state: 'judging', live: true })]) {
      expect(windowOf({ now, next: n, races: [now] }, T0 + 60 * MIN, false)).toBeNull();
    }
    // Not when the treasury cannot open it, and not past its sealing window.
    expect(windowOf({ now: last, next: next({ funded: false }), races: [last] }, T0 + 6 * 60 * MIN, false)).toBeNull();
    expect(windowOf({ now: last, next: n, races: [last] }, n.at + 45 * MIN, false)).toBeNull();
  });

  it('a scheduled time becomes its race: the first official sealed round opened near it', () => {
    const n = next();
    const late = round({ id: 'race-0003', at: n.at + 7 * MIN });
    const other = round({ id: 'race-0009', at: n.at + 2 * MIN, official: false });
    expect(raceAt(n.at, [late, other])).toBe(late);
    expect(raceAt(n.at, [round({ id: 'race-0003', at: n.at + 13 * 60 * MIN })])).toBeNull();
    // Once it is open, the window is the race's own, and the scheduled one is gone.
    const view = { now: late, next: n, races: [late, other] };
    expect(windowOf(view, n.at + 20 * MIN, false)?.key).toBe(raceKey(late));
    expect(keyIs(nextKey(n.at), late, view.races)).toBe(true);
    expect(keyIs(nextKey(n.at), other, view.races)).toBe(false);
    // A page that still shows the scheduled round sends its time: it is this round's window. Another time is not.
    const w = windowOf(view, n.at + 8 * MIN, false)!;
    expect(keyIn(w, raceKey(late), view)).toBe(true);
    expect(keyIn(w, nextKey(n.at), view)).toBe(true);
    expect(keyIn(w, nextKey(n.at - 24 * 60 * MIN), view)).toBe(false);
    expect(keyIn(w, raceKey(other), view)).toBe(false);
  });

  it('a round opened by another team, or with no sealing window, takes no picks', () => {
    for (const r of [round({ official: false }), round({ sealUntil: null })]) expect(windowOf({ now: r, next: null, races: [r] }, T0 + MIN, false)).toBeNull();
  });

  it('a pick is one of the round’s masks, or the vault holding', () => {
    const w = windowOf({ now: round(), next: null, races: [round()] }, T0, false)!;
    expect(choiceIn(w, ORACLE.account)).toBe(true);
    expect(choiceIn(w, HELD)).toBe(true);
    expect(choiceIn(w, 'kira.masks.maskwars.near')).toBe(false);
    expect(choiceIn(w, 7)).toBe(false);
  });
});

describe('how a round ended: from the chain, and only once it is final', () => {
  it('the winner once the contract paid, the vault once the bounty went back; nothing while the judge works', () => {
    expect(outcomeOf(broken())).toBe(ORACLE.account);
    expect(outcomeOf(held())).toBe(HELD);
    expect(outcomeOf(round())).toBeNull();
    expect(outcomeOf(round({ phase: 'racing' }))).toBeNull();
    expect(outcomeOf(broken({ state: 'judging', live: true }))).toBeNull();
    expect(outcomeOf(broken({ live: true }))).toBeNull();
  });

  it('the last decided round is the newest pickable one that ended', () => {
    const a = held({ id: 'race-0001', at: T0 - 24 * 60 * MIN });
    const b = broken({ id: 'race-0002' });
    const c = round({ id: 'race-0003', at: T0 + 24 * 60 * MIN });
    expect(lastDecided([c, b, a])?.id).toBe('race-0002');
  });
});

describe('the record of a round: one pick per person, the last before the close', () => {
  const r = broken();
  const f = (w: string, choice: string, at: number, from = 'aaaaaaaa'): Filed => ({ who: w, choice, from, at });

  it('names round-trip, and anything else is not a pick', () => {
    const p = f('dAbcdefghijklmnopqrstu', ORACLE.account, T0 + MIN);
    expect(parseFile(fileName(p))).toEqual(p);
    for (const bad of ['x~held~aaaaaaaa~1794335495048', 'dAbcdefghijklmnopqrstu~held~zz~1', 'dAbcdefghijklmnopqrstu~HELD!~aaaaaaaa~1794335495048', 'a~b~c~d~e']) expect(parseFile(bad)).toBeNull();
  });

  it('a change of mind replaces the pick; a pick after the close does not count', () => {
    const t = tallyOf(r, [f('dPERSONONEXXXXXXXXXXXX', NOVA.account, T0 + MIN), f('dPERSONONEXXXXXXXXXXXX', ORACLE.account, T0 + 5 * MIN), f('dPERSONONEXXXXXXXXXXXX', ONYX.account, T0 + 45 * MIN)])!;
    expect(t.picks).toEqual([['dPERSONONEXXXXXXXXXXXX', ORACLE.account, 1]]);
    expect(t.outcome).toBe(ORACLE.account);
  });

  describe('a round that was sealed: the close is its first seal', () => {
    const sealed = broken({ events: [seal(ORACLE, SEALED, 0), seal(NOVA, SEALED + 4 * MIN, 1)] });
    const EARLY = 'dEARLYXXXXXXXXXXXXXXXX';
    const LATE = 'dLATEXXXXXXXXXXXXXXXXX';
    const TURN = 'dTURNEDXXXXXXXXXXXXXXX';
    const AHEAD = 'dAHEADXXXXXXXXXXXXXXXX';

    it('a pick a second before the first seal counts; one at the seal, or a second after, does not', () => {
      const t = tallyOf(sealed, [f(EARLY, NOVA.account, SEALED - SEC), f('dONTHESEALXXXXXXXXXXXX', ORACLE.account, SEALED), f(LATE, ORACLE.account, SEALED + SEC)])!;
      expect(t.picks).toEqual([[EARLY, NOVA.account, 1]]);
    });

    it('a pick the store took after the first seal is not counted, though the sealing window was still running', () => {
      // The server's reading lagged the chain: the pick went in, the tally leaves it out. The person who read the stage
      // and named the mask that sealed first gets nothing for it.
      const t = tallyOf(sealed, [f(LATE, ORACLE.account, SEALED + 2 * SEC), f(LATE, ORACLE.account, T0 + 30 * MIN)])!;
      expect(t.picks).toEqual([]);
      expect(boardOf([t]).callers[LATE]).toBeUndefined();
    });

    it('a change of mind after the first seal changes nothing: the last pick before it stands', () => {
      const t = tallyOf(sealed, [f(TURN, NOVA.account, T0 + MIN), f(TURN, HELD, SEALED - SEC), f(TURN, ORACLE.account, SEALED + SEC)])!;
      expect(t.picks).toEqual([[TURN, HELD, 1]]);
      expect(boardOf([t]).callers[TURN]).toMatchObject({ calls: 1, right: 0, streak: 0 });
    });

    it('a pick made before the round opened counts', () => {
      const t = tallyOf(sealed, [f(AHEAD, ORACLE.account, T0 - 3 * 60 * MIN)])!;
      expect(t.picks).toEqual([[AHEAD, ORACLE.account, 1]]);
      expect(boardOf([t]).callers[AHEAD]).toMatchObject({ calls: 1, right: 1, streak: 1 });
    });

    it('a round with no seal still closes at the end of its sealing window', () => {
      const t = tallyOf(held(), [f(EARLY, HELD, T0 + 45 * MIN - SEC), f(LATE, HELD, T0 + 45 * MIN)])!;
      expect(t.picks).toEqual([[EARLY, HELD, 1]]);
    });
  });

  it('one address ranks a household, not a farm', () => {
    const many = Array.from({ length: PER_ADDRESS + 3 }, (_, i) => f(`dPERSON${String(i).padStart(15, '0')}`, ORACLE.account, T0 + i * 1000, 'bbbbbbbb'));
    const t = tallyOf(r, [...many, f('dSOMEONEELSEXXXXXXXXXX', ORACLE.account, T0 + 99_000, 'cccccccc')])!;
    expect(t.picks.filter((p) => p[2] === 1)).toHaveLength(PER_ADDRESS + 1);
    expect(t.picks.find((p) => p[0] === 'dSOMEONEELSEXXXXXXXXXX')?.[2]).toBe(1);
  });

  it('a round that has not ended has no tally', () => {
    expect(tallyOf(round(), [])).toBeNull();
    expect(tallyOf(broken({ state: 'judging', live: true }), [])).toBeNull();
  });
});

describe('the table: streaks and the best callers', () => {
  const day = (n: number) => T0 + n * 24 * 60 * MIN;
  const r1 = held({ id: 'race-0001', at: day(0) });
  const r2 = broken({ id: 'race-0002', at: day(1) });
  const r3 = broken({ id: 'race-0003', at: day(2), winner: NOVA });
  const r4 = broken({ id: 'race-0004', at: day(3) });
  const pick = (r: Race, w: string, choice: string): Filed => ({ who: w, choice, from: `${w.length}`.padStart(8, '0'), at: r.openedAt! + MIN });
  const A = 'dAAAAAAAAAAAAAAAAAAAAAA';
  const B = 'dBBBBBBBBBBBBBBBBBBBBBB';
  const C = 'dCCCCCCCCCCCCCCCCCCCCCC';
  const tallies = [
    tallyOf(r1, [pick(r1, A, HELD), pick(r1, B, HELD), pick(r1, C, ONYX.account)])!,
    tallyOf(r2, [pick(r2, A, ORACLE.account), pick(r2, B, NOVA.account), pick(r2, C, ORACLE.account)])!,
    tallyOf(r3, [pick(r3, A, NOVA.account), pick(r3, C, NOVA.account)])!,
    tallyOf(r4, [pick(r4, A, ORACLE.account), pick(r4, B, ORACLE.account)])!,
  ];

  it('a streak is rounds called right in a row: a miss or a round without a pick starts it over', () => {
    const b = boardOf([...tallies].reverse());
    expect(b.rounds.map((r) => r.race)).toEqual(['race-0001', 'race-0002', 'race-0003', 'race-0004']);
    expect(b.callers[A]).toMatchObject({ calls: 4, right: 4, streak: 4, best: 4, last: { race: 'race-0004', right: true } });
    // B: right, wrong, no pick, right.
    expect(b.callers[B]).toMatchObject({ calls: 3, right: 2, streak: 1, best: 1 });
    // C: wrong, right, right, no pick: the run is over, the best stays.
    expect(b.callers[C]).toMatchObject({ calls: 3, right: 2, streak: 0, best: 2, last: null });
  });

  it('the best callers: most called right, then the longest run', () => {
    expect(topCallers(boardOf(tallies)).map((c) => c.who)).toEqual([A, C, B]);
  });

  it('a device’s picks follow the person to their vault', () => {
    const vault = 'a0x1234567890abcdef1234567890abcdef12345678';
    const b = boardOf(tallies, new Map([[A, vault]]));
    expect(b.callers[vault]).toMatchObject({ right: 4, streak: 4 });
    expect(b.callers[A]).toBeUndefined();
  });

  it('a caller is shown by their vault, or by a short tag of their device', () => {
    expect(callerName('a0x1234567890abcdef1234567890abcdef12345678')).toBe('0x123456…345678');
    expect(callerName('aalice.near')).toBe('alice.near');
    expect(callerName(A)).toMatch(/^Guest [0-9A-Z]{4}$/);
  });
});

describe('what a person sees', () => {
  it('their pick on a round, under its scheduled time or its own key, the last one counting', () => {
    const n = next();
    const r = round({ id: 'race-0003', at: n.at + 4 * MIN });
    const races = [r];
    let entries = withPick([], { key: nextKey(n.at), choice: NOVA.account, at: n.at - 60 * MIN });
    entries = withPick(entries, { key: raceKey(r), choice: ORACLE.account, at: n.at + 10 * MIN });
    expect(pickOn(entries, r, races)?.choice).toBe(ORACLE.account);
    const view = pickView({ now: r, next: null, races }, entries, n.at + 20 * MIN, false);
    expect(view.window?.key).toBe(raceKey(r));
    expect(view.mine?.choice).toBe(ORACLE.account);
  });

  it('a pick on the next round is the pick on the round it becomes: lit while it is open, locked at its first seal', () => {
    const n = next();
    const key = nextKey(n.at);
    const last = broken({ id: 'race-0001', at: T0 - 24 * 60 * MIN });
    const entries = withPick([], { key, choice: NOVA.account, at: n.at - 60 * MIN });
    // Between rounds: filed under the scheduled time.
    const before = pickView({ now: last, next: n, races: [last] }, entries, n.at - 30 * MIN, false);
    expect(before.window).toMatchObject({ key, opens: n.at, race: null });
    expect(before.mine?.choice).toBe(NOVA.account);
    // The round opens on chain two minutes late, under its own key: the pick is still the person's, and still theirs to change.
    const open = round({ id: 'race-0003', at: n.at + 2 * MIN });
    const after = pickView({ now: open, next: next({ at: n.at + 24 * 60 * MIN }), races: [open, last] }, entries, n.at + 3 * MIN, false);
    expect(after.window).toMatchObject({ key: raceKey(open), opens: null, race: open.id });
    expect(after.mine?.choice).toBe(NOVA.account);
    // Its first seal lands: the pick is locked on the round, and counted in its record.
    const sealed = round({ id: 'race-0003', at: n.at + 2 * MIN, events: [seal(ONYX, n.at + 9 * MIN)] });
    const locked = pickView({ now: sealed, next: null, races: [sealed, last] }, entries, n.at + 10 * MIN, false);
    expect(locked.window).toBeNull();
    expect(locked.runningMine?.choice).toBe(NOVA.account);
    const done = broken({ id: 'race-0003', at: n.at + 2 * MIN, winner: NOVA, events: [seal(ONYX, n.at + 9 * MIN)] });
    expect(keyIs(key, done, [done, last])).toBe(true);
    expect(tallyOf(done, [{ who: 'dAHEADXXXXXXXXXXXXXXXX', choice: NOVA.account, from: 'aaaaaaaa', at: n.at - 60 * MIN }])!.picks).toEqual([['dAHEADXXXXXXXXXXXXXXXX', NOVA.account, 1]]);
  });

  it('a pick the server took after the first seal is not shown as the person’s: the record does not count it', () => {
    const sealed = round({ events: [seal(ONYX, SEALED)] });
    const late = withPick([], { key: raceKey(sealed), choice: ONYX.account, at: SEALED + 2 * SEC });
    expect(pickOn(late, sealed, [sealed])).toBeNull();
    expect(pickView({ now: sealed, next: null, races: [sealed] }, late, SEALED + MIN, false).runningMine).toBeNull();
    // With an earlier pick on the round's scheduled time, that one stands.
    const both = withPick(late, { key: nextKey(T0 - 2 * MIN), choice: HELD, at: T0 - 60 * MIN });
    expect(pickOn(both, sealed, [sealed])?.choice).toBe(HELD);
  });

  it('over an old reading: no window, the round is locked, the pick still shown', () => {
    const r = round();
    const entries = withPick([], { key: raceKey(r), choice: ONYX.account, at: T0 + MIN });
    const v = pickView({ now: r, next: null, races: [r] }, entries, T0 + 10 * MIN, true);
    expect(v.window).toBeNull();
    expect(v.old).toBe(true);
    expect(v.running?.id).toBe(r.id);
    expect(v.runningMine?.choice).toBe(ONYX.account);
  });

  it('after a round, its outcome from the chain and the pick on it', () => {
    const r = broken();
    const v = pickView({ now: r, next: null, races: [r] }, withPick([], { key: raceKey(r), choice: HELD, at: T0 + MIN }), T0 + 300 * MIN, false);
    expect(v.last).toMatchObject({ id: r.id, outcome: ORACLE.account });
    expect(v.lastMine?.choice).toBe(HELD);
    expect(v.running).toBeNull();
  });

  it('a device keeps its last few picks, one per round', () => {
    let e: ReturnType<typeof withPick> = [];
    for (let i = 0; i < 12; i++) e = withPick(e, { key: nextKey(T0 + i * 1000), choice: HELD, at: T0 + i });
    e = withPick(e, { key: nextKey(T0 + 11_000), choice: NOVA.account, at: T0 + 99 });
    expect(e).toHaveLength(8);
    expect(e[0]).toMatchObject({ key: nextKey(T0 + 11_000), choice: NOVA.account });
    expect(new Set(e.map((x) => x.key)).size).toBe(8);
  });
});

describe('a bigger field', () => {
  it('picks are on the three masks the stage stands, and only those', () => {
    const KIRA: Who = { account: 'kira.masks.maskwars.near', slug: null, name: 'kira', mask: true, model: null };
    const r = round({ masks: [NOVA, ONYX, ORACLE, KIRA] });
    const w = windowOf({ now: r, next: null, races: [r] }, T0 + MIN, false)!;
    expect(w.masks.map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(choiceIn(w, KIRA.account)).toBe(false);
  });
});
