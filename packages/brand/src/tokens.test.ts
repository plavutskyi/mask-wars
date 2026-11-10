import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { color, cssVars, tokensCss } from './tokens.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const vars = (css: string) =>
  Object.fromEntries([...css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim().toLowerCase()]));

describe('tokens', () => {
  it('generated tokens.css is up to date', () => {
    expect(read('../tokens.css')).toBe(tokensCss());
  });

  it('matches every colour and the radius in brand/tokens.css', () => {
    const source = vars(read('../../../brand/tokens.css'));
    const ours = Object.fromEntries(cssVars);
    for (const [k, v] of Object.entries(source)) {
      if (k.startsWith('--font')) continue;
      expect(ours[k], k).toBe(v);
    }
    expect(Object.keys(color).length).toBe(Object.keys(source).filter((k) => !k.startsWith('--font') && k !== '--radius').length);
  });
});
