/**
 * The long film, the timeline: 150 s, 1920×1080, 30 frames a second, cut on the bars of a 128 BPM track whose sections
 * are made to these lengths (`audio/promo-150.plan.json`). Pure: shots, words and moments only; numbers come from the
 * race records, footage from the real site and the 3D arena filmed off it.
 */

export const PROMO = { id: "Promo", width: 1920, height: 1080, fps: 30, bpm: 128, bars: 80 } as const;
export const BEAT_S = 60 / PROMO.bpm;
export const BAR_S = 4 * BEAT_S;
export const frameAt = (s: number): number => Math.round(s * PROMO.fps);
/** The first frame of a bar (bars may be fractional: a beat is a quarter). */
export const barFrame = (bar: number): number => frameAt(bar * BAR_S);
export const DURATION = barFrame(PROMO.bars);

/** The track's sections, in bars, as it came out (audio/promo-150.json): each drop a bar after its section began. */
export const SECTIONS = {
  open: [0, 4],
  build: [4, 16],
  hush1: [16, 17],
  drop1: [17, 41],
  breakdown: [41, 49],
  build2: [49, 53],
  drop2: [53, 72],
  finale: [72, 80],
} as const satisfies Record<string, readonly [number, number]>;

/** Where the section a bar is in hits hardest: the drops punch on every beat, the rest only on a cut. */
export const driving = (bar: number): boolean => (bar >= 17 && bar < 41) || (bar >= 53 && bar < 72);

export type Pic =
  /** `panel`: a page of the site in a lit frame on the right, so its own words never sit under the film's. */
  | { kind: "video"; src: string; from?: number; rate?: number; zoom?: readonly [number, number]; origin?: string; panel?: boolean }
  | { kind: "art"; src: string; zoom?: readonly [number, number]; origin?: string; drift?: readonly [number, number] }
  | { kind: "ring"; split?: boolean }
  | { kind: "black" };

export type Tint = "ice" | "money" | "amber";

export type Words = {
  kicker?: string;
  head?: string;
  tint?: Tint;
  sub?: string;
  /** Where the words stand: left over the dark side, centred, or low over a busy picture. */
  place?: "left" | "center" | "low";
  /** The headline's size before it is fitted to the frame. */
  size?: number;
  /** The sign above the headline: the logo shots. */
  logo?: boolean;
  /** Left words beside a panel: a narrower column. */
  narrow?: boolean;
  /** Words of the headline that land one per beat instead of all at once. */
  perBeat?: boolean;
  /** A countdown on the headline: these many seconds at the cut, one less each second, never below 1. */
  clock?: number;
  /** A dark veil over the whole picture, 0…1, so the words stand on anything. */
  veil?: number;
  /** A number that counts up from zero over the first bar. */
  count?: { to: string; prefix?: string; unit?: string };
};

export type Fx = {
  /** White light out of the cut, 80 ms. */
  flash?: boolean;
  /** How hard the frame shakes on the cut, 0…1. */
  shake?: number;
  /** A chromatic split on the cut, for the biggest hits. */
  split?: boolean;
  /** Obsidian shards flying past the lens, for the vault breaking. */
  shards?: boolean;
  /** Bars top and bottom: the cold open and the finale. */
  letterbox?: boolean;
};

export type Shot = { at: number; len: number; pic: Pic; words?: Words; fx?: Fx };
