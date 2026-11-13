// The masks people forged, for the league: what the factory lists becomes rows, and a factory that fails or is slow
// never fails or slows the page.
import type { MaskStats } from '@maskwars/arena';
import type { MaskView } from '@maskwars/forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FORGED_SHOWN, facesOf, forgedReader, forgedRows, hasForged } from './forged';

const FACTORY = 'masks.maskwars.near';
const NEAR = 10n ** 24n;

function mask(name: string, o: Partial<MaskView> = {}): MaskView {
  return {
    name,
    account: `${name}.${FACTORY}`,
    owner: 'someone.near',
    look: 'porcelain',
    brain: ((68n * NEAR) / 100n).toString(),
    races: 0,
    born_ns: '1',
    state: 'ready',
    race: null,
    ...o,
  } as MaskView;
}

const raced = (name: string, races: number, breaks: number): MaskStats => ({
  who: { account: `${name}.${FACTORY}`, slug: name, name: name.toUpperCase(), mask: true, model: null },
  races,
  breaks,
  earned: '0',
  fastestMs: null,
  fastestRace: null,
  history: [],
});

describe('the rows of “Forged masks”', () => {
  it('shows the one mask the factory lists as its own page does: no race, no break, its tank, ready', () => {
    expect(forgedRows([mask('dmytro')], [])).toEqual({
      masks: [{ name: 'dmytro', look: 'porcelain', races: 0, breaks: 0, tank: '680000000000000000000000', state: { key: 'ready', word: 'Ready to race' } }],
      more: 0,
    });
  });

  it('puts the mask with the most races first, then the oldest', () => {
    const masks = [mask('young', { born_ns: '30' }), mask('busy', { races: 4, born_ns: '20' }), mask('old', { born_ns: '10' }), mask('busier', { races: 9, born_ns: '40' })];
    expect(forgedRows(masks, [])?.masks.map((m) => m.name)).toEqual(['busier', 'busy', 'old', 'young']);
  });

  it('takes races and breaks from the arena’s record of the mask, and never fewer races than the factory counted', () => {
    const rows = forgedRows([mask('kira', { races: 2 }), mask('echo', { races: 5 })], [raced('kira', 3, 2), raced('echo', 1, 0)]);
    expect(rows?.masks.map((m) => [m.name, m.races, m.breaks])).toEqual([
      ['echo', 5, 0],
      ['kira', 3, 2],
    ]);
  });

  it('words each state as the mask’s own page does', () => {
    const rows = forgedRows(
      [
        mask('a', { state: 'racing', race: { race: 'race-0007', held: '1', armed_ns: '1', keys: [] }, born_ns: '1' }),
        mask('b', { state: 'paused', born_ns: '2' }),
        mask('c', { brain: '0', born_ns: '3' }),
        mask('d', { born_ns: '4' }),
      ],
      [],
    );
    expect(rows?.masks.map((m) => m.state)).toEqual([
      { key: 'racing', word: 'Racing now' },
      { key: 'paused', word: 'Paused' },
      { key: 'empty', word: 'Out of fuel' },
      { key: 'ready', word: 'Ready to race' },
    ]);
  });

  it('shows twelve at most and counts the rest', () => {
    const many = Array.from({ length: 15 }, (_, i) => mask(`m${i}`, { born_ns: String(100 + i) }));
    const rows = forgedRows(many, []);
    expect(FORGED_SHOWN).toBe(12);
    expect(rows?.masks).toHaveLength(12);
    expect(rows?.masks.at(-1)?.name).toBe('m11');
    expect(rows?.more).toBe(3);
    expect(forgedRows(many.slice(0, 12), [])?.more).toBe(0);
  });

  it('leaves out a mask still being forged: it has no page yet', () => {
    expect(forgedRows([mask('soon', { state: 'forging' }), mask('here', { born_ns: '2' })], [])?.masks.map((m) => m.name)).toEqual(['here']);
  });

  it('is nothing when the factory lists no mask, or was not read', () => {
    expect(forgedRows([], [raced('kira', 1, 0)])).toBeNull();
    expect(forgedRows([mask('soon', { state: 'forging' })], [])).toBeNull();
    expect(forgedRows(null, [])).toBeNull();
  });
});

