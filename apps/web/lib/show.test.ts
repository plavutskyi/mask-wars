import { describe, expect, it } from 'vitest';
import { faceOf, targetName, timeUtc, toneIn } from './show';

describe('timeUtc', () => {
  it('says when a reading was taken, in UTC to the minute', () => {
    expect(timeUtc(Date.UTC(2026, 10, 11, 13, 0, 59))).toBe('13:00 UTC');
    expect(timeUtc(Date.UTC(2026, 10, 11, 23, 59, 0))).toBe('23:59 UTC');
  });
});

describe('targetName', () => {
  it('names the arena team’s safe SAFE-0001', () => {
    expect(targetName({ kind: 'safe', target: 'safe-0001.tinygif8324.testnet' })).toBe('SAFE-0001');
  });

  it('names the season treasury’s safe the same way', () => {
    expect(targetName({ kind: 'safe', target: 'safe-0042.season.tinygif8324.testnet' })).toBe('SAFE-0042');
  });

  it('keeps another team’s safe as its whole account', () => {
    expect(targetName({ kind: 'safe', target: 'safe-0001.someone.testnet' })).toBe('safe-0001.someone.testnet');
    // A sub-account of a team account is not the team: only the team itself can name its safes.
    expect(targetName({ kind: 'safe', target: 'safe-0001.evil.tinygif8324.testnet' })).toBe('safe-0001.evil.tinygif8324.testnet');
    expect(targetName({ kind: 'safe', target: 'vault.tinygif8324.testnet' })).toBe('vault.tinygif8324.testnet');
  });

  it('keeps a training target’s name', () => {
    expect(targetName({ kind: 'sandbox', target: 'open-admin' })).toBe('OPEN-ADMIN');
  });
});

describe('a mask’s face and colour on the stage', () => {
  const NOVA = { account: 'nova.maskwars.near', slug: 'nova', name: 'NOVA', mask: true, model: null };
  const DMYTRO = { account: 'dmytro.masks.maskwars.near', slug: 'dmytro', name: 'DMYTRO', mask: true, model: null };
  const faces = {
    [DMYTRO.account]: { art: '/art/ronin.webp', tone: 'ember' as const },
    // A face the factory claims for one of the arena's masks never covers the arena's own.
    [NOVA.account]: { art: '/art/wraith.webp', tone: 'ice' as const },
  };

  it('the arena’s mask keeps its own art and colour', () => {
    expect(faceOf(NOVA, faces)).toBe('/art/nova.webp');
    expect(toneIn(NOVA, faces)).toBe('violet');
  });

  it('a forged mask wears its look’s art and colour; with none known, no art and the cold colour', () => {
    expect(faceOf(DMYTRO, faces)).toBe('/art/ronin.webp');
    expect(toneIn(DMYTRO, faces)).toBe('ember');
    expect(faceOf(DMYTRO, null)).toBeNull();
    expect(toneIn(DMYTRO, {})).toBe('ice');
    expect(faceOf(null, faces)).toBeNull();
  });
});
