/**
 * The demo film's footage, taken off the live site: the round's numbers from the site's own API, the pages a camera
 * moves over as pictures at twice the desk's density, and two reels filmed frame by frame on the film's clock
 * (`film/page-clock.ts`): the home page with its 3D arena (`scripts/live.mjs`) and the forge, tapped step by step.
 *
 * The forge is walked up to the mask's name and no further: the film never presses Forge, so no wallet opens and
 * nothing is signed. Nothing is posted to the site either: the picks on the home page are filmed, not tapped.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { DESK_GL, pageClock } from "../film/page-clock.ts";
import { BROWSER_ARGS, FILM_FPS } from "../film/shoot.ts";
import type { DemoData, ForgeStep, LeagueRow, Race, Rect, Tap } from "./plan.ts";
import { DEMO, FORGE_FRAMES, FORGE_PLAN, forgeActs, forgeFrame, REGION_H } from "./plan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(here, "../..");

/** The desk the site is checked at, and the pictures' density: a camera may come twice as close and stay sharp. */
export const DESK = { width: 1440, height: 810 } as const;
export const STILL_SCALE = 2;
/** The forge's own window: as wide as it must be for the whole page to stand above the caption bar, 1920×880 on film. */
const FORGE_VIEW = { width: 1512, height: 693 } as const;

export const PARTS = ["data", "stills", "forge", "home"] as const;
export type Part = (typeof PARTS)[number];

export type CaptureJob = {
  id: string;
  mask: string;
  site: string;
  dir: string;
  /** What to take again; the rest is kept as it lies in `dir`. */
  parts: readonly Part[];
  /** Draw the 3D arena with the machine's graphics card. */
  gpu: boolean;
  /** Seconds of the home page to film. */
  homeSeconds: number;
  log: (line: string) => void;
};

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

const settle = async (page: Page, ms = 2500): Promise<void> => {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(ms);
};

const shot = async (page: Page, file: string, fullPage: boolean): Promise<void> => {
  writeFileSync(file, await page.screenshot({ type: "jpeg", quality: 93, fullPage }));
};

/** A box of the page in its own px, scroll included; null when the page has no such thing. */
const box = (page: Page, selector: string): Promise<Rect | null> =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }, selector);

async function open(browser: Browser, url: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: DESK, deviceScaleFactor: STILL_SCALE, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  return page;
}

type Boxes = DemoData["boxes"];

