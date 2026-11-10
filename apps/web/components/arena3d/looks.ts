// Mask looks, BRANDBOOK §5: one silhouette + one material + one eye colour + one modifier.
// Colours come from the brand tokens; the only exception is Volt's lime, which §5 names by value.

import { color } from '@maskwars/brand';
import type { ArenaMaskLook } from './types';

export type Finish = NonNullable<ArenaMaskLook['finish']>;
export type Modifier = NonNullable<ArenaMaskLook['modifier']>;

export interface MaskLook {
  /** Shell colour, linear-ish sRGB hex: near black for all but Wraith and Ronin. */
  shell: string;
  finish: Finish;
  /** Edge trim: titanium, gold, steel. */
  trim: string;
  trimMetal: number;
  eyes: string;
  /** Where the white-hot core of the eyes leans; violet-white for Nova. */
  eyesCore: string;
  modifier: Modifier;
  /** Oracle's third eye. */
  thirdEye: boolean;
}

const TITANIUM = '#8e939e';
const GOLD = '#c99a45';
const STEEL = '#a7adb8';

const LOOKS: Record<string, MaskLook> = {
  // Matte obsidian, titanium faces, ember eyes.
  onyx: { shell: '#0b0a10', finish: 'matte', trim: TITANIUM, trimMetal: 1, eyes: color.ember, eyesCore: color.amber, modifier: 'none', thirdEye: false },
  // Black ceramic, violet-white eyes, thin light cracks.
  nova: { shell: '#08070d', finish: 'gloss', trim: '#5b5670', trimMetal: 0.6, eyes: color.violet, eyesCore: color.ice, modifier: 'cracks', thirdEye: false },
  // Black lacquer, straight gold seams, amber eyes, a third eye.
  oracle: { shell: '#060509', finish: 'lacquer', trim: GOLD, trimMetal: 1, eyes: color.amber, eyesCore: color.ice, modifier: 'seams', thirdEye: true },
  // Bone porcelain, ice eyes.
  wraith: { shell: '#b9b4a8', finish: 'porcelain', trim: '#d8d3c7', trimMetal: 0, eyes: color.ice, eyesCore: color.ice, modifier: 'none', thirdEye: false },
  // Crimson lacquer, steel brow, blood eyes.
  ronin: { shell: '#3a070b', finish: 'lacquer', trim: STEEL, trimMetal: 1, eyes: color.live, eyesCore: color.amber, modifier: 'brow', thirdEye: false },
  // Satin graphite, lime eyes, a stripe down the middle.
  volt: { shell: '#1a1b1f', finish: 'satin', trim: '#3a3c43', trimMetal: 0.8, eyes: '#c6ff3d', eyesCore: color.ice, modifier: 'stripe', thirdEye: false },
};

const DEFAULT: MaskLook = { shell: '#09080e', finish: 'gloss', trim: TITANIUM, trimMetal: 1, eyes: color.ice, eyesCore: color.ice, modifier: 'none', thirdEye: false };

/** The catalog's look for a mask, with a forged mask's own choices laid over it. */
export function lookOf(id: string, own?: ArenaMaskLook): MaskLook {
  const base = LOOKS[id.toLowerCase()] ?? DEFAULT;
  if (!own) return base;
  return {
    ...base,
    ...(own.finish ? { finish: own.finish } : {}),
    ...(own.eyes ? { eyes: own.eyes } : {}),
    ...(own.modifier ? { modifier: own.modifier } : {}),
  };
}

/** Same look, same key: the engine rebuilds a mask only when its look really changed. */
export const lookKey = (m: { id: string; look?: ArenaMaskLook | undefined }): string =>
  [m.id.toLowerCase(), m.look?.finish ?? '', m.look?.eyes ?? '', m.look?.modifier ?? ''].join('|');

/** The corner colours of the arena: left Ember, middle Ice, right Violet (BRANDBOOK §3, §6). */
export const CORNERS = [color.ember, color.ice, color.violet] as const;
