// The frame is composed on screen first, the way the page is, then the 3D world is placed to match it.
// So the vault, the sum and the three masks land where the layout says on any screen, and the camera
// still sees real depth: the masks stand nearer than the vault and move against it when the camera drifts.
// Pure math, no three.js: the poster, the HUD and the engine share it.

import { MASK_ASPECT } from './silhouette';
import type { Anchors, MaskAnchor } from './types';

export interface Frame {
  /** Arena box, px. */
  w: number;
  h: number;
  /** Space the page keeps for its own interface, px. */
  top?: number;
  bottom?: number;
}

export interface WorldMask {
  x: number;
  /** Centre height above the floor. */
  y: number;
  z: number;
  /** Height of the mask. */
  size: number;
  yaw: number;
  pitch: number;
}

export interface Composition {
  w: number;
  h: number;
  portrait: boolean;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Lens shift for `camera.setViewOffset`, px: puts the horizon where the frame wants it. */
  offsetY: number;
  camera: { x: number; y: number; z: number };
  /** Vault centre; its radius is VAULT_R. */
  vault: { x: number; y: number; z: number };
  masks: readonly [WorldMask, WorldMask, WorldMask];
  /** Screen anchors at rest. */
  anchors: Anchors;
  /** Horizon line on screen, px from the top. */
  horizon: number;
  /** How far each door half may slide when the vault breaks, world units: never off the screen. */
  split: number;
}

/** Vault radius in world units, frame ring included. Everything else is measured against it. */
export const VAULT_R = 1;
/** The door sits inside the frame ring. */
export const DOOR_R = 0.84;

/** BRANDBOOK §7: the horizon at 62 % of the frame. */
const HORIZON = 0.62;

export function compose(frame: Frame): Composition {
  const w = Math.max(1, frame.w);
  const h = Math.max(1, frame.h);
  const top = Math.max(0, frame.top ?? 0);
  const bottom = Math.max(0, frame.bottom ?? 0);
  const avail = Math.max(120, h - top - bottom);
  // Same test as the CSS container query: the whole box, insets included.
  const portrait = w / h < 0.9;

  const horizon = top + HORIZON * avail;

  // The vault: the one object. As big as the frame allows with the masks under it; the phone gives it the width.
  const D = portrait ? Math.min(0.86 * w, 0.5 * avail, 440) : Math.min(0.56 * avail, 0.5 * w, 560);
  const vy = horizon - D / 2 - 0.02 * avail;

  // The masks: a shallow arc in front, below the horizon, never over the vault.
  const gap = 0.05 * avail;
  // Under the horizon the mask and its name must fit: a short landscape screen gets a smaller mask.
  const below = (1 - HORIZON) * avail - gap - 40;
  const hm = Math.min(portrait ? Math.min(0.38 * w, 0.24 * avail) : Math.min(0.24 * avail, 0.15 * w, 250), below);
  const my = horizon + gap + hm / 2;
  const sx = portrait ? 0.31 * w : Math.min(0.26 * w, 2.9 * hm);
  const sideLift = 0.02 * avail;
  const sideScale = 0.93;

  // Camera: level, so verticals stay vertical; a lens shift puts the horizon at 62 %.
  const fov = portrait ? 40 : 30;
  const f = h / 2 / Math.tan((fov * Math.PI) / 360);
  const offsetY = h / 2 - horizon;

  const dv = (f * 2 * VAULT_R) / D;
  // The masks stand at ~62 % of the vault's distance; that sets the camera height (the world's scale).
  const hover = 0.75;
  const dm = 0.62 * dv;
  const c = (dm * (my - horizon + hover * hm)) / f;

  const place = (x: number, y: number, size: number): WorldMask => {
    const d = (f * c) / (y - horizon + hover * size);
    const s = (size * d) / f;
    const wx = ((x - w / 2) * d) / f;
    const wy = hover * s;
    return {
      x: wx,
      y: wy,
      z: dv - d,
      size: s,
      yaw: wx === 0 ? 0 : -Math.sign(wx) * 0.2,
      pitch: -Math.atan2(c - wy, d) * 0.8,
    };
  };

  const sides = hm * sideScale;
  const masks = [place(w / 2 - sx, my - sideLift, sides), place(w / 2, my, hm), place(w / 2 + sx, my - sideLift, sides)] as const;

  const anchor = (x: number, y: number, size: number): MaskAnchor => ({
    x,
    top: y - size / 2,
    bottom: y + size / 2,
    half: (size * MASK_ASPECT) / 2,
  });

  const vh = c + ((horizon - vy) * dv) / f;

  return {
    w,
    h,
    portrait,
    fov,
    offsetY,
    camera: { x: 0, y: c, z: dv },
    vault: { x: 0, y: vh, z: 0 },
    masks,
    horizon,
    split: Math.min(0.62, Math.max(0.22, ((w / 2 - 14) / (D / 2)) * VAULT_R - DOOR_R)),
    anchors: {
      vault: { x: w / 2, y: vy, r: (D / 2) * DOOR_R },
      lift: { x: w / 2, y: vy - D * 0.2 },
      masks: [anchor(w / 2 - sx, my - sideLift, sides), anchor(w / 2, my, hm), anchor(w / 2 + sx, my - sideLift, sides)],
    },
  };
}

/** Pinhole projection of a world point through the composed camera at rest, px. */
export function project(c: Composition, p: { x: number; y: number; z: number }): { x: number; y: number } {
  const f = c.h / 2 / Math.tan((c.fov * Math.PI) / 360);
  const d = c.camera.z - p.z;
  return { x: c.w / 2 + (f * (p.x - c.camera.x)) / d, y: c.horizon - (f * (p.y - c.camera.y)) / d };
}
