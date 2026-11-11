// The share cards on the recorded testnet answers, the same reading the pages get, plus the states the recording has
// not lived through yet: a race in motion and masks with no frame. CARD_SHOTS=<dir> writes every card as a PNG.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MaskStats, Race } from '@maskwars/arena';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.ARENA_FIXTURE ??= resolve(__dirname, '../../../packages/arena/test/fixtures/testnet.json');

const { readArena } = await import('./arena');
const { arenaCard, CACHE, maskCard, modelName, raceCard, raceLines, settled } = await import('./card');
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
    expect(l).toMatchObject({ kicker: 'RACE 0003 · 6 NOV · TESTNET', amount: '1.086', tone: 'money', head: 'NOVA BROKE THE SAFE', sub: 'IN 8:13 · FIRST OF 3 MASKS', face: 'nova', vault: false });
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
    expect(raceLines(r)).toMatchObject({ amount: '1.086', tone: 'plain', head: 'THE SAFE IS OPEN', sub: '3 MASKS RACING · CLOSES 9 NOV 18:26 UTC' });
    expect(settled(r)).toBe(false);
    expect(raceLines(sealing())).toMatchObject({ head: 'MASKS ARE SEALING', sub: '3 MASKS IN · STARTS 18:36 UTC' });
  });

  it('names a model without its maker', () => {
    expect(modelName('deepseek-ai/DeepSeek-V4.1-Flash-1017')).toBe('DeepSeek-V4.1-Flash-1017');
    expect(modelName('local')).toBe('local');
  });
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
    expect(wrong).toMatchObject({ verdict: 'RUN IT BACK', right: false, head: 'PICKED THE SAFE TO HOLD', amount: '1.086', sub: 'NOVA BROKE IT IN 8:13', streak: null });
    const res = await callCard(r, { race: r.id, choice: nova, streak: 3 });
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.readUInt32BE(16)).toBe(CALL_SIZE.width);
    expect(png.readUInt32BE(20)).toBe(CALL_SIZE.height);
    expect(CALL_SIZE.width / CALL_SIZE.height).toBeCloseTo(16 / 9);
    if (process.env.CARD_SHOTS) writeFileSync(join(process.env.CARD_SHOTS, 'call-right.png'), png);
  });
});
