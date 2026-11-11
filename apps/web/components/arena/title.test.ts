import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { metrics } from '../../lib/ttf';
import { ADVANCE, titleEm } from './title';

const wide = metrics(readFileSync(resolve(__dirname, '../../../../packages/brand/fonts/hubot-sans-800-wdth125.ttf')));

describe('how wide a mask’s name stands on its page', () => {
  it('holds the advance of every character a name can hold, as the brand’s font file has it', () => {
    expect(wide.unitsPerEm).toBe(1000);
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_ ') expect(ADVANCE[ch], ch).toBe(wide.advance(ch));
  });

  it('is the sum of the letters and the space `.word` sets between them', () => {
    expect(titleEm('ORACLE')).toBeCloseTo(5.43);
    expect(titleEm('NOVA')).toBeCloseTo(3.948);
    expect(titleEm('ONYX')).toBeCloseTo(3.909);
  });

  it('reads a name in upper case, the way the page draws it', () => {
    expect(titleEm('oracle')).toBe(titleEm('ORACLE'));
    expect(titleEm('kira7')).toBe(titleEm('KIRA7'));
  });

  it('tells a wide name from a narrow one of the same length', () => {
    expect(titleEm('WRAITH')).toBeGreaterThan(titleEm('ORACLE'));
    expect(titleEm('MAMMOTH')).toBeGreaterThan(titleEm('JILL111'));
  });

  it('never takes an unknown character for a narrow one', () => {
    expect(titleEm('Ж')).toBe(titleEm('W'));
    for (const ch of Object.keys(ADVANCE)) expect(titleEm(ch), ch).toBeLessThanOrEqual(titleEm('W'));
  });
});
