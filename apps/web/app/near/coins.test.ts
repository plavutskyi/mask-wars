import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LISTED, NETWORKS } from '@maskwars/pay';

// Every coin and network the pages show has its real logo on disk, small and clean, with its source and licence written
// down. A coin added to packages/pay/src/listed.ts without one fails here.
const PUBLIC = new URL('../../public/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, PUBLIC));
const sources = read('coins/SOURCES.md').toString('utf8');

/** What a logo file must be: a small square SVG with nothing raster or scripted inside, or a small square PNG. */
function checkLogo(path: string) {
  expect(existsSync(new URL(path, PUBLIC)), path).toBe(true);
  const bytes = read(path);
  if (path.endsWith('.svg')) {
    const svg = bytes.toString('utf8');
    expect(svg.startsWith('<svg'), path).toBe(true);
    const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
    expect(box && box[1] === box[2], `${path} has a square viewBox`).toBe(true);
    expect(svg, path).not.toMatch(/<image|base64|<script|\son\w+=|xlink:href="http|href="http/i);
    expect(bytes.length, path).toBeLessThan(32_000);
  } else {
    expect(path, 'only SVG or PNG').toMatch(/\.png$/);
    expect(bytes.subarray(1, 4).toString('ascii'), path).toBe('PNG');
    const w = bytes.readUInt32BE(16);
    const h = bytes.readUInt32BE(20);
    expect(w, `${path} is square`).toBe(h);
    expect(w, path).toBeGreaterThanOrEqual(80);
    expect(bytes.length, path).toBeLessThan(32_000);
  }
}

describe('logos', () => {
  it('has a real logo for every listed coin', () => {
    for (const l of LISTED) checkLogo(`coins/${l.logo}`);
  });

  it('has a logo for every listed network', () => {
    for (const n of NETWORKS) checkLogo(`chains/${n.id}.svg`);
  });

  it('writes down where every logo file comes from and under which licence', () => {
    for (const dir of ['coins', 'chains']) {
      for (const f of readdirSync(new URL(`${dir}/`, PUBLIC)).filter((x) => /\.(svg|png)$/.test(x))) {
        expect(sources, `${dir}/${f}`).toContain(`\`${dir}/${f}\``);
      }
    }
  });

  it('keeps no logo nobody uses', () => {
    const used = new Set([...LISTED.map((l) => `coins/${l.logo}`), ...NETWORKS.map((n) => `chains/${n.id}.svg`)]);
    for (const dir of ['coins', 'chains']) {
      for (const f of readdirSync(new URL(`${dir}/`, PUBLIC)).filter((x) => /\.(svg|png)$/.test(x))) expect(used.has(`${dir}/${f}`), `${dir}/${f}`).toBe(true);
    }
  });
});
