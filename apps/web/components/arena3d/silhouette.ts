// The mask in 3D stands in the outline of the season's frames (`brand/art`, `/public/art/<mask>.webp`): all six are one
// template, so one outline fits every face. Measured on the frames themselves (1280², the mask 1060 px tall from
// y 55, its centre at x 644.5; BRANDBOOK §5 gives the same template at 2048²).
//
// Units: the mask's height is 1; x to the right of the centre, y down from the ear tips. Pure data, no three.js.

export type Pt = readonly [number, number];

/** Where the mask stands inside a frame, px. */
export const FRAME = { size: 1280, top: 55, height: 1060, cx: 644.5 } as const;

/** The part of a frame the engine uploads: the mask with a little black around it, 2:3. */
export const CROP = { x: 280, y: 38, w: 730, h: 1095 } as const;

/** The left half of the outline, clockwise from the bottom of the notch between the ears to the notch of the chin. */
const LEFT: readonly Pt[] = [
  // The notch between the ears, up its inner edge to the left ear tip.
  [0, 0.196],
  [-0.0401, 0.18],
  [-0.1245, 0.1],
  [-0.2307, 0],
  // Down the outer edge: widest at the cheekbone, then the long taper to the chin.
  [-0.2505, 0.05],
  [-0.2642, 0.1],
  [-0.2774, 0.15],
  [-0.291, 0.2],
  [-0.3052, 0.25],
  [-0.3165, 0.3],
  [-0.3189, 0.35],
  [-0.3099, 0.4],
  [-0.3019, 0.45],
  [-0.2877, 0.5],
  [-0.2745, 0.55],
  [-0.2608, 0.6],
  [-0.2462, 0.65],
  [-0.2349, 0.7],
  [-0.2137, 0.75],
  [-0.191, 0.8],
  [-0.1665, 0.85],
  [-0.1387, 0.9],
  [-0.1118, 0.95],
  // The left point of the chin, and up the inside of the W to its notch.
  [-0.0815, 1],
  [-0.0538, 0.95],
  [-0.0259, 0.9],
  [0, 0.864],
];

const mirror = ([x, y]: Pt): Pt => [-x, y];

/** The whole outline: down the left half from the notch between the ears, back up the right half from the chin. */
export const OUTLINE: readonly Pt[] = [...LEFT, ...LEFT.map(mirror).slice(1, -1).reverse()];

/** Width over height. */
export const MASK_ASPECT = 2 * Math.max(...LEFT.map(([x]) => -x));

/** The left eye slit, outer end to inner end; the right one mirrors it. Measured on the glow of the frames' eyes. */
export const EYE = { outer: [-0.2325, 0.398] as Pt, inner: [-0.093, 0.4985] as Pt };

/** Where a point of the mask lands in its frame, as a texture coordinate of the uploaded crop (v from the top). */
export function uvOf([x, y]: Pt): [number, number] {
  return [(FRAME.cx + x * FRAME.height - CROP.x) / CROP.w, (FRAME.top + y * FRAME.height - CROP.y) / CROP.h];
}