/** The pages a camera moves over, each as one picture, with the boxes the camera aims at. */
async function stills(job: CaptureJob, browser: Browser): Promise<{ boxes: Boxes; maskPage: DemoData["maskPage"] }> {
  const at = (name: string) => join(job.dir, `${name}.jpg`);

  job.log("race page");
  let page = await open(browser, `${job.site}/race/${job.id}`);
  const hero = await box(page, "main section");
  if (!hero) throw new Error(`${job.site}/race/${job.id} is not a race page: no round ${job.id} on the site`);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('section[aria-labelledby="course"] ol > li[data-kind]')].map((li) => {
      const r = li.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, kind: li.dataset["kind"] ?? "", breaks: /the break/i.test(li.textContent ?? "") };
    }),
  );
  await shot(page, at("race"), true);
  await page.context().close();

  job.log("league");
  page = await open(browser, `${job.site}/league`);
  const table = await box(page, 'section[aria-label="League table"]');
  if (!table) throw new Error("the league page has no table");
  const leagueRows = await page.evaluate(() =>
    [...document.querySelectorAll('section[aria-label="League table"] ol > li')].map((li) => {
      const r = li.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    }),
  );
  const forged = await box(page, 'section[aria-labelledby="forged"]');
  const forgedRow = await page.evaluate((name) => {
    const li = [...document.querySelectorAll('section[aria-labelledby="forged"] ol > li')].find((l) => (l.textContent ?? "").toUpperCase().includes(name));
    if (!li) return null;
    const r = li.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  }, job.mask.toUpperCase());
  await shot(page, at("league"), true);
  await page.context().close();

  job.log(`mask page: ${job.mask}`);
  page = await open(browser, `${job.site}/mask/${job.mask}`);
  const maskHero = await box(page, "main section");
  const said = await page.evaluate(() => {
    const hero = document.querySelector("main section");
    const lines = [...(hero?.querySelectorAll("p, span") ?? [])].map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
    return { title: hero?.querySelector("h1")?.textContent?.trim() ?? null, forged: lines.find((t) => /^forged\b/i.test(t)) ?? null, state: lines.find((t) => /^(ready to race|racing|in the round|out of fuel|resting)/i.test(t)) ?? null };
  });
  if (!maskHero || said.title?.toUpperCase() !== job.mask.toUpperCase()) throw new Error(`${job.site}/mask/${job.mask} is not the page of ${job.mask.toUpperCase()}`);
  await shot(page, at("mask"), true);
  await page.context().close();

  job.log("get NEAR");
  page = await open(browser, `${job.site}/near`);
  const networks = await page.evaluate(() => {
    const m = /(\d+)\s+networks/i.exec(document.body.textContent ?? "");
    return m ? Number(m[1]) : null;
  });
  await shot(page, at("near"), false);
  // The coin's own button opens the list of coins and networks: a second picture of the same page.
  const coin = page.getByRole("button", { name: /usdc/i }).first();
  if (await coin.count()) {
    await coin.click();
    await page.waitForTimeout(1500);
    await shot(page, at("near-open"), false);
  } else {
    writeFileSync(at("near-open"), readFileSync(at("near")));
  }
  await page.context().close();

  job.log("connect an agent");
  page = await open(browser, `${job.site}/mcp/connect`);
  const panel = await box(page, 'section[aria-label="Connect"]');
  const code = await page.evaluate(() => {
    const el = document.querySelector("[data-text]")?.parentElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  });
  await shot(page, at("connect"), true);
  await page.context().close();

  job.log("home page, the picks");
  const ctx = await browser.newContext({ viewport: DESK, deviceScaleFactor: STILL_SCALE, colorScheme: "dark" });
  await ctx.addInitScript(DESK_GL);
  page = await ctx.newPage();
  await page.goto(`${job.site}/`, { waitUntil: "load", timeout: 120_000 });
  await settle(page, 14_000);
  const picks = await page.evaluate(() => {
    const head = [...document.querySelectorAll("h2, h3, p, span, div")].find((e) => /^who breaks it\?$/i.test((e.textContent ?? "").trim()));
    const tiles = [...document.querySelectorAll("button")].filter((b) => /^(vault\s*holds)$/i.test((b.textContent ?? "").replace(/\s+/g, " ").trim()));
    if (!head || !tiles.length) return null;
    const a = head.getBoundingClientRect();
    const group = tiles[0]!.parentElement!.getBoundingClientRect();
    const x = Math.min(a.left, group.left);
    const right = Math.max(a.right, group.right);
    return { x, y: a.top, w: right - x, h: group.bottom - a.top };
  });
  await shot(page, at("home"), false);
  await ctx.close();

  return { boxes: { race: { hero, rows }, league: { table, rows: leagueRows, forged, forgedRow }, mask: { hero: maskHero }, home: { picks }, near: { networks }, connect: { code, panel } }, maskPage: { forged: said.forged, state: said.state } };
}

type FilmApi = { advance(ms: number): number; settled(): Promise<void> };
declare const __film: FilmApi;

/**
 * The forge, filmed frame by frame while it is tapped: every frame is 1/30 s of the page's own time, so its fades and
 * its typing play at full speed however slow the machine. Returns the taps as they landed.
 */
