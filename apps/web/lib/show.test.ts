import { describe, expect, it } from 'vitest';
import { targetName } from './show';

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
