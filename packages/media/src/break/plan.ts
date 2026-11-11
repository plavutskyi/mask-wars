/**
 * THE BREAK, the timeline: 15 s, 1920×1080, 30 frames a second, no words. Pure.
 *
 * Seven shots, cut hard on the beat. Each shot takes its picture from a source: a generated clip dropped into the
 * round's `slots/` folder when there is one, else the footage filmed off the real site (`src/film`). Either way the
 * picture is real motion from its first frame, and the shot's moment (the vault splitting, the money landing) is put
 * on a beat, with the hit in the sound on the same frame.
 *
 * The last shot is the first one played backwards: the vault shuts, and the clip ends on the picture it began with,
 * so a feed that loops it shows no jump.
 */

import type { Tempo } from "./beat.ts";
import { beatFrame, beatGrid, checkTempo, snapToBeat } from "./beat.ts";

export const BREAK = { id: "break", width: 1920, height: 1080, fps: 30, seconds: 15 } as const;

/** The generated clips a round may bring: `slots/<name>.mp4`. */
export const SLOTS = ["crack", "eye", "hero", "flow"] as const;
export type Slot = (typeof SLOTS)[number];
/** The footage filmed off the site that the clip is cut from: `film/<name>.mp4`. */
export const REELS = ["crack", "eye", "hero", "home", "flow", "league"] as const;
export type Reel = (typeof REELS)[number];

export const SHOTS = ["crack", "eye", "hero", "arena", "flow", "league", "end"] as const;
export type ShotId = (typeof SHOTS)[number];

/** A shot's picture: which file, how many frames it has, and where its moments are, as frames of the file. */
export type Source = {
  kind: "slot" | "reel";
  name: string;
  frames: number;
  /** The picture's width, px: 1920, or more for a band of a page the shot pans along. */
  width: number;
  moments: Readonly<Record<string, number>>;
};

type Board = {
  id: ShotId;
  /** Where the shot starts in the storyboard, seconds: snapped to the nearest beat of the music. */
  at: number;
  /** The slot that takes the shot when its file is there, and the reel that stands in when it is not. */
  slot: Slot | null;
  reel: Reel;
  /** The source's moment that is put on a beat, and how many beats into the shot. */
  moment?: { name: string; beats: number };
};

/** The storyboard, in the seconds it was written in. */
export const BOARD: readonly Board[] = [
  { id: "crack", at: 0, slot: "crack", reel: "crack", moment: { name: "split", beats: 1 } },
  { id: "eye", at: 2, slot: "eye", reel: "eye", moment: { name: "ignite", beats: 1 } },
  { id: "hero", at: 3.5, slot: "hero", reel: "hero" },
  { id: "arena", at: 5.5, slot: null, reel: "home", moment: { name: "split", beats: 1 } },
  { id: "flow", at: 8, slot: "flow", reel: "flow", moment: { name: "launch", beats: 0 } },
  { id: "league", at: 10.5, slot: null, reel: "league" },
  { id: "end", at: 12.5, slot: "crack", reel: "crack" },
];

/** Where a slot's moments are when nobody says: the split and the eyes' light half a second in, the money down at two. */
export const SLOT_MOMENTS: Readonly<Record<Slot, Readonly<Record<string, number>>>> = {
  crack: { split: 0.5 },
  eye: { ignite: 0.5 },
  hero: {},
  flow: { launch: 0, land: 2 },
};

/** The slot's file when the round brought one, else the filmed reel: never a card, never a still. */
export function pickSource(slot: Slot | null, reel: Reel, slots: Readonly<Partial<Record<Slot, Source>>>, reels: Readonly<Partial<Record<Reel, Source>>>): Source {
  const given = slot ? slots[slot] : undefined;
  if (given) return given;
  const filmed = reels[reel];
  if (!filmed) throw new Error(`no footage for this shot: neither slots/${slot ?? reel}.mp4 nor the filmed reel ${reel}.mp4 (film the round first: pnpm --filter @maskwars/media film <id>)`);
  return filmed;
}

export type Segment = {
  id: ShotId;
  from: number;
  to: number;
  source: Source;
  /** The source frame shown on the shot's first frame (its last, when the shot plays backwards). */
  start: number;
  reverse: boolean;
};

