// The share cards on the recorded testnet answers, the same reading the pages get, plus the states the recording has
// not lived through yet: a race in motion and masks with no frame. CARD_SHOTS=<dir> writes every card as a PNG.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MaskStats, Race } from '@maskwars/arena';
import type { MaskView } from '@maskwars/forge';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.ARENA_FIXTURE ??= resolve(__dirname, '../../../packages/arena/test/fixtures/testnet.json');

const { readArena } = await import('./arena');
const { arenaCard, CACHE, drawn, forgedCard, forgedLines, maskCard, modelName, nameFit, raceCard, raceLines, settled } = await import('./card');
const { cardOf, tag } = await import('./meta');

let races: readonly Race[];
let league: readonly MaskStats[];
beforeAll(async () => {
  const v = await readArena();
  races = v.races;
  league = v.league;
});
const race = (id: string) => races.find((r) => r.id === id)!;

/** race-0003 as it stood before NOVA broke in: the safe open, three masks racing, the clock running. */
const racing = (): Race => {
  const r = race('race-0003');
  return { ...r, phase: 'racing', live: true, state: 'open', winner: null, brokeAt: null, breakMs: null, loot: null, payout: null, takes: null, inSafe: r.safeFunded, events: r.events.filter((e) => e.kind === 'fund' || e.kind === 'open') };
};
const sealing = (): Race => ({ ...racing(), phase: 'sealing', startsAt: race('race-0003').openedAt! + 600_000 });

/** A mask a person forged: no frame in the arena yet, so the card takes the mark. */
const forged = (name: string): MaskStats => {
  const nova = league.find((m) => m.who.slug === 'nova')!;
  return { ...nova, who: { ...nova.who, name: name.toUpperCase(), slug: name, account: `${name}.forge.tinygif8324.testnet` } };
};

const NEAR = 10n ** 24n;

/** A mask the factory holds, as `get_mask` gives it: DMYTRO on mainnet the day it was forged, unless told otherwise. */
const made = (name: string, o: Partial<MaskView> = {}): MaskView =>
  ({
    name,
    account: `${name}.masks.maskwars.near`,
    owner: 'someone.near',
    look: 'porcelain',
    model: 'Qwen/Qwen3.8-27B',
    style: 'fast',
    brain: ((68n * NEAR) / 100n).toString(),
    races: 0,
    state: 'ready',
    race: null,
    ...o,
  }) as MaskView;

/** What the arena holds about a forged mask that raced. */
const ran = (races: number, breaks: number, earned = '0'): Pick<MaskStats, 'races' | 'breaks' | 'earned'> => ({ races, breaks, earned });

const shots = process.env.CARD_SHOTS;
async function png(name: string, res: Response): Promise<{ width: number; height: number; cache: string | null }> {
  expect(res.headers.get('content-type')).toBe('image/png');
  const buf = Buffer.from(await res.arrayBuffer());
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  if (shots) {
    mkdirSync(shots, { recursive: true });
    writeFileSync(join(shots, `${name}.png`), buf);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), cache: res.headers.get('cache-control') };
}

