/**
 * The beat grid of a wordless clip: every cut and every hit stands on a beat of the music. Pure.
 *
 * At 120 beats a minute and 30 frames a second a beat is exactly 15 frames. Any other tempo, or a track whose first
 * beat is a few milliseconds in, gives beats between frames: a beat belongs to the frame that is on screen when it
 * sounds. So the picture changes with the beat or up to a frame before it, never after: the eye forgives a cut that
 * leads the sound, not one that trails it.
 */

export type Tempo = {
  /** Beats a minute. */
  bpm: number;
  /** Seconds into the clip at which a beat falls: the first downbeat of the music as it is cut into the clip. */
  offset: number;
};

export const BPM_RANGE = { min: 60, max: 200 } as const;

export function checkTempo(t: Tempo): Tempo {
  if (!Number.isFinite(t.bpm) || t.bpm < BPM_RANGE.min || t.bpm > BPM_RANGE.max) throw new Error(`a tempo of ${t.bpm} BPM is outside ${BPM_RANGE.min}–${BPM_RANGE.max}`);
  if (!Number.isFinite(t.offset) || t.offset < 0) throw new Error(`a beat offset of ${t.offset} s is not a time in the clip`);
  return t;
}

/** Frames a beat lasts, not rounded. */
export const framesPerBeat = (bpm: number, fps: number): number => (fps * 60) / bpm;

/** The frame on screen when beat `n` sounds. */
export function beatFrame(n: number, t: Tempo, fps: number): number {
  return Math.floor(t.offset * fps + n * framesPerBeat(t.bpm, fps) + 1e-6);
}

/** Every beat inside a clip of `frames` frames, as frames, in order; the clip's own end is not a beat of it. */
export function beatGrid(t: Tempo, fps: number, frames: number): number[] {
  checkTempo(t);
  const per = framesPerBeat(t.bpm, fps);
  // Beats before the offset count too: the music was already playing.
  const first = -Math.floor((t.offset * fps) / per + 1e-6);
  const out: number[] = [];
  for (let n = first; ; n++) {
    const f = beatFrame(n, t, fps);
    if (f >= frames) break;
    if (f >= 0) out.push(f);
  }
  return out;
}

/** The beat nearest to a time, as a frame. A tie goes to the earlier beat: a cut is never late. */
export function snapToBeat(seconds: number, t: Tempo, fps: number): number {
  const per = framesPerBeat(t.bpm, fps);
  const n = Math.ceil(((seconds - t.offset) * fps) / per - 0.5 - 1e-9);
  return Math.max(0, beatFrame(n, t, fps));
}

/** Whether a frame is a beat of the grid. */
export const onBeat = (frame: number, grid: readonly number[]): boolean => grid.includes(frame);
