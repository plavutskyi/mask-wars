/**
 * The tour's footage, taken off the live site: one reel a page, filmed frame by frame on the film's clock
 * (`film/page-clock.ts`) while the page is used as a person would use it. Every frame is 1/30 s of the page's own
 * time and every press, glide and letter lands on its beat, however slow the machine. The forge's reel and the home
 * page's reel under the first and last words are the demo film's own (`demo/capture.ts`).
 *
 * The film presses only what `mayPress` lets it: pickers, tabs, a sheet that opens and its Close. It asks the page
 * what a control is before it touches it, and stops the reel when the answer is anything else. No wallet is
 * connected, and nothing is signed, sent, hired or posted.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { forge, home } from "../demo/capture.ts";
import type { LeagueRow, Race, Rect, Tap } from "../demo/plan.ts";
import { REGION_H } from "../demo/plan.ts";
import { DESK_GL, pageClock } from "../film/page-clock.ts";
import { BROWSER_ARGS, FILM_FPS } from "../film/shoot.ts";
import type { Field, Filmed, Pressed, Reel, ReelName, Sel, TourData } from "./plan.ts";
import { beatFrame, latestFinished, mayEnter, mayPress, mayType, REEL_AT, reelFrames, reels, TOUR } from "./plan.ts";

/** The machine's graphics card in place of software WebGL: the same pixels, faster (as `scripts/live.mjs --gpu`). */
const GPU_ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"];
/** Seconds of the home page's reel: the first words, and the end card from a little into it. */
export const HOME_SECONDS = 8;

export const PARTS = ["data", "home", "watch", "race", "forge", "mask", "copy", "league", "jobs", "near", "swap", "check", "market", "connect", "github"] as const;
export type Part = (typeof PARTS)[number];
/** What a new round changes: its own page and the league's table. `--take round` films these two again. */
export const ROUND_PARTS: readonly Part[] = ["data", "race", "league"];

export type TourJob = {
  /** The round of chapter 1; null for the latest round that has ended. */
  round: string | null;
  mask: string;
  site: string;
  dir: string;
  parts: readonly Part[];
  gpu: boolean;
  log: (line: string) => void;
};

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

// ——— In the page ———

type Found = { box: Rect; pressed: Pressed; field: Field; value: string; words: string };
type TourApi = {
  find(sel: Sel): Element[];
  box(sel: Sel): Rect | null;
  describe(sel: Sel): Found | null;
  press(sel: Sel): boolean;
  read(sel: Sel, attr: string | null): string | null;
};
type FilmApi = { advance(ms: number): number; settled(): Promise<void>; marks: Record<string, number> };
declare const __film: FilmApi;
declare const __tour: TourApi;

/** The script that finds things on a page the way the plan names them. Serialised into the page: it uses nothing of this module. */
function inPage(): void {
  const words = (e: Element): string => (e.textContent ?? "").replace(/\s+/g, " ").trim();
  const find = (sel: Sel): Element[] => {
    const seen = [...document.querySelectorAll(sel.css)].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const re = sel.has ? new RegExp(sel.has, "i") : null;
    const hit = re ? seen.filter((e) => re.test(words(e))) : seen;
    return sel.last ? hit.slice(-1) : hit;
  };
  const boxOf = (els: Element[]): Rect | null => {
    if (!els.length) return null;
    const rs = els.map((e) => e.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.left));
    const y = Math.min(...rs.map((r) => r.top));
    return { x, y, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y };
  };
  const api: TourApi = {
    find,
    box: (sel) => boxOf(sel.union ? find(sel) : find(sel).slice(0, 1)),
    describe(sel) {
      const el = find(sel)[0];
      if (!el) return null;
      const at = (name: string): string => el.getAttribute(name) ?? "";
      return {
        box: boxOf([el])!,
        words: words(el),
        value: el instanceof HTMLInputElement ? el.value : "",
        pressed: {
          tag: el.tagName.toLowerCase(),
          role: at("role"),
          type: at("type"),
          text: words(el),
          label: at("aria-label"),
          href: at("href"),
          popup: at("aria-haspopup"),
          inDialog: el.closest('[role="dialog"]') !== null,
          inNav: el.closest("nav") !== null,
          inList: el.closest("li") !== null,
          group: el.closest('[role="radiogroup"]')?.getAttribute("aria-label") ?? "",
        },
        field: { tag: el.tagName.toLowerCase(), label: at("aria-label"), inCheck: el.closest('section[aria-label="MASK CHECK"]') !== null },
      };
    },
    press(sel) {
      const el = find(sel)[0];
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    },
    read(sel, attr) {
      const el = find(sel)[0];
      return el ? (attr ? el.getAttribute(attr) : words(el)) : null;
    },
  };
  (window as unknown as Record<string, unknown>)["__tour"] = api;
}

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const said = (sel: Sel): string => `${sel.css}${sel.has ? ` «${sel.has}»` : ""}`;

