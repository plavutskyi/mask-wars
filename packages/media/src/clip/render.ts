/**
 * Local clip render: race record → Remotion → H.264 MP4, 1920×1080. Music, when there is any, is cut to the clip,
 * faded out, and brought to −14 LUFS (true peak −1.5 dBTP) in two passes; without music the clip has no audio track.
 * Needs ffmpeg on the machine.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ART } from "../masks.ts";
import type { RaceRecord } from "../race/record.ts";
import { parseRace } from "../race/record.ts";
import { raceStory } from "../race/story.ts";
import type { RaceClipPlan } from "./race-plan.ts";
import { planRaceClip } from "./race-plan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../../..");
const BRAND = join(REPO, "brand");
const require = createRequire(import.meta.url);

/** Where the music for clips lives once it is made. */
export const AUDIO_DIR = join(REPO, "apps/web/public/audio");
const AUDIO_EXT = [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".opus"];
/** The file a clip takes when the folder has several: the first of these names, else the first audio file by name. */
const MUSIC_NAMES = ["clip", "race", "theme", "arena", "music"];

export const LOUDNESS = { lufs: -14, tolerance: 1, truePeakMax: -1 } as const;

export const hasFfmpeg = (): boolean => spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

/** The music a clip gets: the given file, or what is in `apps/web/public/audio/`, or none. */
export function findMusic(dir = AUDIO_DIR): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => AUDIO_EXT.includes(extname(f).toLowerCase()))
    .sort();
  const named = MUSIC_NAMES.map((n) => files.find((f) => f.slice(0, -extname(f).length).toLowerCase() === n)).find(Boolean);
  const pick = named ?? files[0];
  return pick ? join(dir, pick) : null;
}

