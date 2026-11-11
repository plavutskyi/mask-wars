/**
 * The moments inside a filmed shot, as frames of its reel: where the vault splits, the winner's eyes light, the payout
 * leaves the vault and lands. The film keeps the frame the arena changed state on; the rest follows from the arena's
 * own timing (apps/web arena3d `timing.ts`: the halves part 560 ms after the break begins, the payout flies 820 ms).
 */

import type { Filmed } from "./shoot.ts";

/** apps/web/components/arena3d/timing.ts, in seconds of the page's time. */
const ARENA = { split: 0.56, ignite: 0.06, flight: 0.82 } as const;

export function momentsOf(shot: Filmed, fps: number): Record<string, number> {
  const out: Record<string, number> = {};
  const breach = shot.marks["breach"];
  const paid = shot.marks["paid"];
  // A shot in slow motion slows from its mark on: page seconds stretch over more frames.
  const frames = (seconds: number): number => Math.round((seconds / shot.rate) * fps);
  if (breach !== undefined && breach >= 0 && breach < shot.frames) {
    out["split"] = breach + Math.round(ARENA.split * fps);
    out["ignite"] = breach + Math.round(ARENA.ignite * fps);
  }
  if (paid !== undefined && paid >= 0 && paid < shot.frames) {
    out["launch"] = paid;
    out["land"] = paid + frames(ARENA.flight);
  }
  return Object.fromEntries(Object.entries(out).filter(([, f]) => f < shot.frames));
}
