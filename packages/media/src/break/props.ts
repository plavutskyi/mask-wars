/** What the composition `break` is given, and where its pictures are in the render's public dir. No JSX here: the render reads this file in Node. */

import type { RaceRecord } from "../race/record.ts";
import type { BreakPlan } from "./plan.ts";

/** Nothing set in type is smaller than this, px (BRANDBOOK §10: a feed shows the frame at about a fifth of its size). */
export const MIN_TYPE = 56;

/** Files in the public dir: the music cut to the clip, and the clip's own hits. */
export type BreakSounds = { music: string | null; impact: string; bolt: string; rise: string; landing: string };
export type BreakProps = { record: RaceRecord; plan: BreakPlan; sounds: BreakSounds | null };

/** The folder a source's frames are in, inside the public dir: `00001.jpg` is its first frame. */
export const footageDir = (s: { kind: string; name: string }): string => `footage/${s.kind}-${s.name}`;