/** Chromium for Remotion: its own download when present, else the box's preinstalled headless shell. */
function browserExecutable(): string | null {
  const root = "/opt/pw-browsers";
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell"))) {
    for (const sub of readdirSync(join(root, d))) {
      const exe = join(root, d, sub, "chrome-headless-shell");
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

function publicDir(music: string | null): { dir: string; music: string | null } {
  const dir = mkdtempSync(join(tmpdir(), "maskwars-clip-"));
  mkdirSync(join(dir, "art"));
  mkdirSync(join(dir, "fonts"));
  for (const a of ART) copyFileSync(join(BRAND, "art/web", `${a}.jpg`), join(dir, "art", `${a}.jpg`));
  copyFileSync(require.resolve("@fontsource-variable/hubot-sans/files/hubot-sans-latin-standard-normal.woff2"), join(dir, "fonts/hubot-sans.woff2"));
  copyFileSync(require.resolve("@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2"), join(dir, "fonts/mona-sans.woff2"));
  let name: string | null = null;
  if (music) {
    if (!existsSync(music)) throw new Error(`no music file at ${music}`);
    name = `music${extname(music).toLowerCase()}`;
    copyFileSync(music, join(dir, name));
  }
  return { dir, music: name };
}

export type ClipJob = {
  /** The MP4 to write; null renders no video (stills only). */
  video: string | null;
  /** A folder for the key frames as JPEG, for eyes; null renders none. */
  frames: string | null;
  /** Music file; null for a silent clip. */
  music: string | null;
};

export type ClipResult = { seconds: number; audio: boolean; lufs: number | null; frames: { name: string; frame: number }[] };

/** The frames worth looking at: the first (the thumbnail), each scene at its height, the two hits just after. */
export function keyFrames(plan: RaceClipPlan): { name: string; frame: number }[] {
  const sc = plan.scenes;
  const mid = (a: { from: number; to: number }, k = 0.5) => Math.round(a.from + (a.to - a.from) * k);
  return [
    { name: "1-result", frame: 0 },
    { name: "2-vault", frame: mid(sc.vault, 0.6) },
    { name: "3-race", frame: mid({ from: sc.race.from, to: plan.beats.breach }, 0.7) },
    { name: "4-breach", frame: plan.beats.breach + 14 },
    { name: "5-drain", frame: plan.beats.crack + 24 },
    { name: "6-paid", frame: mid(sc.paid, 0.75) },
    { name: "7-end", frame: mid(sc.end, 0.6) },
    // A season round's sealing window, in its place between the seal and the drain.
    ...(sc.lock.to > sc.lock.from ? [{ name: "4b-lock", frame: mid(sc.lock, 0.5) }] : []),
  ].sort((a, b) => a.frame - b.frame);
}

/** Record → MP4 and key frames, with one bundle. */
export async function renderRaceClip(input: unknown, job: ClipJob): Promise<ClipResult> {
  if (job.video && !hasFfmpeg()) throw new Error("ffmpeg is not on this machine: the clip was not rendered");
  const record: RaceRecord = parseRace(input);
  const plan = planRaceClip(raceStory(record)); // 15–45 s or throw before anything renders
  const { bundle } = await import("@remotion/bundler");
  const { selectComposition, renderMedia, renderStill } = await import("@remotion/renderer");
  const pub = publicDir(job.music);
  try {
    const serveUrl = await bundle({ entryPoint: join(here, "Root.tsx"), publicDir: pub.dir });
    const exe = browserExecutable();
    const browser = exe ? { browserExecutable: exe } : {};
    const inputProps = { record, music: pub.music };
    const composition = await selectComposition({ serveUrl, id: "RaceClip", inputProps, ...browser });
    const frames = keyFrames(plan);
    if (job.frames) {
      mkdirSync(job.frames, { recursive: true });
      for (const f of frames) {
        await renderStill({ serveUrl, composition, inputProps, frame: f.frame, output: join(job.frames, `${f.name}.jpg`), imageFormat: "jpeg", jpegQuality: 88, ...browser });
      }
    }
    let audio = false;
    let lufs: number | null = null;
    if (job.video) {
      const raw = `${job.video}.raw.mp4`;
      try {
        await renderMedia({ serveUrl, composition, inputProps, codec: "h264", outputLocation: raw, ...browser });
        ({ audio, lufs } = finish(raw, job.video));
      } finally {
        rmSync(raw, { force: true });
      }
    }
    return { seconds: composition.durationInFrames / composition.fps, audio, lufs, frames };
  } finally {
    rmSync(pub.dir, { recursive: true, force: true });
  }
}

/** ffmpeg's loudnorm measurement of a file, or an error that says which file could not be measured. */
function measure(file: string): Record<string, string> {
  const r = spawnSync("ffmpeg", ["-nostats", "-i", file, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], { encoding: "utf8" });
  const at = r.stderr?.lastIndexOf("{") ?? -1;
  if (r.status !== 0 || at < 0) throw new Error(`ffmpeg could not measure the loudness of ${file}: ${r.stderr?.trim().split("\n").pop() ?? r.error?.message}`);
  return JSON.parse(r.stderr.slice(at, r.stderr.lastIndexOf("}") + 1)) as Record<string, string>;
}

export function loudness(file: string): { lufs: number; truePeak: number } {
  const j = measure(file);
  return { lufs: Number(j.input_i), truePeak: Number(j.input_tp) };
}

const hasAudio = (file: string): boolean =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { encoding: "utf8" }).trim() !== "";

/** H.264 High, yuv420p, faststart; sound (when there is any) at −14 LUFS. */
export function finish(raw: string, output: string): { audio: boolean; lufs: number | null } {
  const audio = hasAudio(raw);
  const tmp = `${output}.tmp.mp4`;
  const video = ["-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium"];
  let lufs: number | null = null;
  if (!audio) {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-map", "0:v:0", ...video, "-an", "-movflags", "+faststart", tmp]);
  } else {
    const m = measure(raw);
    const af = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-map", "0:v:0", "-map", "0:a:0", ...video, "-af", af, "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", tmp]);
    const level = loudness(tmp);
    if (Math.abs(level.lufs - LOUDNESS.lufs) > LOUDNESS.tolerance || level.truePeak > LOUDNESS.truePeakMax) throw new Error(`finish: ${level.lufs} LUFS, true peak ${level.truePeak}`);
    lufs = level.lufs;
  }
  rmSync(output, { force: true });
  renameSync(tmp, output);
  return { audio, lufs };
}

/** One contact sheet of the key frames, 4 across, for the PR and for eyes. An empty cell stays ink. */
export function contactSheet(framesDir: string, names: string[], output: string): void {
  const cols = 4;
  const inputs = names.flatMap((n) => ["-i", join(framesDir, `${n}.jpg`)]);
  const scaled = names.map((_, i) => `[${i}]scale=960:540[s${i}]`).join(";");
  const layout = names.map((_, i) => `${(i % cols) * 960}_${Math.floor(i / cols) * 540}`).join("|");
  const stack = `${scaled};${names.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${names.length}:layout=${layout}:fill=0x06050c`;
  const quality = output.endsWith(".jpg") ? ["-q:v", "2"] : [];
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", stack, ...quality, output]);
}
