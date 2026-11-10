import { describe, expect, it } from 'vitest';
import { digits, spoken, unitWord } from './format';

describe('money on the vault', () => {
  it('keeps real NEAR amounts as they are', () => {
    expect(digits({ amount: 3, unit: 'NEAR' })).toBe('3');
    expect(digits({ amount: 2.5, unit: 'NEAR' })).toBe('2.5');
    expect(digits({ amount: 0.08664, unit: 'NEAR' })).toBe('0.08664');
    expect(digits({ amount: 1, unit: 'NEAR' })).toBe('1');
    expect(digits({ amount: 0, unit: 'NEAR' })).toBe('0');
  });

  it('groups thousands and keeps four significant digits below them', () => {
    expect(digits({ amount: 1250, unit: 'NEAR' })).toBe('1,250');
    expect(digits({ amount: 12.3456, unit: 'NEAR' })).toBe('12.35');
  });

  it('writes dollars whole, with the sign', () => {
    expect(digits({ amount: 15000, unit: 'USD' })).toBe('$15,000');
    expect(unitWord({ amount: 15000, unit: 'USD' })).toBeNull();
  });

  it('writes the page’s own digits when it brings them: a race never shows more than was paid', () => {
    // 1.08664 NEAR rounds up to 1.087 by precision; the arena writes 1.086, as near() does everywhere else.
    expect(digits({ amount: 1.08664, unit: 'NEAR', text: '1.086' })).toBe('1.086');
    expect(spoken({ amount: 1.08664, unit: 'NEAR', text: '1.086' })).toBe('1.086 NEAR');
    expect(digits({ amount: 15000, unit: 'USD', text: '15,000' })).toBe('$15,000');
  });

  it('reads out the unit', () => {
    expect(spoken({ amount: 3, unit: 'NEAR' })).toBe('3 NEAR');
    expect(spoken({ amount: 25000, unit: 'USD' })).toBe('$25,000');
  });
});