/**
 * One reel: the page opened in a window of the reel's width, drawn 1920×880, and used act by act while every frame
 * is stepped and kept. Returns where the presses landed, the boxes it measured and the words it read.
 */
export async function filmReel(browser: Browser, reel: Reel, dir: string, log: (line: string) => void): Promise<Filmed> {
  const { at } = REEL_AT[reel.name];
  const total = reelFrames(reel.name);
  const k = TOUR.width / reel.width;
  const height = (reel.width * REGION_H) / TOUR.width;
  if (!Number.isInteger(height)) throw new Error(`${reel.name}: a window ${reel.width} px wide is not a whole number of px tall under the caption bar`);
  const frames = join(dir, `${reel.name}-frames`);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });

  const ctx = await browser.newContext({ viewport: { width: reel.layout ?? reel.width, height }, deviceScaleFactor: k, colorScheme: "dark" });
  try {
    await ctx.addInitScript(pageClock(Date.now()));
    await ctx.addInitScript(DESK_GL);
    await ctx.addInitScript(`(${inPage.toString()})();`);
    const page = await ctx.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    const why = (): string => (problems.length ? `: ${[...new Set(problems)].slice(0, 3).join("; ")}` : "");
    await page.goto(reel.url, { waitUntil: "load", timeout: 120_000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const FRAME_MS = 1000 / FILM_FPS;
    // Two animation frames of 1/60 s a film frame, as the home page's reel is filmed (`scripts/live.mjs`).
    const step = (): Promise<Record<string, number>> =>
      page.evaluate(async (d) => {
        __film.advance(d);
        await __film.settled();
        __film.advance(d);
        await __film.settled();
        return { ...__film.marks };
      }, FRAME_MS / 2);
    const drawn = (): Promise<boolean> =>
      page.evaluate((ready) => {
        const onScreen = [...document.images].filter((i) => {
          const r = i.getBoundingClientRect();
          return (i.currentSrc || i.src) && r.width > 0 && r.bottom > 0 && r.top < innerHeight;
        });
        return (!ready || document.querySelector(ready) !== null) && onScreen.every((i) => i.complete && i.naturalWidth > 0);
      }, reel.ready ?? null);

    // Until the page is what a person sees: its pictures drawn, what the reel uses on it, and the 3D arena running.
    const since = Date.now();
    // The arena fades in over the still that stands in for it: the reel starts three seconds after its first frame.
    const lead = (reel.arena ? 3 : 1.5) * FILM_FPS;
    for (let i = 0, seen = 0, marks = await step(); ; i++, marks = await step()) {
      const ready = (await drawn()) && (!reel.arena || marks["ready"] !== undefined);
      seen = ready ? seen + 1 : 0;
      if (ready && i >= lead && seen >= lead) break;
      if (Date.now() - since > (reel.arena ? 180_000 : 90_000)) throw new Error(`${reel.name}: ${reel.url} did not come up${reel.arena ? " with its 3D arena" : ""}${why()}`);
      if (!ready) await page.waitForTimeout(60);
    }
    if (reel.prime) {
      // A long page of someone else's: walked top to bottom once, so pictures that load when seen are there on film.
      const tall = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < tall; y += height) {
        await page.evaluate((to) => window.scrollTo({ top: to, behavior: "instant" }), y);
        await step();
        await page.waitForTimeout(120);
      }
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      const until = Date.now() + 30_000;
      while (Date.now() < until && !(await page.evaluate(() => [...document.images].every((i) => !(i.currentSrc || i.src) || i.complete)))) await page.waitForTimeout(250);
      for (let i = 0; i < FILM_FPS; i++) await step();
    }

    // A band of a wider window: what stands in its middle is found once, before the first frame.
    const mid = reel.center ? await page.evaluate((s) => __tour.box(s), reel.center) : null;
    if (reel.center && !mid) throw new Error(`${reel.name}: the page has no ${said(reel.center)} to film${why()}`);
    const left = mid ? Math.max(0, Math.min((reel.layout ?? reel.width) - reel.width, Math.round(mid.x + mid.w / 2 - reel.width / 2))) : 0;
    const clip = { x: left, y: 0, width: reel.width, height };

    const due = new Map<number, (() => Promise<void>)[]>();
    const on = (frame: number, act: () => Promise<void>): void => void due.set(frame, [...(due.get(frame) ?? []), act]);
    const taps: Tap[] = [];
    const boxes: Record<string, Rect | null> = {};
    let glide: { from: number; to: number; first: number; frames: number } | null = null;
    const found = async (sel: Sel) => {
      const hit = await page.evaluate((s) => __tour.describe(s), sel);
      if (!hit) throw new Error(`${reel.name}: the page has no ${said(sel)}: it has changed${why()}`);
      return hit;
    };

    for (const act of reel.acts) {
      const frame = beatFrame(at, act.beat);
      if (frame >= total) throw new Error(`${reel.name}: an act on beat ${act.beat} is past the reel's end`);
      if ("tap" in act) {
        on(frame, async () => {
          const hit = await found(act.tap);
          const no = mayPress(hit.pressed, act.kind);
          if (no) throw new Error(`${reel.name}: the film does not press it: ${no}`);
          taps.push({ frame, x: (hit.box.x - left + hit.box.w / 2) * k, y: (hit.box.y + hit.box.h / 2) * k });
          await page.evaluate((s) => __tour.press(s), act.tap);
        });
      } else if ("scroll" in act) {
        on(frame, async () => {
          const target = act.scroll === "top" ? 0 : (await found(act.scroll)).box.y + (await page.evaluate(() => scrollY)) - (act.top ?? 0);
          const [from, max] = await page.evaluate(() => [scrollY, document.documentElement.scrollHeight - innerHeight] as const);
          glide = { from, to: Math.max(0, Math.min(max, target)), first: frame, frames: Math.max(1, beatFrame(at, act.beat + act.over) - frame - 1) };
        });
      } else if ("retype" in act) {
        on(frame, async () => {
          const hit = await found(act.retype);
          const no = mayType(hit.field);
          if (no) throw new Error(`${reel.name}: ${no}`);
          if (!hit.value) throw new Error(`${reel.name}: ${said(act.retype)} holds no words to type back`);
          taps.push({ frame, x: (hit.box.x - left + hit.box.w / 2) * k, y: (hit.box.y + hit.box.h / 2) * k });
          const focus = () => page.evaluate((s) => (__tour.find(s)[0] as HTMLElement | undefined)?.focus(), act.retype);
          await focus();
          await page.keyboard.press("Control+A");
          await page.keyboard.press("Backspace");
          [...hit.value].forEach((ch, i) => on(frame + (i + 2) * act.every, async () => (await focus(), await page.keyboard.insertText(ch))));
        });
      } else if ("enter" in act) {
        on(frame, async () => {
          const hit = await found(act.enter);
          const no = mayEnter(hit.field);
          if (no) throw new Error(`${reel.name}: ${no}`);
          await page.evaluate((s) => (__tour.find(s)[0] as HTMLElement | undefined)?.focus(), act.enter);
          await page.keyboard.press("Enter");
        });
      } else {
        on(frame, async () => {
          // Off the film: the page's time runs on while it waits for the network, and no frame of the wait is kept.
          const until = Date.now() + 60_000;
          for (let i = 0; ; i++) {
            const state = await page.evaluate((w) => {
              const failed = w.fail ? document.querySelector(w.fail) : null;
              if (failed) return (failed.textContent ?? "").replace(/\s+/g, " ").trim() || "refused";
              return (!w.there || document.querySelector(w.there) !== null) && (!w.gone || document.querySelector(w.gone) === null);
            }, act.wait);
            if (typeof state === "string") throw new Error(`${reel.name}: the page refused: ${state}`);
            if (state && i >= 4) return;
            if (Date.now() > until) throw new Error(`${reel.name}: the page did not answer in a minute (${act.wait.there ?? act.wait.gone})${why()}`);
            await step();
            await page.waitForTimeout(80);
          }
        });
      }
    }
    const measured = new Map<number, typeof reel.measures>();
    for (const m of reel.measures) measured.set(beatFrame(at, m.beat), [...(measured.get(beatFrame(at, m.beat)) ?? []), m]);

    const started = Date.now();
    for (let f = 0; f < total; f++) {
      for (const act of due.get(f) ?? []) await act();
      const g = glide as { from: number; to: number; first: number; frames: number } | null;
      if (g) {
        const t = Math.min(1, (f - g.first + 1) / g.frames);
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), g.from + (g.to - g.from) * easeInOut(t));
        if (t >= 1) glide = null;
      }
      await step();
      for (const m of measured.get(f) ?? []) {
        const b = await page.evaluate((s) => __tour.box(s), m.sel);
        boxes[m.name] = b ? { x: (b.x - left) * k, y: b.y * k, w: b.w * k, h: b.h * k } : null;
      }
      await page.screenshot({ path: join(frames, `${String(f + 1).padStart(5, "0")}.jpg`), type: "jpeg", quality: 95, clip });
      if ((f + 1) % 90 === 0) log(`${reel.name} ${f + 1}/${total} frames, ${((Date.now() - started) / (f + 1) / 1000).toFixed(2)} s a frame`);
    }
    const facts: Record<string, string | null> = {};
    for (const r of reel.reads) {
      const text = await page.evaluate(({ s, a }) => __tour.read(s, a), { s: r.sel, a: r.attr ?? null });
      facts[r.name] = text === null ? null : r.match ? (new RegExp(r.match, "i").exec(text)?.[1] ?? null) : text;
    }
    // What the film must never show: a wallet's window. NEAR Connect draws one only when a wallet is asked for.
    if (await page.evaluate(() => document.querySelector(".hot-connector-popup") !== null)) throw new Error(`${reel.name}: a wallet's window opened: the reel is not kept`);
    if (problems.length) log(`${reel.name}: the page said: ${[...new Set(problems)].slice(0, 3).join("; ")}`);

    const file = join(dir, `${reel.name}.mp4`);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FILM_FPS), "-i", join(frames, "%05d.jpg"), "-vf", `scale=${TOUR.width}:${REGION_H}:flags=lanczos`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "15", "-preset", "slow", file]);
    rmSync(frames, { recursive: true, force: true });
    return { frames: total, taps, boxes, facts };
  } finally {
    await ctx.close();
  }
}

