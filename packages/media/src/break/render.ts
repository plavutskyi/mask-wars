/**
 * Renders THE BREAK for a round: the round's record, its filmed reels (`shots/<id>/film/`) and whatever generated
 * clips its `slots/` folder holds → `break.mp4` (H.264, 1920×1080, 30 frames a second, −14 LUFS) and a contact sheet
 * of the frames a person should look at. Needs ffmpeg; the site is not run here.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finish, hasFfmpeg } from "../clip/render.ts";
import type { FilmManifest } from "../film/film.ts";
import { momentsOf } from "../film/moments.ts";
import { parseRace } from "../race/record.ts";
import type { BreakProps, BreakSounds } from "./props.ts";
import { footageDir } from "./props.ts";
import type { Track } from "./music.ts";
import { breakTrack } from "./music.ts";
import type { BreakPlan, Reel, Slot, Source } from "./plan.ts";
import { BREAK, planBreak, REELS, SLOT_MOMENTS, SLOTS, sourceFrame } from "./plan.ts";
import { bolt, impact, landing, rise, writeWav } from "./sound.ts";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The seconds of the clip a person looks at before it goes out. */
export const SHEET_SECONDS = [0, 0.5, 1, 2, 3.5, 5.5, 8, 10.5, 12.5, 14.5] as const;

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

const probe = (file: string, entry: string): string => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", entry, "-of", "csv=p=0", file], { encoding: "utf8" }).trim();

/** A generated clip in `slots/`: how many frames it gives at the clip's rate, and its moments from `slots.json` or the usual places. */
export function slotSource(name: Slot, file: string, said: Record<string, unknown> | undefined): Source {
  const seconds = Number(probe(file, "format=duration"));
  if (!(seconds > 0)) throw new Error(`${file}: not a video ffprobe can read`);
  const moments: Record<string, number> = {};
  for (const [k, usual] of Object.entries(SLOT_MOMENTS[name])) {
    const v = said?.[k];
    moments[k] = Math.round((typeof v === "number" && v >= 0 ? v : usual) * BREAK.fps);
  }
  return { kind: "slot", name, frames: Math.floor(seconds * BREAK.fps), width: BREAK.width, moments };
}

export type BreakJob = {
  /** The round's folder in `shots/`: its `film/`, its `slots/`, and its first clip (for the music, until a track is in `audio/`). */
  shots: string;
  /** Where `break.mp4` and `break-sheet.jpg` go. */
  out: string;
  /** A track and its tempo in place of the one `breakTrack` finds. */
  track?: Track;
  log?: (line: string) => void;
};

export type BreakResult = { video: string; sheet: string; seconds: number; lufs: number | null; plan: BreakPlan; track: Track; sources: Record<string, "slot" | "reel"> };

