import type { MaskStats } from '@maskwars/arena';
import type { HistoryEvent, MaskView } from '@maskwars/forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readableHistory, readCard, shareText, stateOf } from './person';

const mask = (state: 'ready' | 'racing' | 'paused', brain: string, race: string | null = null) => ({
  state,
  brain,
  race: race ? { race, held: '1', armed_ns: '1', keys: [] } : null,
});

describe('where a person’s mask stands', () => {
  /** The review’s finding 8: an empty tank and no round on any schedule still read “On the next race”. */
  it('promises no race: a mask with fuel is ready, one with an empty tank is out of fuel', () => {
    expect(stateOf(mask('ready', '0'))).toEqual({ key: 'empty', word: 'Out of fuel', note: 'Its mind has no NEAR left to race on' });
    const ready = stateOf(mask('ready', '1600000000000000000000000'));
    expect(ready).toEqual({ key: 'ready', word: 'Ready to race', note: 'It races when a round with the people’s masks opens' });
    for (const s of [ready, stateOf(mask('ready', '0'))]) expect(`${s.word} ${s.note}`).not.toMatch(/next race|next round/i);
  });

  it('names the race it is in, and its owner’s pause', () => {
    expect(stateOf(mask('racing', '0', 'human-0001'))).toEqual({ key: 'racing', word: 'Racing now', note: 'In race H0001' });
    expect(stateOf(mask('paused', '5'))).toMatchObject({ key: 'paused', word: 'Paused' });
  });
});

describe('the race history panel shows only a history someone can read', () => {
  const ECHO = 'echo.masks.mwc59801.testnet';
  const note = (to: string[]): HistoryEvent => ({
    kind: 'note', mask: ECHO, race: 'copy-0001', note: 'v1.AAAA', keys: to.map((t) => ({ to: t, key: 'v1.BBBB' })), at: 1, tx: 't',
  });
  const bob = [{ account: 'bob.testnet', key: 'x25519:00' }];

  it('hides a mask with no note at all, even with readers granted', () => {
    expect(readableHistory({ viewers: bob, events: [] })).toBe(false);
    expect(readableHistory({ viewers: [], events: [] })).toBe(false);
  });

  it('hides notes sealed for nobody who holds a view now', () => {
    expect(readableHistory({ viewers: bob, events: [note([])] })).toBe(false);
    expect(readableHistory({ viewers: bob, events: [note(['eve.testnet'])] })).toBe(false);
    expect(readableHistory({ viewers: [], events: [note(['bob.testnet'])] })).toBe(false);
  });

  it('shows a note sealed for a reader, or shared with one', () => {
    expect(readableHistory({ viewers: bob, events: [note(['bob.testnet'])] })).toBe(true);
    const share: HistoryEvent = { kind: 'share', mask: ECHO, to: 'bob.testnet', keys: 'v1.CCCC', at: 2, tx: 's' };
    expect(readableHistory({ viewers: bob, events: [note([]), share] })).toBe(true);
  });
});

describe('the author’s share in words', () => {
  it('reads basis points as a percent', () => {
    expect(shareText(3000)).toBe('30%');
    expect(shareText(1250)).toBe('12.5%');
    expect(shareText(500)).toBe('5%');
    expect(shareText(2550)).toBe('25.5%');
  });
});

describe('what a forged mask’s link card is drawn from', () => {
  const FACTORY = 'masks.maskwars.near';
  const made = (name: string, o: Partial<MaskView> = {}): MaskView =>
    ({ name, account: `${name}.${FACTORY}`, owner: 'someone.near', look: 'porcelain', model: 'Qwen/Qwen3.8-27B', style: 'fast', brain: '680000000000000000000000', races: 0, state: 'ready', race: null, ...o }) as MaskView;
  const raced = (name: string, races: number, breaks: number): MaskStats => ({
    who: { account: `${name}.${FACTORY}`, slug: name, name: name.toUpperCase(), mask: true, model: null },
    races,
    breaks,
    earned: '0',
    fastestMs: null,
    fastestRace: null,
    history: [],
  });
  const never = <T>() => new Promise<T>(() => {});

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a mask that never raced: the factory’s record, nothing from the arena, and the arena did answer', async () => {
    const dmytro = made('dmytro');
    expect(await readCard('dmytro', { get: async () => dmytro, league: async () => [raced('kira', 3, 1)] })).toEqual({ mask: dmytro, stats: null, whole: true });
  });

  it('a mask that raced: its own record on the arena, found by its account', async () => {
    const kira = made('kira', { races: 3 });
    const read = await readCard('kira', { get: async () => kira, league: async () => [raced('echo', 9, 4), raced('kira', 3, 1)] });
    expect(read).toMatchObject({ mask: kira, stats: { races: 3, breaks: 1 }, whole: true });
  });

  it('asks the factory nothing about the arena’s own masks or a name no mask can have', async () => {
    const get = vi.fn(async () => made('nova'));
    const league = vi.fn(async () => []);
    for (const name of ['nova', 'oracle', 'vault', 'ab', 'has.dot', 'UPPER', '9lives', 'a'.repeat(17), '']) expect(await readCard(name, { get, league })).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(league).not.toHaveBeenCalled();
  });

  it('no such mask, or one still being forged: the arena’s own card', async () => {
    expect(await readCard('ghost', { get: async () => null, league: async () => [] })).toBeNull();
    expect(await readCard('kira', { get: async () => made('kira', { state: 'forging' }), league: async () => [] })).toBeNull();
  });

  it('a factory that fails or does not answer in time: the arena’s own card, never an error', async () => {
    expect(await readCard('kira', { get: () => Promise.reject(new Error('no RPC answered')), league: async () => [] })).toBeNull();
    expect(
      await readCard('kira', {
        get: () => {
          throw new Error('thrown before any promise');
        },
        league: async () => [],
      }),
    ).toBeNull();
    vi.useFakeTimers();
    const late = readCard('kira', { get: () => never<MaskView>(), league: async () => [], waitMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await late).toBeNull();
  });

  it('an arena that fails or is late leaves the mask its card, marked as not the whole story', async () => {
    const kira = made('kira', { races: 2 });
    expect(await readCard('kira', { get: async () => kira, league: () => Promise.reject(new Error('indexer down')) })).toEqual({ mask: kira, stats: null, whole: false });
    vi.useFakeTimers();
    const late = readCard('kira', { get: async () => kira, league: () => never<MaskStats[]>(), waitMs: 3_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await late).toEqual({ mask: kira, stats: null, whole: false });
  });

  it('waits no longer than it was given, whatever is still unanswered', async () => {
    vi.useFakeTimers();
    let done = false;
    const read = readCard('kira', { get: () => never<MaskView>(), league: () => never<MaskStats[]>(), waitMs: 500 }).then((v) => {
      done = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await read).toBeNull();
  });
});