export type BreakPlan = {
  durationInFrames: number;
  tempo: Tempo;
  beats: number[];
  segments: Segment[];
  /** Every cut, as the first frame of the shot that follows it. */
  cuts: number[];
  /** The moments the sound and the type answer to, as frames of the clip. */
  hits: {
    /** The vault splits: the clip's first hit. */
    crack: number;
    /** The winner's eyes light. */
    ignite: number;
    /** The winner's name lands. */
    name: number;
    /** The vault splits again, on the real page. */
    split: number;
    /** The payout lands on the winner; the counter runs from here. */
    land: number;
    /** The counter reaches the round's sum. */
    sum: number;
    /** The sign arrives. */
    sign: number;
    /** The vault shuts. */
    lock: number;
  };
  /** The counter runs from the drain to the total over these frames: from the landing to the next beat. */
  counter: { from: number; to: number };
};

/** The source frame a shot shows on a frame of the clip; a source that runs out holds its last frame. */
export function sourceFrame(s: Segment, frame: number): number {
  const i = Math.min(s.to - s.from - 1, Math.max(0, frame - s.from));
  const at = s.reverse ? s.start + (s.to - s.from - 1 - i) : s.start + i;
  return Math.min(s.source.frames - 1, Math.max(0, at));
}

export function planBreak(tempo: Tempo, slots: Readonly<Partial<Record<Slot, Source>>>, reels: Readonly<Partial<Record<Reel, Source>>>): BreakPlan {
  checkTempo(tempo);
  const fps = BREAK.fps;
  const durationInFrames = BREAK.seconds * fps;
  const beats = beatGrid(tempo, fps, durationInFrames);
  // Every shot starts on a beat; two that would start on the same beat mean the tempo is too slow for this cut.
  const starts = BOARD.map((b) => (b.at === 0 ? 0 : snapToBeat(b.at, tempo, fps)));
  if (starts.some((s, i) => i > 0 && s <= starts[i - 1]!)) throw new Error(`at ${tempo.bpm} BPM two shots of the storyboard fall on one beat`);
  // The beat `n` beats after a frame that is itself a beat.
  const after = (frame: number, n: number): number => {
    const i = beats.indexOf(frame);
    return i >= 0 && beats[i + n] !== undefined ? beats[i + n]! : frame + (beatFrame(n, tempo, fps) - beatFrame(0, tempo, fps));
  };

  const segments: Segment[] = [];
  const moment: Partial<Record<ShotId, Record<string, number>>> = {};
  BOARD.forEach((b, i) => {
    const from = starts[i]!;
    const to = starts[i + 1] ?? durationInFrames;
    if (b.id === "end") {
      // The first shot, backwards, ending on the clip's first frame.
      const first = segments[0]!;
      segments.push({ id: b.id, from, to, source: first.source, start: first.start, reverse: true });
      return;
    }
    const source = pickSource(b.slot, b.reel, slots, reels);
    let start = 0;
    const m = b.moment ? source.moments[b.moment.name] : undefined;
    if (b.moment && m !== undefined) {
      // The moment goes on its beat; a source with too little before the moment starts at its own start, and the
      // moment comes earlier: the sound follows the picture, not the grid.
      start = Math.max(0, m - (after(from, b.moment.beats) - from));
    }
    segments.push({ id: b.id, from, to, source, start, reverse: false });
    moment[b.id] = Object.fromEntries(Object.entries(source.moments).map(([k, f]) => [k, from + (f - start)]));
  });

  const seg = (id: ShotId): Segment => segments.find((s) => s.id === id)!;
  const inside = (id: ShotId, name: string, fallback: number): number => {
    const f = moment[id]?.[name];
    const s = seg(id);
    return f !== undefined && f >= s.from && f < s.to ? f : Math.min(s.to - 1, fallback);
  };
  const crack = inside("crack", "split", after(0, 1));
  const land = inside("flow", "land", after(seg("flow").from, 4));
  const end = seg("end");
  // The sum is reached on the beat after the landing, and stands for at least a third of a second before the cut.
  const flow = seg("flow");
  const sum = Math.max(land + 6, Math.min(beats.find((b) => b > land) ?? land + 12, flow.to - 10));
  const hits = {
    crack,
    ignite: inside("eye", "ignite", after(seg("eye").from, 1)),
    name: Math.min(seg("hero").to - 1, after(seg("hero").from, 1)),
    split: inside("arena", "split", after(seg("arena").from, 1)),
    land,
    sum,
    sign: Math.min(end.to - 1, after(end.from, 1)),
    // Backwards, the split of the first shot comes this long before the end.
    lock: Math.max(end.from, end.to - 1 - crack),
  };
  return { durationInFrames, tempo, beats, segments, cuts: starts.slice(1), hits, counter: { from: land, to: sum } };
}
