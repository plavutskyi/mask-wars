import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineWidth, metrics } from './ttf';

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
