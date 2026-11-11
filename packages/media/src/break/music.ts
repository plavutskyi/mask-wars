/**
 * The music of a wordless clip, and its tempo: the cuts stand on its beats.
 *
 * `packages/media/audio/break-*.mp3` is where the series' tracks go, each with a `.json` beside it that says its
 * tempo. When that folder holds none yet, the clip takes the track of the round's first clip (`shots/<id>/clip.mp4`),
 * from where it first plays at full level, and measures its tempo itself.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tempo } from "./beat.ts";
import { BPM_RANGE } from "./beat.ts";
import { estimateTempo } from "./sound.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const AUDIO_DIR = join(here, "../../audio");

export type Track = {
  file: string;
  /** Seconds into the file at which the clip starts. */
  from: number;
  /** The tempo, with the beat's offset already in the clip's own time. */
  tempo: Tempo;
  /** Where the tempo came from, for the render's log. */
  about: string;
};

/** The series' track: the first `break-*.mp3` by name, or none. */
export function chooseTrack(names: readonly string[]): string | null {
  return [...names].filter((n) => /^break-.+\.mp3$/i.test(n)).sort()[0] ?? null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * A track's own word about itself, from the `.json` beside it: `bpm` (or `tempo`), the second its first beat falls on
 * (`first_beat_s`, or `offset`, `downbeat`, `first_beat`; 0 when not said), and the second the clip should start at
 * (`start_s` or `start`; 0 when not said). Null when the file names no usable tempo.
 */
export function tempoFromJson(json: unknown): { bpm: number; offset: number; start: number } | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as Record<string, unknown>;
  const bpm = num(j["bpm"]) ?? num(j["BPM"]) ?? num(j["tempo"]);
  if (bpm === null || bpm < BPM_RANGE.min || bpm > BPM_RANGE.max) return null;
  const offset = Math.max(0, num(j["first_beat_s"]) ?? num(j["offset"]) ?? num(j["downbeat"]) ?? num(j["first_beat"]) ?? 0);
  const start = Math.max(0, num(j["start_s"]) ?? num(j["start"]) ?? 0);
  return { bpm, offset, start };
}

/** Where a beat falls in the clip when the clip starts `start` seconds into a track whose beats fall at `offset`. */
export function beatOffset(bpm: number, offset: number, start: number): number {
  const beat = 60 / bpm;
  const o = (((offset - start) % beat) + beat) % beat;
  // A beat a hair before the clip's start is the clip's first beat.
  return beat - o < 1e-6 || o < 1e-6 ? 0 : o;
}

function decodeMono(file: string, rate: number): Float32Array {
  const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4)).slice();
}

/** The first second a track plays at its full level: within 4 dB of the level it holds most of the time. */
export function fullFrom(samples: Float32Array, rate: number): number {
  const win = Math.round(rate / 4);
  const levels: number[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += samples[j]! ** 2;
    levels.push(10 * Math.log10(e / win + 1e-12));
  }
  if (levels.length === 0) return 0;
  const usual = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.6)]!;
  // Two quarters in a row, so one early stab is not taken for the full level.
  const i = levels.findIndex((l, k) => l >= usual - 4 && (levels[k + 1] ?? l) >= usual - 4);
  return i < 0 ? 0 : i / 4;
}

/** The track this round's clip plays, and the beat it is cut on. */
export function breakTrack(roundShots: string, audioDir: string = AUDIO_DIR): Track {
  const named = existsSync(audioDir) ? chooseTrack(readdirSync(audioDir)) : null;
  if (named) {
    const file = join(audioDir, named);
    const side = file.replace(/\.mp3$/i, ".json");
    let said: ReturnType<typeof tempoFromJson> = null;
    try {
      said = tempoFromJson(JSON.parse(readFileSync(side, "utf8")));
    } catch {
      /* no file beside the track, or not JSON */
    }
    if (said) return { file, from: said.start, tempo: { bpm: said.bpm, offset: beatOffset(said.bpm, said.offset, said.start) }, about: `${named}, ${said.bpm} BPM from its json` };
    const rate = 22_050;
    const heard = estimateTempo(decodeMono(file, rate), rate);
    const bpm = heard.confidence >= 1.4 ? heard.bpm : 120;
    return { file, from: 0, tempo: { bpm, offset: beatOffset(bpm, heard.offset, 0) }, about: `${named}, no tempo in a json beside it: ${bpm} BPM ${heard.confidence >= 1.4 ? "measured" : "assumed"}` };
  }
  const file = join(roundShots, "clip.mp4");
  if (!existsSync(file)) throw new Error(`no music: neither ${audioDir}/break-*.mp3 nor the round's first clip at ${file}`);
  const rate = 22_050;
  const samples = decodeMono(file, rate);
  const heard = estimateTempo(samples, rate);
  const bpm = heard.confidence >= 1.4 ? heard.bpm : 120;
  // From its first beat at full level: the clip is loud from its first frame.
  const beat = 60 / bpm;
  const loud = fullFrom(samples, rate);
  const from = heard.offset + Math.ceil((loud - heard.offset) / beat - 1e-9) * beat;
  return { file, from, tempo: { bpm, offset: 0 }, about: `the track of ${file.split("/").slice(-2).join("/")} from ${from.toFixed(2)} s, ${bpm} BPM ${heard.confidence >= 1.4 ? "measured" : "assumed"}` };
}