/** Everything the tour is cut from, into `job.dir`; `data.json` there is the one file the film reads. */
export async function capture(job: TourJob): Promise<TourData> {
  mkdirSync(job.dir, { recursive: true });
  const file = join(job.dir, "data.json");
  const kept: Partial<TourData> & { reels?: Partial<TourData["reels"]> } = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as TourData) : {};
  const want = (p: Part): boolean => job.parts.includes(p);
  /** What is taken is kept at once: a reel that fails later does not cost the reels before it. */
  const keep = (part: Partial<TourData>): void => {
    Object.assign(kept, part, { mask: job.mask, site: job.site, capturedAt: Date.now() });
    writeFileSync(file, `${JSON.stringify(kept, null, 1)}\n`);
  };
  if (kept.mask !== undefined && kept.mask !== job.mask) throw new Error(`${file} follows ${kept.mask}: film every part again for ${job.mask}`);

  if (want("data") || !kept.race || !kept.league || (job.round !== null && kept.round !== job.round)) {
    const list = await json<{ races: Race[] }>(`${job.site}/api/races`);
    const id = job.round ?? latestFinished(list.races);
    if (!id) throw new Error(`${job.site} lists no round that has ended`);
    job.log(`round ${id} from ${job.site}`);
    const race = await json<Race>(`${job.site}/api/races/${encodeURIComponent(id)}`);
    if (race.id !== id) throw new Error(`${job.site} has no round ${id}`);
    if (kept.round !== undefined && kept.round !== id && !want("race")) throw new Error(`${file} holds the page of ${kept.round}: take race (or round) to film ${id}`);
    keep({ round: id, race, league: (await json<{ league: LeagueRow[] }>(`${job.site}/api/races/league`)).league });
  }
  const round = kept.round!;

  const filmed = reels(job.site, round, job.mask).filter((r) => want(r.name as Part));
  if (filmed.length || want("forge")) {
    const browser = await chromium.launch({ args: job.gpu ? GPU_ARGS : BROWSER_ARGS });
    try {
      for (const reel of filmed) {
        job.log(`${reel.name}: ${reel.url}`);
        const got = await filmReel(browser, reel, job.dir, job.log);
        keep({ reels: { ...kept.reels, [reel.name]: got } as TourData["reels"] });
      }
      if (want("forge")) {
        job.log("forge");
        keep({ forge: await forge(job, browser) });
      }
    } finally {
      await browser.close();
    }
  }
  if (want("home")) keep({ home: home({ ...job, homeSeconds: HOME_SECONDS }) });

  const reelNames = reels(job.site, round, job.mask).map((r) => r.name as Exclude<ReelName, "forge">);
  const lacks: string[] = [...reelNames.filter((n) => !kept.reels?.[n]), ...(kept.forge ? [] : ["forge"]), ...(kept.home ? [] : ["home"])];
  if (lacks.length) throw new Error(`${file} is not whole yet: take ${lacks.join(", ")}`);
  return kept as TourData;
}
