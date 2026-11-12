import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineWidth, metrics, wordKern } from './ttf';

const font = (f: string) => metrics(readFileSync(resolve(__dirname, '../../../packages/brand/fonts', f)));

describe('advance widths from a TrueType file', () => {
  it('reads what HarfBuzz reads in the cards’ wide Hubot', () => {
    const m = font('hubot-sans-800-wdth125.ttf');
    expect(m.unitsPerEm).toBe(1000);
    expect(m.advance('A')).toBe(986);
    expect(m.advance('B')).toBe(871);
    expect(m.advance(' ')).toBe(194);
  });

  it('a line is the sum of its advances, plus letter spacing per letter', () => {
    const m = font('hubot-sans-800-wdth125.ttf');
    expect(lineWidth(m, 'A B', 100)).toBeCloseTo((986 + 194 + 871) / 10);
    expect(lineWidth(m, 'AB', 100, 0.05)).toBeCloseTo((986 + 871) / 10 + 2 * 5);
  });

  it('the narrow cut is narrower, and a character the font lacks takes .notdef', () => {
    const wide = font('hubot-sans-800-wdth125.ttf');
    const narrow = font('hubot-sans-800-wdth85.ttf');
    expect(narrow.advance('W')).toBeLessThan(wide.advance('W'));
    expect(wide.advance('Ж')).toBeGreaterThan(0);
  });
});

describe('kerning from a TrueType file', () => {
  it('reads the pairs of the cards’ wide Hubot: tight ones pull together, straight stems do not move', () => {
    const m = font('hubot-sans-800-wdth125.ttf');
    expect(m.kern('V', 'A')).toBe(-169);
    expect(m.kern('L', 'T')).toBe(-172);
    expect(m.kern('H', 'H')).toBe(0);
    expect(m.kern('Ж', 'A')).toBe(0);
  });

  it('a word gives back what its pairs take: VAULT ends well short of its bare advances, THE does not', () => {
    const m = font('hubot-sans-800-wdth125.ttf');
    expect(wordKern(m, 'VAULT', 1000)).toBe(m.kern('V', 'A') + m.kern('A', 'U') + m.kern('U', 'L') + m.kern('L', 'T'));
    expect(wordKern(m, 'VAULT', 1000)).toBe(-397);
    expect(wordKern(m, 'VAULT', 52)).toBeCloseTo(-397 * 0.052);
    expect(wordKern(m, 'THE', 1000)).toBe(0);
    expect(wordKern(m, 'A', 1000)).toBe(0);
  });

  it('counts no pair across a hyphen: what follows it is drawn as a piece of its own', () => {
    const m = font('hubot-sans-800-wdth125.ttf');
    expect(wordKern(m, 'V-A', 1000)).toBe(m.kern('V', '-'));
  });
});
