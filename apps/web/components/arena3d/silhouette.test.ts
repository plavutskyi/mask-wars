import { describe, expect, it } from 'vitest';
import { EYE, MASK_ASPECT, OUTLINE, type Pt, uvOf } from './silhouette';

const inside = ([x, y]: Pt, poly: readonly Pt[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

describe('the mask in the outline of the frames', () => {
  it('is one closed, mirrored outline from the ear tips to the points of the chin', () => {
    for (const [x, y] of OUTLINE) expect(OUTLINE.some(([u, v]) => Math.abs(u + x) < 1e-9 && v === y)).toBe(true);
    const ys = OUTLINE.map(([, y]) => y);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(1);
    // The frames' masks: a little under two thirds as wide as they are tall.
    expect(MASK_ASPECT).toBeGreaterThan(0.6);
    expect(MASK_ASPECT).toBeLessThan(0.66);
  });

  it('keeps the eye slits on the face', () => {
    for (const p of [EYE.outer, EYE.inner]) {
      expect(inside(p, OUTLINE)).toBe(true);
      expect(inside([-p[0], p[1]], OUTLINE)).toBe(true);
    }
  });

  it('finds every point of the outline inside the uploaded crop of its frame', () => {
    for (const p of OUTLINE) {
      const [u, v] = uvOf(p);
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });
});