export async function renderBreak(input: unknown, job: BreakJob): Promise<BreakResult> {
  if (!hasFfmpeg()) throw new Error("ffmpeg is not on this machine: the clip was not rendered");
  const log = job.log ?? (() => {});
  const record = parseRace(input);
  const fps = BREAK.fps;

  // What was filmed off the site.
  const filmDir = join(job.shots, "film");
  const manifestFile = join(filmDir, "film.json");
  if (!existsSync(manifestFile)) throw new Error(`${record.id} has not been filmed: no ${manifestFile} (pnpm --filter @maskwars/media film ${record.id})`);
  const film = JSON.parse(readFileSync(manifestFile, "utf8")) as FilmManifest;
  const reels: Partial<Record<Reel, Source>> = {};
  for (const name of REELS) {
    const shot = film.shots.find((s) => s.name === name);
    if (shot && existsSync(join(filmDir, `${name}.mp4`))) reels[name] = { kind: "reel", name, frames: shot.frames, width: shot.width ?? BREAK.width, moments: momentsOf(shot, fps) };
  }
  // What the round's slots hold.
  const slotDir = join(job.shots, "slots");
  let said: Record<string, Record<string, unknown>> = {};
  try {
    said = JSON.parse(readFileSync(join(slotDir, "slots.json"), "utf8")) as typeof said;
  } catch {
    /* no slots.json: every slot has its moments in the usual places */
  }
  const slots: Partial<Record<Slot, Source>> = {};
  for (const name of SLOTS) {
    const file = join(slotDir, `${name}.mp4`);
    if (existsSync(file)) slots[name] = slotSource(name, file, said[name]);
  }

  const track = job.track ?? breakTrack(job.shots);
  const plan = planBreak(track.tempo, slots, reels);
  log(`music: ${track.about}`);
  for (const s of plan.segments) log(`  ${(s.from / fps).toFixed(2).padStart(5)} s  ${s.id.padEnd(6)} ${s.source.kind === "slot" ? `slots/${s.source.name}.mp4` : `film/${s.source.name}.mp4`}${s.reverse ? ", backwards" : ""}`);

  const pub = mkdtempSync(join(tmpdir(), "maskwars-break-"));
  mkdirSync(job.out, { recursive: true });
  try {
    mkdirSync(join(pub, "fonts"));
    copyFileSync(require.resolve("@fontsource-variable/hubot-sans/files/hubot-sans-latin-standard-normal.woff2"), join(pub, "fonts/hubot-sans.woff2"));
    copyFileSync(require.resolve("@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2"), join(pub, "fonts/mona-sans.woff2"));

    // Each source's frames, only as far as the clip shows them. A generated clip is brought to the clip's frame and rate.
    const used = new Map<string, { source: Source; last: number }>();
    for (const s of plan.segments) {
      let last = 0;
      for (let f = s.from; f < s.to; f++) last = Math.max(last, sourceFrame(s, f));
      const key = footageDir(s.source);
      used.set(key, { source: s.source, last: Math.max(last, used.get(key)?.last ?? 0) });
    }
    for (const [key, { source, last }] of used) {
      const dir = join(pub, key);
      mkdirSync(dir, { recursive: true });
      const file = source.kind === "slot" ? join(slotDir, `${source.name}.mp4`) : join(filmDir, `${source.name}.mp4`);
      const fit = source.kind === "slot" ? [`fps=${fps}`, `scale=${BREAK.width}:${BREAK.height}:force_original_aspect_ratio=increase`, `crop=${BREAK.width}:${BREAK.height}`] : [`fps=${fps}`];
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-an", "-vf", fit.join(","), "-frames:v", String(last + 1), "-q:v", "2", join(dir, "%05d.jpg")]);
    }

    // Sound: the music from where the clip starts in it, and the clip's own hits.
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", track.from.toFixed(3), "-i", track.file, "-vn", "-t", String(BREAK.seconds + 0.5), "-ar", "48000", "-ac", "2", join(pub, "music.wav")]);
    writeWav(join(pub, "impact.wav"), impact());
    writeWav(join(pub, "bolt.wav"), bolt());
    writeWav(join(pub, "landing.wav"), landing());
    writeWav(join(pub, "rise.wav"), rise(Math.max(0.1, plan.hits.crack / fps)));
    const sounds: BreakSounds = { music: "music.wav", impact: "impact.wav", bolt: "bolt.wav", rise: "rise.wav", landing: "landing.wav" };

    const { bundle } = await import("@remotion/bundler");
    const { selectComposition, renderMedia } = await import("@remotion/renderer");
    const serveUrl = await bundle({ entryPoint: join(here, "../clip/Root.tsx"), publicDir: pub });
    const exe = browserExecutable();
    const browser = exe ? { browserExecutable: exe } : {};
    const inputProps: BreakProps = { record, plan, sounds };
    const composition = await selectComposition({ serveUrl, id: BREAK.id, inputProps, ...browser });
    const video = join(job.out, "break.mp4");
    const raw = `${video}.raw.mp4`;
    let lufs: number | null = null;
    try {
      await renderMedia({ serveUrl, composition, inputProps, codec: "h264", crf: 12, outputLocation: raw, ...browser });
      ({ lufs } = finish(raw, video, true));
    } finally {
      rmSync(raw, { force: true });
    }

    // The sheet is cut from the finished file: what a person will see, not what the renderer meant.
    const sheet = join(job.out, "break-sheet.jpg");
    contactSheet(video, SHEET_SECONDS.map((s) => Math.round(s * fps)), sheet);
    return { video, sheet, seconds: composition.durationInFrames / fps, lufs, plan, track, sources: Object.fromEntries(plan.segments.map((s) => [s.id, s.source.kind])) };
  } finally {
    rmSync(pub, { recursive: true, force: true });
  }
}

/** The named frames of a finished video on one sheet, five across at half size, in order. */
export function contactSheet(video: string, frames: readonly number[], output: string): void {
  const cols = 5;
  const pick = frames.map((f) => `eq(n\\,${f})`).join("+");
  const rows = Math.ceil(frames.length / cols);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-vf", `select='${pick}',scale=960:540,tile=${cols}x${rows}:color=0x06050c`, "-frames:v", "1", "-q:v", "2", output]);
}

/** One frame of a finished video at full size, for a close look. */
export function frameOf(video: string, frame: number, output: string): void {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", video, "-vf", `select='eq(n\\,${frame})'`, "-frames:v", "1", "-q:v", "2", output]);
}
