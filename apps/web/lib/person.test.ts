import type { HistoryEvent } from '@maskwars/forge';
import { describe, expect, it } from 'vitest';
import { readableHistory, shareText, stateOf } from './person';

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