describe('race card lines', () => {
  it('says what the page says about race-0003: NOVA, the take, the time, the field', () => {
    const l = raceLines(race('race-0003'));
    expect(l).toMatchObject({ kicker: 'RACE 0003 · 6 NOV · TESTNET', amount: '1.086', tone: 'money', head: 'NOVA BROKE THE VAULT', sub: 'IN 8:13 · FIRST OF 3 MASKS', face: 'nova', vault: false });
    expect(settled(race('race-0003'))).toBe(true);
  });

  it('keeps a winner that is no mask off the face: the vault, and who got paid', () => {
    const l = raceLines(race('race-0002'));
    expect(l).toMatchObject({ amount: '0.1', tone: 'money', head: 'OPEN-ADMIN IS BROKEN', sub: "PAID TO THE TEAM'S OWN ACCOUNT", face: null, vault: true });
  });

  it('a held race: the bounty back to the team, never in money green', () => {
    expect(raceLines(race('race-0001'))).toMatchObject({ amount: '0.1', tone: 'plain', head: 'NOBODY GOT THROUGH', sub: 'BACK TO THE TEAM' });
  });

  it('a race in motion: what is on the line, the field and when it closes', () => {
    const r = racing();
    expect(raceLines(r)).toMatchObject({ amount: '1.086', tone: 'plain', head: 'THE VAULT IS OPEN', sub: '3 MASKS RACING · CLOSES 9 NOV 18:26 UTC' });
    expect(settled(r)).toBe(false);
    expect(raceLines(sealing())).toMatchObject({ head: 'MASKS ARE SEALING', sub: '3 MASKS IN · STARTS 18:36 UTC' });
  });

  it('names a model without its maker', () => {
    expect(modelName('deepseek-ai/DeepSeek-V4.1-Flash-1017')).toBe('DeepSeek-V4.1-Flash-1017');
    expect(modelName('local')).toBe('local');
  });
});

