/**
 * The race clip's timeline, pure: 1920×1080, 30 fps, 15–45 s, only 16:9. Frame 0 is already the result. Then the
 * vault and its bounty, the masks racing in the sandbox until one breaks through, the real vault cracking, the
 * contract paying, and what comes next. Burned-in captions tell the race to a feed that plays muted; each stays long
 * enough to read.
 */

import { listNames } from "../race/story.ts";
import type { RaceStory } from "../race/story.ts";

export const RACE_CLIP = { width: 1920, height: 1080, fps: 30, minS: 15, maxS: 45 } as const;

export const SCENES = ["result", "vault", "race", "drain", "paid", "end"] as const;
export type SceneId = (typeof SCENES)[number];
export type Span = { from: number; to: number };
export type ClipCaption = Span & { text: string };

export type RaceClipPlan = {
  durationInFrames: number;
  scenes: Record<SceneId, Span>;
  captions: ClipCaption[];
  /** The two hits, as absolute frames: the mask breaks the sandbox copy, and the real vault cracks. */
  beats: { breach: number; crack: number };
  /** Inside the race scene, the race clock runs from 00:00 to the breach over these frames. */
  clock: Span;
};

const S = RACE_CLIP.fps;
/** Seconds a line needs on screen: a beat to find it, then about 16 characters a second. */
export const readSeconds = (text: string): number => 0.9 + text.length / 16;

/** The lines of the race, in order. Every number comes from the story. */
export function raceCaptions(s: RaceStory): { vault: string; attack: string; breach: string; drain: string; paid: string } {
  const W = s.winner.name;
  return {
    vault: `A vault opens on ${s.chain} with a ${s.bounty} NEAR bounty for the first mask that breaks it.`,
    attack: s.masks.length > 1 ? `${listNames(s.masks)} attack a private copy of it at the same time.` : `${W} attacks a private copy of it.`,
    breach: `${W} breaks the copy on its ${s.breach.tryWords}, ${s.breach.words} in.`,
    drain: `Then ${W} plays the same plan on the real vault with its own key. ${s.drained} NEAR out.`,
    paid: `A judge in a secure enclave reads the drain from the chain in ${s.judge.seconds} s. Then the contract pays ${W}.`,
  };
}

const sec = (x: number): number => Math.round(x * S);

export function planRaceClip(s: RaceStory): RaceClipPlan {
  const c = raceCaptions(s);
  const len = {
    result: 3.5,
    vault: Math.max(5, readSeconds(c.vault)),
    // The attack line plays while the clock runs; the breach line starts on the hit.
    race: Math.max(3, readSeconds(c.attack)) + Math.max(3, readSeconds(c.breach)),
    drain: Math.max(5.5, readSeconds(c.drain) + 0.8),
    paid: Math.max(5, readSeconds(c.paid)),
    end: 4,
  } satisfies Record<SceneId, number>;
  let at = 0;
  const scenes = {} as Record<SceneId, Span>;
  for (const id of SCENES) {
    scenes[id] = { from: at, to: at + sec(len[id]) };
    at = scenes[id].to;
  }
  const breach = scenes.race.from + sec(Math.max(3, readSeconds(c.attack)));
  const crack = scenes.drain.from + sec(0.8);
  // Lines fade in a few frames after their scene starts and leave a few frames before it ends.
  const line = (span: Span, text: string): ClipCaption => ({ from: span.from + 6, to: span.to - 6, text });
  const captions = [
    line(scenes.vault, c.vault),
    line({ from: scenes.race.from, to: breach }, c.attack),
    line({ from: breach - 6, to: scenes.race.to }, c.breach),
    line({ from: crack - 6, to: scenes.drain.to }, c.drain),
    line(scenes.paid, c.paid),
  ];
  const durationInFrames = at;
  if (durationInFrames < RACE_CLIP.minS * S || durationInFrames > RACE_CLIP.maxS * S) {
    throw new Error(`the clip is ${(durationInFrames / S).toFixed(1)} s, outside ${RACE_CLIP.minS}–${RACE_CLIP.maxS} s`);
  }
  return { durationInFrames, scenes, captions, beats: { breach, crack }, clock: { from: scenes.race.from + 12, to: breach } };
}

/**
 * `0.08664` at k = 0.5 → `0.04332`: counts up digit-exact, never past the real number, and lands on it at k = 1. A
 * round amount counts in hundredths at least (`1` → `0.50` → `1`), so the counter moves instead of jumping.
 */
export function countUp(amount: string, k: number): string {
  if (k >= 1) return amount;
  const [whole, frac = ""] = amount.split(".");
  let places = frac.length;
  let units = BigInt(`${whole}${frac}`);
  while (units < 100n && places < frac.length + 3) {
    units *= 10n;
    places++;
  }
  const scale = 1_000_000n;
  const shown = (units * BigInt(Math.max(0, Math.floor(k * Number(scale))))) / scale;
  const digits = shown.toString().padStart(places + 1, "0");
  return places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
}

/** The race clock at a race time: `01:04`. */
export function raceClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