export async function forge(job: Pick<CaptureJob, "dir" | "mask" | "site" | "log">, browser: Browser): Promise<DemoData["forge"]> {
  const frames = join(job.dir, "forge-frames");
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const k = DEMO.width / FORGE_VIEW.width;
  if (Math.round(FORGE_VIEW.height * k) !== REGION_H) throw new Error("the forge's window does not fill the picture above the caption bar");
  const ctx = await browser.newContext({ viewport: FORGE_VIEW, deviceScaleFactor: k, colorScheme: "dark" });
  await ctx.addInitScript(pageClock(Date.now()));
  await ctx.addInitScript(DESK_GL);
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(`${job.site}/forge`, { waitUntil: "load", timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const FRAME_MS = 1000 / FILM_FPS;
  const step = () =>
    page.evaluate(async (d) => {
      __film.advance(d);
      await __film.settled();
      __film.advance(d);
      await __film.settled();
    }, FRAME_MS / 2);

  // The page is filmed once the forge has read its factory: every step is there and every face is drawn.
  const ready = () =>
    page.evaluate(() => {
      const count = document.querySelector('form [aria-label^="Step 1 of"]')?.getAttribute("aria-label") ?? "";
      const faces = [...document.images].filter((i) => i.currentSrc || i.src);
      return /of 6$/.test(count) && document.querySelectorAll('form [role="radio"]').length >= 3 && faces.length > 0 && faces.every((i) => i.complete && i.naturalWidth > 0);
    });
  const since = Date.now();
  for (let i = 0; !(await ready()) || i < 2 * FILM_FPS; i++) {
    if (Date.now() - since > 90_000) throw new Error(`the forge at ${job.site}/forge did not open with its six steps: ${problems.join("; ") || "no factory answer"}`);
    await step();
  }

  const label = () => page.evaluate(() => (document.querySelector('form [id$="-label"]')?.textContent ?? "").trim());
  /** Taps what a person would tap, and says where: the middle of the control, in px of the reel. */
  const tap = async (words: string | null): Promise<{ x: number; y: number }> => {
    const at = await page.evaluate((w) => {
      const want = w?.toLowerCase() ?? null;
      const el = want === null ? document.querySelector<HTMLElement>('form button[type="submit"]') : [...document.querySelectorAll<HTMLElement>('form [role="radio"]')].find((b) => (b.textContent ?? "").replace(/\s+/g, " ").toLowerCase().includes(want));
      if (!el) return null;
      if (want === null && !/^(next|skip)$/i.test((el.textContent ?? "").trim())) return "not next";
      const r = el.getBoundingClientRect();
      el.click();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, words);
    if (at === "not next") throw new Error("the forge's button is not Next: the film does not press Forge");
    if (!at) throw new Error(`the forge has no ${words === null ? "button" : `choice «${words}»`} on its ${await label()} step`);
    return { x: at.x * k, y: at.y * k };
  };
  const key = async (ch: string): Promise<void> => {
    await page.evaluate(() => document.querySelector<HTMLInputElement>("form input")?.focus());
    await page.keyboard.insertText(ch);
  };

  // The acts, as frames: a tap or a next on its beat, a line typed letter by letter from its beat.
  const due = new Map<number, (() => Promise<void>)[]>();
  const on = (frame: number, act: () => Promise<void>) => due.set(frame, [...(due.get(frame) ?? []), act]);
  const taps: Tap[] = [];
  const stepIs = async (want: ForgeStep) => {
    const now = await label();
    if (now.toLowerCase() !== want.toLowerCase()) throw new Error(`the forge is on its ${now || "?"} step where the film expects ${want}: its steps have changed`);
  };
  for (const act of forgeActs(job.mask)) {
    const frame = forgeFrame(act.beat);
    if ("tap" in act) on(frame, async () => (await stepIs(act.step), void taps.push({ frame, ...(await tap(act.tap)) })));
    else if ("next" in act) on(frame, async () => (await stepIs(act.step), void taps.push({ frame, ...(await tap(null)) })));
    else [...(act.type === "plan" ? FORGE_PLAN : job.mask)].forEach((ch, i) => on(frame + i * act.every, async () => (i === 0 ? await stepIs(act.step) : undefined, await key(ch))));
  }
  const last = Math.max(...due.keys());
  if (last >= FORGE_FRAMES) throw new Error("the forge's acts run past its reel");

  const started = Date.now();
  for (let f = 0; f < FORGE_FRAMES; f++) {
    for (const act of due.get(f) ?? []) await act();
    await step();
    await page.screenshot({ path: join(frames, `${String(f + 1).padStart(5, "0")}.jpg`), type: "jpeg", quality: 95 });
    if ((f + 1) % 90 === 0) job.log(`forge ${f + 1}/${FORGE_FRAMES} frames, ${((Date.now() - started) / (f + 1) / 1000).toFixed(2)} s a frame`);
  }
  // What the film must never show: a wallet, or a forge under way.
  const phase = await page.evaluate(() => document.querySelector("[data-phase]")?.getAttribute("data-phase"));
  if (phase !== "choose") throw new Error(`the forge left its steps (${phase}): the reel is not kept`);
  await ctx.close();
  const file = join(job.dir, "forge.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FILM_FPS), "-i", join(frames, "%05d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "15", "-preset", "slow", file]);
  rmSync(frames, { recursive: true, force: true });
  return { frames: FORGE_FRAMES, taps };
}

/** The home page as it stands this minute, with its 3D arena: `scripts/live.mjs`, the reel every film of the site uses. */
export function home(job: Pick<CaptureJob, "dir" | "site" | "gpu" | "homeSeconds">): DemoData["home"] {
  const file = join(job.dir, "home.mp4");
  const args = [join(MEDIA, "scripts/live.mjs"), `${job.site}/`, file, "--seconds", String(job.homeSeconds), "--lead", "1", ...(job.gpu ? ["--gpu"] : [])];
  const r = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error("the home page was not filmed");
  return { frames: Math.round(job.homeSeconds * FILM_FPS) };
}

/** Everything the film is cut from, into `job.dir`; `data.json` there is the one file the film reads. */
export async function capture(job: CaptureJob): Promise<DemoData> {
  mkdirSync(job.dir, { recursive: true });
  const file = join(job.dir, "data.json");
  const kept: Partial<DemoData> = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DemoData) : {};
  const want = (p: Part) => job.parts.includes(p);
  /** What is taken is kept at once: a part that fails later does not cost the parts before it. */
  const keep = (part: Partial<DemoData>) => {
    Object.assign(kept, part, { id: job.id, mask: job.mask, site: job.site, capturedAt: Date.now() });
    writeFileSync(file, `${JSON.stringify(kept, null, 1)}\n`);
  };
  if (kept.id !== undefined && (kept.id !== job.id || kept.mask !== job.mask)) throw new Error(`${file} is of ${kept.id} and ${kept.mask}`);

  if (want("data") || !kept.race || !kept.league) {
    job.log(`round ${job.id} from ${job.site}`);
    const race = await json<Race>(`${job.site}/api/races/${encodeURIComponent(job.id)}`);
    if (race.id !== job.id) throw new Error(`${job.site} has no round ${job.id}`);
    keep({ race, league: (await json<{ league: LeagueRow[] }>(`${job.site}/api/races/league`)).league });
  }
  if (want("stills") || want("forge")) {
    const browser = await chromium.launch({ args: BROWSER_ARGS });
    try {
      if (want("stills")) keep(await stills(job, browser));
      if (want("forge")) keep({ forge: await forge(job, browser) });
    } finally {
      await browser.close();
    }
  }
  if (want("home")) keep({ home: home(job) });

  const partOf = { race: "data", league: "data", maskPage: "stills", boxes: "stills", forge: "forge", home: "home" } as const;
  const lacks = [...new Set((Object.keys(partOf) as (keyof typeof partOf)[]).filter((k) => kept[k] === undefined).map((k) => partOf[k]))];
  if (lacks.length) throw new Error(`${file} is not whole yet: take ${lacks.join(", ")}`);
  return kept as DemoData;
}