describe('the card of a forged mask', () => {
  it('a mask that never raced: its name, the face and light of its look, ready, its mind by the names its page shows', () => {
    expect(forgedLines(made('dmytro'), null)).toEqual({
      name: 'DMYTRO',
      face: 'wraith',
      tone: 'ice',
      taken: null,
      line: 'READY TO RACE',
      mind: 'Mind: Qwen 3.8 27B · Fast',
    });
  });

  it('each look has the frame and the light its page shows', () => {
    expect(forgedLines(made('kira', { look: 'crimson' }), null)).toMatchObject({ face: 'ronin', tone: 'ember' });
    expect(forgedLines(made('kira', { look: 'graphite' }), null)).toMatchObject({ face: 'volt', tone: 'violet' });
    // A look the site has no frame for: the mark stands in, never a missing picture.
    expect(forgedLines(made('kira', { look: 'obsidian' }), null)).toMatchObject({ face: null, tone: 'ice' });
  });

  it('a mask that raced and broke nothing counts its races, never fewer than the factory counted', () => {
    expect(forgedLines(made('kira', { races: 3 }), ran(3, 0))).toMatchObject({ taken: null, line: '3 RACES' });
    expect(forgedLines(made('kira', { races: 1 }), null)).toMatchObject({ taken: null, line: '1 RACE' });
    expect(forgedLines(made('kira', { races: 2 }), ran(5, 0))).toMatchObject({ line: '5 RACES' });
    expect(forgedLines(made('kira', { races: 7 }), ran(5, 0))).toMatchObject({ line: '7 RACES' });
  });

  it('a mask that broke a vault shows the NEAR it took and its breaks', () => {
    const earned = ((1086n * NEAR) / 1000n).toString();
    expect(forgedLines(made('kira', { races: 6 }), ran(6, 2, earned))).toMatchObject({ taken: '1.086', line: '2 BREAKS' });
    expect(forgedLines(made('kira', { races: 1 }), ran(1, 1, earned))).toMatchObject({ taken: '1.086', line: '1 BREAK' });
    // A break the arena has not counted any NEAR for yet: the break, and no sum of nothing.
    expect(forgedLines(made('kira', { races: 1 }), ran(1, 1, '0'))).toMatchObject({ taken: null, line: '1 BREAK' });
  });

  it('calls no mask ready that cannot race now: a paused one, one out of fuel, one in its first race', () => {
    expect(forgedLines(made('kira', { state: 'paused' }), null).line).toBe('BUILT TO BREAK VAULTS');
    expect(forgedLines(made('kira', { brain: '0' }), null).line).toBe('BUILT TO BREAK VAULTS');
    const racing = made('kira', { state: 'racing', race: { race: 'human-0001', held: '1', armed_ns: '1', keys: [] } });
    expect(forgedLines(racing, null).line).toBe('IN ITS FIRST RACE');
  });

  it('names the mind and the style as the page does, and a model outside the catalog without its maker', () => {
    expect(forgedLines(made('kira', { model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', style: 'cunning' }), null).mind).toBe('Mind: DeepSeek V4.1 Flash · Cunning');
    expect(forgedLines(made('kira', { model: 'acme/Tiny-9', style: 'bold' }), null).mind).toBe('Mind: Tiny-9 · Bold');
  });

  it('says nothing technical: no account, no model id, no network', () => {
    const l = forgedLines(made('dmytro'), ran(4, 1, NEAR.toString()));
    expect(Object.values(l).join(' ')).not.toMatch(/\.near|\.testnet|\/|mainnet|testnet|TEE|0x/i);
  });

  it('fits every name of 3 to 16 characters: a short one wide and huge, a long one narrow first, then smaller', async () => {
    expect(await nameFit('zed')).toEqual({ font: 'word', size: 148 });
    const six = await nameFit('dmytro');
    expect(six.font).toBe('word');
    expect(six.size).toBeGreaterThanOrEqual(96);
    expect((await nameFit('kestrel8')).font).toBe('word');
    expect((await nameFit('kestrel88')).font).toBe('narrow');
    const long = await nameFit('nightshiftbandit');
    expect(long.font).toBe('narrow');
    expect(long.size).toBeGreaterThanOrEqual(56);
    // The widest a name can be: sixteen W. Still whole, still above the smallest type a card may carry.
    const widest = await nameFit('w'.repeat(16));
    expect(widest.font).toBe('narrow');
    expect(widest.size).toBeGreaterThanOrEqual(36);
  });
});

describe('a card that cannot be drawn', () => {
  it('gives way before anything is sent: an error, a failed answer, an empty picture, one that breaks halfway', async () => {
    expect(await drawn(() => Promise.reject(new Error('no font')))).toBeNull();
    expect(await drawn(async () => new Response('x', { status: 500 }))).toBeNull();
    expect(await drawn(async () => new Response(new ArrayBuffer(0)))).toBeNull();
    const stream = new ReadableStream({ start: (c) => c.error(new Error('broke halfway')) });
    expect(await drawn(async () => new Response(stream))).toBeNull();
  });

  it('a card that draws is sent whole, with its own type and edge cache', async () => {
    const res = await drawn(() => forgedCard(made('dmytro'), null));
    expect(res).not.toBeNull();
    const p = await png('forged-drawn', res!);
    expect(p).toEqual({ width: 1200, height: 630, cache: CACHE.mask });
  }, 20_000);
});

describe('cards', () => {
  it.each([
    ['race-0003', () => raceCard(race('race-0003')), CACHE.settled],
    ['race-0002', () => raceCard(race('race-0002')), CACHE.settled],
    ['race-0001', () => raceCard(race('race-0001')), CACHE.settled],
    ['race-live', () => raceCard(racing()), CACHE.live],
    ['race-sealing', () => raceCard(sealing()), CACHE.live],
    ['mask-nova', () => maskCard(league.find((m) => m.who.slug === 'nova')!, 1, 'testnet'), CACHE.mask],
    ['mask-onyx', () => maskCard(league.find((m) => m.who.slug === 'onyx')!, 2, 'testnet'), CACHE.mask],
    ['mask-forged', () => maskCard(forged('kestrel'), 4, 'testnet'), CACHE.mask],
    ['mask-forged-long', () => maskCard(forged('nightshiftbandit'), 5, 'testnet'), CACHE.mask],
    ['forged-dmytro', () => forgedCard(made('dmytro'), null), CACHE.mask],
    ['forged-long', () => forgedCard(made('nightshiftbandit', { look: 'graphite', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', style: 'cunning', races: 3 }), ran(3, 0)), CACHE.mask],
    ['forged-winner', () => forgedCard(made('kira', { look: 'crimson', style: 'bold', races: 6 }), ran(6, 2, ((1086n * NEAR) / 1000n).toString())), CACHE.mask],
    ['forged-widest', () => forgedCard(made('w'.repeat(16), { look: 'graphite', style: 'patient', races: 12 }), ran(12, 11, (123n * NEAR).toString())), CACHE.mask],
    ['forged-short', () => forgedCard(made('zed', { look: 'crimson', model: 'z-ai/glm-5.3-flash', style: 'patient' }), null), CACHE.mask],
    ['forged-no-frame', () => forgedCard(made('kestrel', { look: 'obsidian' }), null), CACHE.mask],
    ['forged-first-race', () => forgedCard(made('kestrel8', { state: 'racing', race: { race: 'human-0001', held: '1', armed_ns: '1', keys: [] } }), null), CACHE.mask],
    ['forged-paused', () => forgedCard(made('kestrel88', { look: 'crimson', state: 'paused' }), null), CACHE.mask],
    ['forged-arena-silent', () => forgedCard(made('kira', { races: 2 }), null, CACHE.silent), CACHE.silent],
    ['silent', () => arenaCard(), CACHE.silent],
    ['race-unknown', () => raceCard(null), CACHE.silent],
  ] as const)('%s: a 1200×630 PNG with its own edge cache', async (name, make, cache) => {
    const p = await png(name, await make());
    expect(p).toEqual({ width: 1200, height: 630, cache });
  }, 20_000);
});

describe('share tags', () => {
  it('a race and a mask point at their own card, described by the page line, addressed by what it says', () => {
    const c = cardOf('/race/race-0003', 'NOVA broke it in 8:13 and took 1.086 NEAR.');
    expect(c).toMatchObject({ url: `/race/race-0003/opengraph-image?v=${tag('NOVA broke it in 8:13 and took 1.086 NEAR.')}`, width: 1200, height: 630, alt: 'NOVA broke it in 8:13 and took 1.086 NEAR.' });
    expect(cardOf('/race/race-0003', '1.086 NEAR on the line.').url).not.toBe(c.url);
    expect(cardOf('/mask/nova', 'x').url).toMatch(/^\/mask\/nova\/opengraph-image\?v=[0-9a-z]+$/);
  });

  it('every other page keeps the arena card', () => {
    for (const p of ['/', '/league', '/break', '/race', '/mask/nova/extra']) expect(cardOf(p, 'x').url).toBe('/og.jpg');
  });
});

describe('the call card', () => {
  it('a call shared on X is a 16:9 picture: the verdict, how the round ended, every number from the chain', async () => {
    const { callCard, callLines, CALL_SIZE } = await import('./card');
    const r = race('race-0003');
    const nova = r.winner!.account;
    const right = callLines(r, { race: r.id, choice: nova, streak: 3 });
    expect(right).toMatchObject({ verdict: 'CALLED IT', right: true, head: 'NOVA BROKE IT', amount: '1.086', sub: 'IN 8:13', streak: '3 IN A ROW' });
    const wrong = callLines(r, { race: r.id, choice: 'held', streak: null });
    expect(wrong).toMatchObject({ verdict: 'RUN IT BACK', right: false, head: 'PICKED THE VAULT TO HOLD', amount: '1.086', sub: 'NOVA BROKE IT IN 8:13', streak: null });
    const res = await callCard(r, { race: r.id, choice: nova, streak: 3 });
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.readUInt32BE(16)).toBe(CALL_SIZE.width);
    expect(png.readUInt32BE(20)).toBe(CALL_SIZE.height);
    expect(CALL_SIZE.width / CALL_SIZE.height).toBeCloseTo(16 / 9);
    if (process.env.CARD_SHOTS) writeFileSync(join(process.env.CARD_SHOTS, 'call-right.png'), png);
  });
});
