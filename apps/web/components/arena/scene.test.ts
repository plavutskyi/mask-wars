import { readFileSync } from 'node:fs';
import { Arena, Indexer, RPCS, type Race, type RaceEvent } from '@maskwars/arena';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';
import { beforeAll, describe, expect, it } from 'vitest';
import { money, offStage, sceneOf, stageCast } from './scene';

// The race the home page shows today, as testnet answered on 7.11.2026: NOVA broke safe-0001 in 8:13 and took 1.086 NEAR.
const recording = JSON.parse(readFileSync(new URL('../../../../packages/arena/test/fixtures/testnet.json', import.meta.url), 'utf8')) as Recording;
let race3: Race;

beforeAll(async () => {
  const fetch = replayFetch(recording);
  const arena = new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer: new Indexer({ fetch }), now: () => recording.recordedAt });
  race3 = (await arena.race('race-0003'))!;
});

const move = (who: Race['masks'][number], at: number): RaceEvent => ({ kind: 'move', at, tx: `T${at}`, who, amount: null, ok: true, method: 'set_owner' });

describe('the arena plays the race the chain shows', () => {
  it('replays the break of race-0003 and lands on the payout with the same numbers as the rest of the site', () => {
    const scene = sceneOf(race3)!;
    expect(scene.rest).toBe('paid');
    expect(scene.intro).toEqual(['idle', 'breach', 'paid']);
    // Ember corner left, Violet right: ONYX, ORACLE, NOVA.
    expect(scene.masks.map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(scene.winner).toBe(2);
    expect(scene.vault).toEqual({ amount: 1.086, unit: 'NEAR', text: '1.086' });
    expect(scene.payout?.text).toBe('1.086');
    expect(scene.lines.breach).toBe('Broken in 8:13');
    expect(scene.lines.paid).toBe('Broken in 8:13');
    expect(scene.lines.idle).toBe('SAFE-0001');
    // NOVA's two calls on the safe: set_owner, then the sweep that drained it.
    expect(scene.attempts).toEqual([0, 0, 2]);
  });

  it('stops at the break while the payout is still on its way', () => {
    const scene = sceneOf({ ...race3, payout: null, state: 'judging' })!;
    expect(scene.rest).toBe('breach');
    expect(scene.intro).toEqual(['idle', 'breach']);
    expect(scene.payout).toBeNull();
  });

  it('keeps the masks in the dark while the round seals, with the sum on the vault', () => {
    const scene = sceneOf({ ...race3, phase: 'sealing', winner: null, payout: null, prize: '3100000000000000000000000', events: [] })!;
    expect(scene.rest).toBe('idle');
    expect(scene.intro).toEqual(['idle']);
    expect(scene.vault?.text).toBe('3.1');
    expect(scene.winner).toBeNull();
    expect(scene.lines.idle).toBe('SAFE-0001');
  });

  it('counts every call a mask makes on the safe while the race runs', () => {
    const [nova, onyx] = race3.masks;
    const scene = sceneOf({ ...race3, phase: 'racing', winner: null, payout: null, events: [move(onyx!, 1), move(onyx!, 2), move(nova!, 3)] })!;
    expect(scene.rest).toBe('live');
    expect(scene.attempts).toEqual([2, 0, 1]);
    expect(scene.lines.live).toBe('SAFE-0001');
  });

  it('slams the bolts of a held vault and says so in its door, with no sum and no notes under the masks', () => {
    const scene = sceneOf({ ...race3, phase: 'held', winner: null, payout: null, refund: { amount: '100000000000000000000000', at: 1, tx: 'R' } })!;
    expect(scene.rest).toBe('held');
    expect(scene.intro).toEqual(['idle', 'held']);
    expect(scene.vault).toBeNull();
    expect(scene.headlines.held).toBe('Vault held');
    expect(scene.lines.held).toBe('Nobody got through');
    expect(scene.notes).toBeNull();
  });

  it('names a season round by its number, never by its id or the safe account', () => {
    const season = 'season.tinygif8324.testnet';
    const round = { ...race3, id: 's1-0002-7c41e9', season, team: season, target: `s0002.${season}`, phase: 'sealing' as const, winner: null, payout: null, events: [] };
    const scene = sceneOf(round)!;
    expect(scene.lines.idle).toBe('Round 2');
    expect(scene.account).toBe(false);
    // Another team's safe has no name of ours: its account, marked as one and cut to fit the door.
    const guest = sceneOf({ ...round, id: 'race-0007', target: 'safe-0001.someone-with-a-long-name.testnet' })!;
    expect(guest.account).toBe(true);
    expect(guest.lines.idle!.length).toBeLessThanOrEqual(26);
  });

  it('says under each mask what it has done while the round runs', () => {
    const [nova, onyx, oracle] = race3.masks;
    const seal = (who: Race['masks'][number], seq: number): RaceEvent => ({ kind: 'seal', at: seq + 1, tx: `S${seq}`, who, amount: null, ok: true, seq });
    const reveal = (who: Race['masks'][number], at: number): RaceEvent => ({ kind: 'reveal', at, tx: `V${at}`, who, amount: null, ok: true });
    const sealing = sceneOf({ ...race3, phase: 'sealing', winner: null, payout: null, events: [seal(onyx!, 0), seal(nova!, 1)] })!;
    // Stage order: ONYX, ORACLE, NOVA.
    expect(sealing.notes).toEqual(['Sealed #1', 'In the race', 'Sealed #2']);
    const racing = sceneOf({ ...race3, phase: 'racing', winner: null, payout: null, events: [seal(onyx!, 0), seal(nova!, 1), seal(oracle!, 2), move(onyx!, 5), move(onyx!, 6), reveal(onyx!, 7), move(nova!, 8)] })!;
    expect(racing.notes).toEqual(['Plan shown', 'Sealed #3', '1 try']);
  });

  it('shows a closed vault with no sum when there is no race, and says why', () => {
    expect(sceneOf(null)).toMatchObject({ rest: 'idle', vault: null, headlines: { idle: 'No race yet' } });
    expect(sceneOf(null, true)?.headlines.idle).toBe('The chain is not answering');
    expect(sceneOf(null)?.masks.map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
  });

  it('stands the same masks in the same order on the flat stage and in 3D', () => {
    expect(stageCast(race3).map((m) => m.name)).toEqual(sceneOf(race3)!.masks.map((m) => m.name));
    expect(stageCast(null).map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(stageCast({ ...race3, masks: race3.masks.slice(0, 2) }).map((m) => m.name)).toEqual(['ONYX', 'NOVA']);
  });

  it('keeps the winner and the hardest workers of a bigger field, and leaves a field of two to the flat stage', () => {
    const extra = { account: 'volt.example.testnet', slug: 'volt', name: 'VOLT', mask: true, model: null };
    const field = sceneOf({ ...race3, masks: [...race3.masks, extra], events: [...race3.events, move(extra, 9), move(race3.masks[1]!, 10)] })!;
    expect(field.masks.map((m) => m.name).sort()).toEqual(['NOVA', 'ONYX', 'VOLT']);
    expect(field.masks[field.winner!]!.name).toBe('NOVA');
    expect(sceneOf({ ...race3, masks: race3.masks.slice(0, 2) })).toBeNull();
  });

  it('keeps the arena’s three on the stage for the whole round while a guest races beside them, harder or not', () => {
    const dmytro = { account: 'dmytro.masks.tinygif8324.testnet', slug: 'dmytro', name: 'DMYTRO', mask: true, model: null };
    const [nova] = race3.masks;
    const racing = { ...race3, phase: 'racing' as const, winner: null, payout: null, masks: [...race3.masks, dmytro], events: [move(dmytro, 1), move(dmytro, 2), move(dmytro, 3), move(nova!, 4)] };
    expect(stageCast(racing).map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(offStage(racing.masks, stageCast(racing)).map((m) => m.name)).toEqual(['DMYTRO']);
    expect(sceneOf(racing)!.masks.map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
  });

  it('stands a guest that broke the vault on the stage in the look it was forged with, under its own name, and pays it there', () => {
    const dmytro = { account: 'dmytro.masks.tinygif8324.testnet', slug: 'dmytro', name: 'DMYTRO', mask: true, model: null };
    const [nova] = race3.masks;
    const won = { ...race3, masks: [...race3.masks, dmytro], winner: dmytro, events: [move(nova!, 1), move(dmytro, 2), { ...move(dmytro, 3), kind: 'drain' as const }] };
    const faces = { [dmytro.account]: { art: '/art/wraith.webp', tone: 'ice' as const } };
    const scene = sceneOf(won, false, faces)!;
    // Its look's eyes are Ice: the middle corner. NOVA tried once, so ORACLE gives up its place, not ONYX.
    expect(scene.masks.map((m) => m.name)).toEqual(['ONYX', 'DMYTRO', 'NOVA']);
    expect(scene.winner).toBe(1);
    // Built as the catalog's porcelain mask is, never as one of the arena's three.
    expect(scene.masks[1]).toEqual({ id: 'wraith', name: 'DMYTRO' });
    expect(scene.rest).toBe('paid');
    expect(offStage(won.masks, stageCast(won, faces)).map((m) => m.name)).toEqual(['ORACLE']);
    // With no face from the factory it is a mask of no look of ours: the default one, not a mask of the arena.
    expect(sceneOf(won)!.masks.find((m) => m.name === 'DMYTRO')?.id).toBe('dmytro');
  });

  it('writes NEAR as near() does: never rounded up', () => {
    expect(money('1086640000000000000000000')).toEqual({ amount: 1.086, unit: 'NEAR', text: '1.086' });
    expect(money('1234500000000000000000000000')).toEqual({ amount: 1234, unit: 'NEAR', text: '1,234' });
  });
});

describe('the next round on the stage', () => {
  it('stands its first three masks in their corners, its sum on the vault and when it opens under it', async () => {
    const { nextScene, nextCast } = await import('./scene');
    const who = (name: string) => ({ account: `${name.toLowerCase()}.maskwars.near`, slug: name.toLowerCase(), name, mask: true, model: null });
    const next = { season: 'house.maskwars.near', at: Date.UTC(2026, 10, 12, 18, 4), n: 2, target: 'live-safe', targetCode: 'x', inSafe: '1', locked: '1', prize: '1850000000000000000000000', minLoot: '1', masks: [who('NOVA'), who('ONYX'), who('ORACLE'), who('KIRA')], sealMinutes: 45, hours: 4, funded: true };
    expect(nextCast(next).map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    const s = nextScene(next)!;
    expect(s.rest).toBe('idle');
    expect(s.vault?.text).toBe('1.85');
    expect(s.lines.idle).toBe('Opens 18:04 UTC');
    expect(nextScene({ ...next, masks: next.masks.slice(0, 2) })).toBeNull();
  });
});
