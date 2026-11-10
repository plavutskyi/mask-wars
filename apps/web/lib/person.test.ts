import { describe, expect, it } from 'vitest';
import { shareText, stateOf } from './person';

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

describe('the author’s share in words', () => {
  it('reads basis points as a percent', () => {
    expect(shareText(3000)).toBe('30%');
    expect(shareText(1250)).toBe('12.5%');
    expect(shareText(500)).toBe('5%');
    expect(shareText(2550)).toBe('25.5%');
  });
});