describe('the reader of the factory’s masks', () => {
  afterEach(() => vi.useRealTimers());

  it('reuses one reading for a few seconds, then reads again', async () => {
    let t = 0;
    const list = vi.fn(async () => [mask('dmytro')]);
    const r = forgedReader({ list, now: () => t, ttlMs: 15_000 });
    expect((await r.read())?.map((m) => m.name)).toEqual(['dmytro']);
    t = 14_999;
    await r.read();
    expect(list).toHaveBeenCalledTimes(1);
    t = 15_000;
    await r.read();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('asks the factory once for pages that come together', async () => {
    const list = vi.fn(async () => [mask('dmytro')]);
    const r = forgedReader({ list });
    await Promise.all([r.read(), r.read(), r.read()]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('gives nothing, and no error, when the factory does not answer; the next page asks again', async () => {
    const list = vi.fn(async (): Promise<MaskView[]> => {
      throw new Error('no RPC answered');
    });
    const r = forgedReader({ list });
    await expect(r.read()).resolves.toBeNull();
    await expect(r.read()).resolves.toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shows the last good reading while the factory fails, and not for ever', async () => {
    let t = 0;
    let up = true;
    const r = forgedReader({
      list: async () => {
        if (!up) throw new Error('no RPC answered');
        return [mask('dmytro')];
      },
      now: () => t,
      ttlMs: 15_000,
      keepMs: 600_000,
    });
    await r.read();
    up = false;
    t = 60_000;
    expect((await r.read())?.map((m) => m.name)).toEqual(['dmytro']);
    t = 600_001;
    await expect(r.read()).resolves.toBeNull();
  });

  it('lets a page wait a few seconds and no longer; the slow reading serves the pages after it', async () => {
    vi.useFakeTimers();
    let answer: (masks: MaskView[]) => void = () => {};
    const list = vi.fn(() => new Promise<MaskView[]>((done) => (answer = done)));
    const r = forgedReader({ list, waitMs: 3_000 });
    const first = r.read();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(first).resolves.toBeNull();
    answer([mask('dmytro')]);
    expect((await r.read())?.map((m) => m.name)).toEqual(['dmytro']);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('the faces of the forged masks in a round', () => {
  const ARENA = { account: 'nova.maskwars.near', slug: 'nova', name: 'NOVA', mask: true, model: null };
  const DMYTRO = { account: `dmytro.${FACTORY}`, slug: 'dmytro', name: 'DMYTRO', mask: true, model: null };
  const AGENT = { account: 'scout.agents-lab.near', slug: null, name: 'scout.agents-lab.near', mask: true, model: null };

  it('asks the factory only for a round with a mask the arena has no art for and that has a page of its own', () => {
    expect(hasForged([ARENA])).toBe(false);
    expect(hasForged([ARENA, AGENT])).toBe(false);
    expect(hasForged([ARENA, DMYTRO])).toBe(true);
    expect(hasForged(null)).toBe(false);
  });

  it('gives each forged mask of the round the art of its look and the colour of its eyes, by account', () => {
    const masks = [mask('dmytro'), mask('kira', { look: 'crimson' }), mask('volta', { look: 'graphite' }), mask('stranger', { look: 'crimson' })];
    const field = [ARENA, DMYTRO, { ...DMYTRO, account: `kira.${FACTORY}` }, { ...DMYTRO, account: `volta.${FACTORY}` }];
    expect(facesOf(masks, field)).toEqual({
      [`dmytro.${FACTORY}`]: { art: '/art/wraith.webp', tone: 'ice' },
      [`kira.${FACTORY}`]: { art: '/art/ronin.webp', tone: 'ember' },
      [`volta.${FACTORY}`]: { art: '/art/volt.webp', tone: 'violet' },
    });
  });

  it('leaves out a look the site has no art for, and gives nothing when the factory was not read: the stage shows the mark', () => {
    expect(facesOf([mask('dmytro', { look: 'obsidian' })], [DMYTRO])).toEqual({});
    expect(facesOf(null, [DMYTRO])).toEqual({});
  });
});
