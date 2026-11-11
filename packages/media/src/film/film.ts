/**
 * Films a round on the real site: its record → the chain answers the site replays → the site, built for filming and
 * started here → every shot of `shots.ts`, frame by frame → one reel (MP4) per shot and `film.json` beside them.
 *
 * The reels are what a clip is cut from (`src/break`). They are kept in `shots/<id>/film/`, so a clip can be rendered
 * again, with new footage in its slots, on a machine that never runs the site.
 */

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Recording } from "@maskwars/arena/replay";
import { chromium } from "playwright";
import type { RaceRecord } from "../race/record.ts";
import { isSealedRound, parseRace } from "../race/record.ts";
import type { RoundExtras } from "./answers.ts";
import { answersFromRecord } from "./answers.ts";
import type { Filmed } from "./shoot.ts";
import { BROWSER_ARGS, FILM_FPS, shoot } from "./shoot.ts";
import { shotsOf } from "./shots.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../../../..");
const WEB = join(REPO, "apps/web");

export type FilmManifest = {
  v: 1;
  round: string;
  network: RaceRecord["network"];
  fps: number;
  width: 1920;
  height: 1080;
  /** Where the site read the round from while it was filmed: the record played back, or the chain's own kept answers. */
  chain: "record" | "answers";
  shots: Filmed[];
};

export type FilmOptions = {
  /** Where the reels go. */
  out: string;
  /** Scratch space for frames and the answers file. */
  work: string;
  /** The chain's own answers (`pnpm --filter @maskwars/arena record --out <file>`) in place of the record played back. */
  answers?: string;
  /** Only these shots; the rest of an earlier film is kept. */
  only?: string[];
  /** A rehearsal: every n-th frame to disk, no reels. */
  every?: number;
  /** A site that is already running, built for filming and replaying this round. */
  base?: string;
  port?: number;
  log?: (line: string) => void;
};

/** What the record does not hold and the owner's own call files do, when they are about this round. */
export function extrasOf(record: RaceRecord): RoundExtras {
  const dir = join(REPO, "scripts", record.network);
  const read = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const open = read("open-safe-args.json");
  const judge = read("judge-args.json");
  const mine = open && open["id"] === record.id;
  return {
    ...(mine && Array.isArray(open["masks"]) ? { entrants: open["masks"] as string[] } : {}),
    ...(mine && typeof open["min_loot"] === "string" ? { minLoot: open["min_loot"] } : {}),
    ...(mine && typeof open["reveal_minutes"] === "number" ? { revealMinutes: open["reveal_minutes"] } : {}),
    ...(judge && typeof judge["version"] === "string" ? { judge: judge["version"] } : {}),
  };
}

/** The site built for filming on this network, from the code as it stands now: a film never shows an older site. */
function buildSite(network: string, log: (line: string) => void): void {
  log(`building the site for filming on ${network} (apps/web/.next-film)`);
  execFileSync("pnpm", ["exec", "next", "build"], { cwd: WEB, stdio: "ignore", shell: WINDOWS, env: { ...process.env, NEXT_PUBLIC_ARENA_FILM: "1", MASKWARS_NETWORK: network } });
}

/** On Windows pnpm is a `.cmd` script, which only a shell starts; the server's process tree is stopped by taskkill. */
const WINDOWS = process.platform === "win32";

async function startSite(network: string, fixture: string, port: number): Promise<{ base: string; stop(): void }> {
  const child: ChildProcess = spawn("pnpm", ["exec", "next", "start", "-p", String(port)], {
    cwd: WEB,
    stdio: "ignore",
    detached: !WINDOWS,
    shell: WINDOWS,
    windowsHide: true,
    env: { ...process.env, NEXT_PUBLIC_ARENA_FILM: "1", MASKWARS_NETWORK: network, ARENA_FIXTURE: fixture },
  });
  const base = `http://localhost:${port}`;
  const stop = () => {
    try {
      if (!child.pid) return;
      if (WINDOWS) execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-child.pid);
    } catch {
      /* already gone */
    }
  };
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) return { base, stop };
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`the site did not start on ${base}`);
}

/** Frames → one reel. Near-lossless, every half second a key frame, so any frame is cut out exactly. */
export function reel(frames: string, output: string): void {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FILM_FPS), "-i", join(frames, "%05d.jpg"), "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-g", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", output]);
}

export async function filmRound(input: unknown, opts: FilmOptions): Promise<FilmManifest> {
  const log = opts.log ?? (() => {});
  const record = parseRace(input);
  if (!isSealedRound(record)) throw new Error(`${record.id} is told by its sandbox board: only a sealed round's record can be played back to the site`);
  mkdirSync(opts.work, { recursive: true });
  mkdirSync(opts.out, { recursive: true });

  let recording: Recording;
  if (opts.answers) {
    recording = JSON.parse(readFileSync(opts.answers, "utf8")) as Recording;
  } else {
    const made = await answersFromRecord(record, extrasOf(record));
    recording = made.recording;
    log(`${record.id}: the record played back as ${recording.exchanges.length} chain answers, ${made.view.now?.masks.length ?? 0} masks on the stage`);
  }
  const fixture = join(opts.work, "answers.json");
  writeFileSync(fixture, JSON.stringify(recording));

  let site: { base: string; stop(): void } | null = null;
  if (!opts.base) {
    buildSite(record.network, log);
    site = await startSite(record.network, fixture, opts.port ?? 3133);
  }
  const base = opts.base ?? site!.base;
  const all = shotsOf({ id: record.id, winner: record.winner });
  const order = all.map((s) => s.name);
  const shots = all.filter((s) => !opts.only || opts.only.includes(s.name));
  const every = opts.every ?? 1;
  const filmed: Filmed[] = [];
  const browser = await chromium.launch({ args: BROWSER_ARGS });
  try {
    for (const shot of shots) {
      const frames = join(opts.work, "frames", shot.name);
      const t = Date.now();
      const f = await shoot(browser, base, shot, frames, recording.recordedAt, log, every);
      filmed.push(f);
      if (every === 1) {
        reel(frames, join(opts.out, `${shot.name}.mp4`));
        rmSync(frames, { recursive: true, force: true });
      }
      log(`${shot.name}: ${f.frames} frames in ${((Date.now() - t) / 1000).toFixed(0)} s`);
    }
  } finally {
    await browser.close();
    site?.stop();
  }

  // A partial film keeps the shots it did not touch.
  const file = join(opts.out, "film.json");
  const before: Filmed[] = opts.only && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as FilmManifest).shots : [];
  const manifest: FilmManifest = {
    v: 1,
    round: record.id,
    network: record.network,
    fps: FILM_FPS,
    width: 1920,
    height: 1080,
    chain: opts.answers ? "answers" : "record",
    // In the order the shots are listed, whichever run filmed them.
    shots: [...before.filter((b) => !filmed.some((f) => f.name === b.name)), ...filmed].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)),
  };
  if (every === 1) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
