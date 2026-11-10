import { describe, expect, it } from 'vitest';
import { compose, DOOR_R, project, VAULT_R } from './layout';
import { MASK_ASPECT } from './silhouette';

const SCREENS: Array<[string, { w: number; h: number; top?: number; bottom?: number }]> = [
  ['desk 1440', { w: 1440, h: 900 }],
  ['desk 1440 with header and deck', { w: 1440, h: 900, top: 64, bottom: 136 }],
  ['desk 1920', { w: 1920, h: 1080 }],
  ['laptop 1280', { w: 1280, h: 720 }],
  ['wide 2560', { w: 2560, h: 1080 }],
  ['tablet', { w: 1096, h: 1206 }],
  ['tablet landscape', { w: 1024, h: 768 }],
  ['phone 375', { w: 375, h: 812 }],
  ['phone 375 short', { w: 375, h: 667 }],
  ['phone 375 with header and deck', { w: 375, h: 812, top: 64, bottom: 108 }],
  ['phone 360', { w: 360, h: 740 }],
  ['phone 430', { w: 430, h: 932 }],
  ['phone landscape', { w: 844, h: 390 }],
];

describe('compose', () => {
  for (const [name, frame] of SCREENS) {
    it(`${name}: vault and masks fit, never overlap`, () => {
      const c = compose(frame);
      const { vault, masks } = c.anchors;
      const R = vault.r / DOOR_R;
      const top = frame.top ?? 0;
      const bottom = frame.h - (frame.bottom ?? 0);

      // The vault sits whole inside the frame the page left free.
      expect(vault.y - R).toBeGreaterThanOrEqual(top);
      expect(vault.x - R).toBeGreaterThanOrEqual(0);
      expect(vault.x + R).toBeLessThanOrEqual(frame.w);

      for (const m of masks) {
        expect(m.x - m.half).toBeGreaterThanOrEqual(8);
        expect(m.x + m.half).toBeLessThanOrEqual(frame.w - 8);
        // Below the vault with air between them, and room for the caption under it.
        expect(m.top).toBeGreaterThan(vault.y + R + 4);
        expect(m.bottom + 40).toBeLessThanOrEqual(bottom);
      }
      // Side by side, never touching.
      expect(masks[0].x + masks[0].half).toBeLessThan(masks[1].x - masks[1].half);
      expect(masks[1].x + masks[1].half).toBeLessThan(masks[2].x - masks[2].half);
    });

    it(`${name}: the world matches the screen`, () => {
      const c = compose(frame);
      // Vault floats over the floor, masks stand in front of it and hover over the floor.
      expect(c.vault.y - VAULT_R).toBeGreaterThan(0);
      for (const [i, m] of c.masks.entries()) {
        expect(m.z).toBeGreaterThan(c.vault.z + 0.5);
        expect(m.z).toBeLessThan(c.camera.z - 1);
        expect(m.y - m.size / 2).toBeGreaterThan(0);
        const p = project(c, m);
        const a = c.anchors.masks[i]!;
        expect(Math.abs(p.x - a.x)).toBeLessThan(0.5);
        expect(Math.abs(p.y - (a.top + a.bottom) / 2)).toBeLessThan(0.5);
        expect(Math.abs((a.half * 2) / MASK_ASPECT - (a.bottom - a.top))).toBeLessThan(0.5);
      }
      const v = project(c, c.vault);
      expect(Math.abs(v.x - c.anchors.vault.x)).toBeLessThan(0.5);
      expect(Math.abs(v.y - c.anchors.vault.y)).toBeLessThan(0.5);
    });
  }
});
