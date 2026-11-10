import { describe, expect, it } from 'vitest';
import { twoLines } from '../arena3d/headline';
import { raceName, raceTitle, roundOf, stageName } from './names';

describe('what a race is called on screen', () => {
  it('reads a season round from its id', () => {
    expect(roundOf('s1-0002-7c41e9')).toEqual({ season: 1, round: 2 });
    expect(roundOf('s12-0140-00ab3f')).toEqual({ season: 12, round: 140 });
    expect(roundOf('race-0003')).toBeNull();
    expect(roundOf('human-0001')).toBeNull();
  });

  it('calls a season round by its number and a hand-opened race by its own', () => {
    expect(raceName('s1-0002-7c41e9')).toBe('Round 2');
    expect(raceTitle('s1-0002-7c41e9')).toBe('Season 1 · Round 2');
    expect(raceName('race-0003')).toBe('Race 0003');
    expect(raceTitle('race-0003')).toBe('Race 0003');
    expect(raceName('human-0001')).toBe('Race H0001');
  });

  it('never puts an account of ours under the sum', () => {
    const team = 'tinygif8324.testnet';
    expect(stageName({ id: 's1-0002-7c41e9', kind: 'safe', target: `s0002.season.${team}` })).toEqual({ text: 'Round 2', account: false });
    expect(stageName({ id: 'race-0003', kind: 'safe', target: `safe-0001.${team}` })).toEqual({ text: 'SAFE-0001', account: false });
    expect(stageName({ id: 'race-0001', kind: 'sandbox', target: 'open-admin' })).toEqual({ text: 'OPEN-ADMIN', account: false });
    const guest = stageName({ id: 'race-0009', kind: 'safe', target: 'safe-0001.someone.testnet' });
    expect(guest).toEqual({ text: 'safe-0001.someone.testnet', account: true });
  });
});

describe('the message in the door', () => {
  it('stays on one line while it is short and breaks near its middle when it is not', () => {
    expect(twoLines('Vault held')).toEqual(['Vault held']);
    expect(twoLines('No race yet')).toEqual(['No race yet']);
    expect(twoLines('The chain is not answering')).toEqual(['The chain is', 'not answering']);
  });
});
