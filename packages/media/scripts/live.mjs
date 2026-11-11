// The live site, filmed now: a page of maskwars.xyz as it stands this minute, frame by frame at 1920×1080 and
// 30 frames a second. The page's clock is the film's (src/film/page-clock.ts), started at the real time, so the 3D arena
// plays smooth however slow the machine draws it, and every clock on the page reads the real minute it was filmed at.
// For what only exists while a round is on: the countdown, the seals, the picks closing, the race page in motion.
//
//   node scripts/live.mjs <url> <out.mp4> [--seconds 10] [--lead 2] [--gpu] [--at 2026-11-11T19:33:50Z]
//
// Needs ffmpeg. About 1.3 s a frame on a machine with no GPU.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { DESK_GL, pageClock } from "../src/film/page-clock.ts";
import { BROWSER_ARGS, FILM_FPS } from "../src/film/shoot.ts";

const argv = process.argv.slice(2);
const flag = (name, d) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const VALUE_FLAGS = ["--seconds", "--lead", "--at"];
const [url, out] = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1] ?? ""));
if (!url || !out) {
  console.error("usage: live <url> <out.mp4> [--seconds 10] [--lead 2]");
  process.exit(2);
}
const seconds = flag("--seconds", 10);
const lead = flag("--lead", 2);
const FRAME_MS = 1000 / FILM_FPS;
const file = resolve(out);
const frames = join(dirname(file), `${Date.now()}-frames`);
mkdirSync(frames, { recursive: true });

// --gpu draws with the machine's graphics card (Direct3D on Windows) instead of software WebGL: the same pixels, faster.
const GPU_ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({ args: argv.includes("--gpu") ? GPU_ARGS : BROWSER_ARGS });
try {
  // The page as a 1440 px desk lays it out, drawn at 1920×1080: the width the site is checked at.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: "dark" });
  // --at starts the page's clock at a moment of the round (the last seconds before it opens), for a countdown that runs
  // out on film; what the page reads from the server is still what stands now.
  const startMs = argv.includes("--at") ? Date.parse(argv[argv.indexOf("--at") + 1]) : Date.now();
  if (!Number.isFinite(startMs)) throw new Error("--at: not a time, e.g. 2026-11-11T19:33:50Z");
  await ctx.addInitScript(pageClock(startMs));
  await ctx.addInitScript(DESK_GL);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // Two animation frames of 1/60 s for each film frame: the site's own build keeps its scene at full quality only while
  // frames come faster than 1/42 s (arena3d engine `measure`), and a step of a whole film frame would read as slow.
  const step = () =>
    page.evaluate(async (d) => {
      __film.advance(d);
      await __film.settled();
      __film.advance(d);
      await __film.settled();
      return { now: __film.now(), marks: { ...__film.marks } };
    }, FRAME_MS / 2);
  // A page with the 3D arena is filmed from its first drawn frame, not over the still picture that stands in before it:
  // up to 20 s of page time for `ready`. A page without the arena never says it and is filmed after that wait.
  let at = await step();
  for (let i = 0; i < 20 * FILM_FPS && at.marks.ready === undefined; i++) {
    at = await step();
    if (i === 3 * FILM_FPS && (await page.locator("[data-state]").count()) === 0) break;
  }
  for (let i = 0; i < lead * FILM_FPS; i++) await step();
  const total = Math.round(seconds * FILM_FPS);
  const started = Date.now();
  for (let i = 1; i <= total; i++) {
    await step();
    await page.screenshot({ path: join(frames, `${String(i).padStart(5, "0")}.jpg`), type: "jpeg", quality: 95 });
    if (i % 60 === 0) console.log(`${i}/${total} frames, ${((Date.now() - started) / i / 1000).toFixed(2)} s a frame`);
  }
} finally {
  await browser.close();
}
const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FILM_FPS), "-i", join(frames, "%05d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", file], { stdio: "inherit" });
if (ff.status !== 0) process.exit(ff.status ?? 1);
rmSync(frames, { recursive: true, force: true });
console.log(file);
