import { readFileSync } from 'node:fs';
import { Arena, Indexer, RPCS, type Race, type RaceEvent } from '@maskwars/arena';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';
import { beforeAll, describe, expect, it } from 'vitest';
import { money, sceneOf } from './scene';

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

  it('slams the bolts of a held vault and shows the bounty going back', () => {
    const scene = sceneOf({ ...race3, phase: 'held', winner: null, payout: null, refund: { amount: '100000000000000000000000', at: 1, tx: 'R' } })!;
    expect(scene.rest).toBe('held');
    expect(scene.intro).toEqual(['idle', 'held']);
    expect(scene.vault?.text).toBe('0.1');
    expect(scene.lines.held).toBe('Nobody got through');
  });

  it('shows a closed vault with no sum when there is no race, and says why', () => {
    expect(sceneOf(null)).toMatchObject({ rest: 'idle', vault: null, lines: { idle: 'No race yet' } });
    expect(sceneOf(null, true)?.lines.idle).toBe('The chain is not answering');
    expect(sceneOf(null)?.masks.map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
  });

  it('keeps the winner and the hardest workers of a bigger field, and leaves a field of two to the flat stage', () => {
    const extra = { account: 'volt.example.testnet', slug: 'volt', name: 'VOLT', mask: true, model: null };
    const field = sceneOf({ ...race3, masks: [...race3.masks, extra], events: [...race3.events, move(extra, 9), move(race3.masks[1]!, 10)] })!;
    expect(field.masks.map((m) => m.name).sort()).toEqual(['NOVA', 'ONYX', 'VOLT']);
    expect(field.masks[field.winner!]!.name).toBe('NOVA');
    expect(sceneOf({ ...race3, masks: race3.masks.slice(0, 2) })).toBeNull();
  });

  it('writes NEAR as near() does: never rounded up', () => {
    expect(money('1086640000000000000000000')).toEqual({ amount: 1.086, unit: 'NEAR', text: '1.086' });
    expect(money('1234500000000000000000000000')).toEqual({ amount: 1234, unit: 'NEAR', text: '1,234' });
  });
});
