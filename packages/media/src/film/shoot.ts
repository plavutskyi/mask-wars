/**
 * Films one shot of the running site, frame by frame: the page's clock is the film's (`page-clock.ts`), every frame
 * is 1/30 s of the page's time and one screenshot. The frames land in a folder as `00001.jpg`…, cut to the shot's
 * window around its mark, with the marks it passed as frame numbers.
 */

import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser } from "playwright";
import { DESK_GL, pageClock } from "./page-clock.ts";
import type { Shot } from "./shots.ts";

export const FILM_FPS = 30;
const FRAME_MS = 1000 / FILM_FPS;
/** Software WebGL in headless Chromium: slow, and the pixels are the same. */
export const BROWSER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

export type Filmed = {
  name: string;
  /** Frames kept, `00001.jpg` first. */
  frames: number;
  /** The shot's moments as frame numbers from its first kept frame (0-based); a moment before the cut is negative. */
  marks: Record<string, number>;
  /** Page seconds per film second after the shot's slow-motion mark; 1 at full speed. */
  rate: number;
  /** The reel's width, px: 1920, or more for a band of a page the clip pans along. Always 1080 tall. */
  width: number;
};

type FilmApi = { advance(ms: number): number; now(): number; marks: Record<string, number>; rewind(): void; settled(): Promise<void> };
declare const __film: FilmApi;

const name5 = (n: number): string => `${String(n).padStart(5, "0")}.jpg`;

export async function shoot(browser: Browser, base: string, shot: Shot, dir: string, epochMs: number, log: (line: string) => void = () => {}, every = 1): Promise<Filmed> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const v = shot.viewport;
  const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: shot.strip?.scale ?? v.scale, colorScheme: "dark" });
  try {
    await ctx.addInitScript(pageClock(epochMs));
    await ctx.addInitScript(DESK_GL);
    if (shot.camera) await ctx.addInitScript(`window.__arenaFilm = (f) => (${shot.camera})(f, window.__film);`);
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()}`);
    });
    await page.goto(`${base}${shot.path}`, { waitUntil: "load", timeout: 120_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    if (shot.css) await page.addStyleTag({ content: shot.css });

    const step = async (ms: number): Promise<{ now: number; marks: Record<string, number> }> =>
      page.evaluate(async (d) => {
        __film.advance(d);
        await __film.settled();
        return { now: __film.now(), marks: { ...__film.marks } };
      }, ms);

    // Until the page is what a person sees: hydrated, and for an arena shot the 3D scene on screen.
    let at = await step(FRAME_MS);
    if (shot.kind === "arena") {
      const until = Date.now() + 180_000;
      while (at.marks["ready"] === undefined) {
        if (Date.now() > until) throw new Error(`${shot.name}: the 3D arena did not start in 3 minutes${problems.length ? `: ${problems.join("; ")}` : ""}`);
        at = await step(FRAME_MS);
      }
    } else {
      for (let i = 0; i < 6; i++) at = await step(FRAME_MS);
      await page.evaluate(() => __film.rewind());
      at.marks["start"] = at.now;
    }
    const origin = shot.kind === "arena" ? at.marks["ready"]! : at.marks["start"]!;

    // A band of the page: the element's full width, 1080 film px tall, an even number of film px wide.
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    let width = 1920;
    if (shot.strip) {
      const st = shot.strip;
      const box = await page.locator(st.selector).first().boundingBox();
      if (!box) throw new Error(`${shot.name}: nothing on the page matches ${st.selector}`);
      const pad = st.pad ?? 0;
      const h = 1080 / st.scale;
      const w = (Math.floor(((box.width + 2 * pad) * st.scale) / 2) * 2) / st.scale;
      clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y + box.height / 2 + (st.shift ?? 0) - h / 2), width: w, height: h };
      width = Math.round(w * st.scale);
    }

    // Frames: nothing is drawn to disk before `lead`, then every frame until the cut's end is known and passed.
    const taken: { file: string; now: number }[] = [];
    const slow = shot.slow ?? null;
    let marks = at.marks;
    const startedAt = Date.now();
    for (let guard = 0; guard < 3000; guard++) {
      const rate = slow && marks[slow.mark] !== undefined && at.now >= marks[slow.mark]! + slow.from * 1000 ? slow.rate : 1;
      at = await step(FRAME_MS * rate);
      marks = shot.kind === "arena" ? at.marks : { ...at.marks, start: origin };
      if (at.now - origin < (shot.lead ?? 0) * 1000) continue;
      const file = join(dir, `raw-${name5(taken.length)}`);
      // A rehearsal (`every` > 1) draws only some frames to disk; the page still lives through every one of them.
      if (taken.length % every === 0) await page.screenshot({ path: file, type: "jpeg", quality: 96, ...(clip ? { clip } : {}) });
      taken.push({ file, now: at.now });
      const m = marks[shot.cut.mark];
      if (m !== undefined) {
        const after = taken.filter((t) => t.now >= m).length;
        if (after >= Math.ceil(shot.cut.to * FILM_FPS) + 1) break;
      }
      if (taken.length % 30 === 0) log(`${shot.name}: ${taken.length} frames, ${((Date.now() - startedAt) / taken.length / 1000).toFixed(2)} s a frame`);
    }
    const m = marks[shot.cut.mark];
    if (m === undefined) throw new Error(`${shot.name}: the page never reached "${shot.cut.mark}"${problems.length ? `: ${problems.join("; ")}` : ""}`);
    // Film frames, not page time: slow motion stretches the page's seconds over more frames.
    const zero = taken.findIndex((t) => t.now >= m);
    const first = zero + Math.round(shot.cut.from * FILM_FPS);
    const last = zero + Math.round(shot.cut.to * FILM_FPS);
    if (first < 0 || last >= taken.length) throw new Error(`${shot.name}: the cut ${shot.cut.from}…${shot.cut.to} s around "${shot.cut.mark}" is outside what was filmed (${taken.length} frames, the mark at ${zero}): lower its lead`);
    taken.forEach((t, i) => {
      if (i % every !== 0) return;
      if (i < first || i > last) rmSync(t.file);
      else renameSync(t.file, join(dir, name5(i - first + 1)));
    });
    const frameOf = (ms: number): number => {
      const i = taken.findIndex((t) => t.now >= ms);
      return (i < 0 ? taken.length : i) - first;
    };
    const kept = readdirSync(dir).filter((f) => /^\d{5}\.jpg$/.test(f)).length;
    if (problems.length) log(`${shot.name}: the page said: ${[...new Set(problems)].join("; ")}`);
    return { name: shot.name, frames: kept, marks: Object.fromEntries(Object.entries(marks).map(([k, ms]) => [k, frameOf(ms)])), rate: slow?.rate ?? 1, width };
  } finally {
    await ctx.close();
  }
}
