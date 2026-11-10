// A season round through real eyes: every state of the round (season-scenes.mjs) on the home page, the race page and
// a mask's page, on desk 1440×900, phone 375×812 and a small phone 360×640. The home page is shot twice: the flat
// first frame (what is on screen before the 3D arena, and all there is without WebGL) and the 3D arena once its
// moments have played. The browser's clock stands at the scene's own moment, so every countdown is the scene's.
// Checks the console, horizontal scroll, finger-sized targets, text leaving the screen and the 3D name plates
// touching each other or a mask.
// Usage: node apps/web/scripts/season-shots.mjs [out dir]   (build first: pnpm --filter @maskwars/web build)
//   ONLY=1-sealing,6-held  a part of the scenes;  VIEWS=desk,phone  a part of the screens;  PAGES=home3d,race  a part of the pages
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, SCENES } from './season-scenes.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const OUT = process.argv[2] ?? join(app, 'shots', 'season');
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (env, all) => (process.env[env] ? all.filter((x) => process.env[env].split(',').includes(x)) : all);

const VIEWS = {
  desk: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  small: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const views = pick('VIEWS', Object.keys(VIEWS));
const pages = pick('PAGES', ['home', 'home3d', 'info', 'race', 'mask', 'league']);
const scenes = SCENES.filter((s) => !process.env.ONLY || process.env.ONLY.split(',').includes(s.name));

// No GPU in a cloud box: WebGL runs on SwiftShader. Slow, but the pixels are the same.
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = { at: new Date().toISOString(), shots: [], problems: [] };
const problem = (where, what) => report.problems.push(`${where}: ${what}`);

/** The browser's clock stands at the scene's moment and runs on from there. */
const clockAt = (now) => `(() => { const real = Date.now.bind(Date); const off = ${now} - real(); Date.now = () => real() + off; })();`;
/**
 * The site keeps the flat arena on a software renderer, and gives the screen back when frames run slow. For the
 * pictures the box's SwiftShader passes for a GPU, and every frame is handed a steady 60 Hz clock: the scene keeps its
 * full quality and plays its moments frame by frame, only slower on the wall clock. `__frames` counts them.
 */
const PASS_GPU = `(() => {
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    return get.call(this, type, opts && typeof opts === 'object' ? { ...opts, failIfMajorPerformanceCaveat: false } : opts);
  };
  const param = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (p) {
    return p === 0x9246 ? 'ANGLE (the shot box)' : param.call(this, p);
  };
  // The box has four cores, where the arena would pick its simplified scene: it draws as on a person's own device.
  Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8 });
  const raf = window.requestAnimationFrame.bind(window);
  window.__frames = 0;
  window.requestAnimationFrame = (cb) => raf(() => cb((++window.__frames * 1000) / 60));
})();`;

/** Wait until the scene has drawn `n` more frames. */
async function frames(page, n) {
  const from = await page.evaluate(() => window.__frames);
  await page.waitForFunction(([a, b]) => window.__frames >= a + b, [from, n], { timeout: 600000, polling: 500 });
}

async function open(base, view, scene, path, { gpu = false } = {}) {
  const ctx = await browser.newContext({ ...VIEWS[view], colorScheme: 'dark' });
  await ctx.addInitScript(clockAt(scene.now));
  if (gpu) await ctx.addInitScript(PASS_GPU);
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, logs };
}

/** What a person would call crooked, measured: scroll sideways, small targets, text off the screen, plates in a pile. */
async function measure(page, where, logs) {
  const m = await page.evaluate(() => {
    const seen = (el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && Number(st.opacity) > 0.05 && !el.closest('[inert]');
    };
    const shown = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const st = getComputedStyle(e);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return false;
      }
      return true;
    };
    const name = (el) => (el.textContent?.trim() || el.getAttribute('aria-label') || el.tagName).slice(0, 40);
    const small = [...document.querySelectorAll('button, a')]
      .filter((el) => seen(el) && shown(el))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
      .map(({ el, r }) => `${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    // Text that leaves the screen sideways, or is cut by its own box.
    const off = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent.trim() || !shown(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width === 0 || el.closest('[class*="sr"]')) continue;
      if (r.left < -1 || r.right > innerWidth + 1) off.push(`"${n.textContent.trim().slice(0, 30)}" ${Math.round(r.left)}…${Math.round(r.right)}`);
    }
    // The 3D arena's name plates: none over another.
    const plates = [...document.querySelectorAll('section[aria-label="Arena"] [data-slot]')].filter((el) => shown(el)).map((el) => ({ t: name(el), r: el.getBoundingClientRect() }));
    const piled = [];
    for (let i = 0; i < plates.length; i++) {
      for (let j = i + 1; j < plates.length; j++) {
        const a = plates[i].r;
        const b = plates[j].r;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) piled.push(`${plates[i].t} over ${plates[j].t}`);
      }
    }
    return { hscroll: document.documentElement.scrollWidth > innerWidth, small, off, piled };
  });
  if (m.hscroll) problem(where, 'horizontal scroll');
  for (const s of m.small) problem(where, `target under 44 px: ${s}`);
  for (const s of m.off) problem(where, `text off the screen: ${s}`);
  for (const s of m.piled) problem(where, `plates touch: ${s}`);
  for (const l of logs) if (!/React DevTools|HMR|GPU stall|GL Driver Message/.test(l)) problem(where, l);
}

async function snap(page, name, logs, { full = false } = {}) {
  const file = `${name}.jpg`;
  await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 88, fullPage: full });
  await measure(page, name, logs);
  report.shots.push(file);
  console.log(file);
}

const servers = new Set();
function stop(server) {
  servers.delete(server);
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}
// However the run ends, no server stays behind on its port.
process.on('exit', () => servers.forEach(stop));

async function shootScene(scene, port) {
  const { recording, view } = await record(scene);
  const dir = mkdtempSync(join(tmpdir(), 'season-'));
  const fixture = join(dir, `${scene.name}.json`);
  writeFileSync(fixture, JSON.stringify(recording));
  const base = `http://localhost:${port}`;
  // A server left on the port by an earlier run would answer with another build's pages.
  if (await fetch(base).then(() => true, () => false)) throw new Error(`port ${port} is taken: stop the server on it first`);
  const server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], { cwd: app, stdio: 'ignore', detached: true, env: { ...process.env, ARENA_FIXTURE: fixture } });
  servers.add(server);
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(base)).ok) break;
      } catch {
        /* not yet */
      }
      await wait(500);
    }
    const race = view.now;
    const who = race.winner?.slug ?? 'oracle';
    for (const v of views) {
      if (pages.includes('home') || pages.includes('info')) {
        // The flat first frame: the arena before 3D, and the whole arena where WebGL does not run.
        const { ctx, page, logs } = await open(base, v, scene, '/');
        await wait(2600);
        if (pages.includes('home')) await snap(page, `${scene.name}-home-flat-${v}`, logs);
        // The quiet «i»: everything technical, one tap away.
        const info = page.getByRole('button', { name: /on chain|came from|^The race$/ }).first();
        if (pages.includes('info') && v !== 'small' && (await info.count())) {
          await info.click();
          await wait(600);
          await snap(page, `${scene.name}-home-info-${v}`, []);
        }
        await ctx.close();
      }
      if (pages.includes('home3d')) {
        const { ctx, page, logs } = await open(base, v, scene, '/', { gpu: true });
        await page.waitForSelector('main[data-three]', { timeout: 180000 });
        // The scene dissolves in, then the round's own moments play: the break, the payout, the bolts.
        const rest = race.phase === 'broken' ? (race.payout ? 'paid' : 'breach') : race.phase === 'held' ? 'held' : race.phase === 'racing' ? 'live' : 'idle';
        await page.waitForSelector(`section[aria-label="Arena"][data-state="${rest}"]`, { timeout: 180000 });
        await frames(page, rest === 'paid' ? 280 : rest === 'breach' ? 180 : rest === 'idle' ? 40 : 120);
        await wait(1500);
        await snap(page, `${scene.name}-home-3d-${v}`, logs);
        await ctx.close();
      }
      if (pages.includes('race')) {
        const { ctx, page, logs } = await open(base, v, scene, `/race/${race.id}`);
        await wait(1600);
        await snap(page, `${scene.name}-race-${v}`, logs);
        if (v !== 'small') await snap(page, `${scene.name}-race-full-${v}`, [], { full: true });
        await ctx.close();
      }
      if (pages.includes('mask')) {
        const { ctx, page, logs } = await open(base, v, scene, `/mask/${who}`);
        await wait(1600);
        await snap(page, `${scene.name}-mask-${v}`, logs);
        if (v !== 'small') await snap(page, `${scene.name}-mask-full-${v}`, [], { full: true });
        await ctx.close();
      }
      if (pages.includes('league') && v !== 'small') {
        const { ctx, page, logs } = await open(base, v, scene, '/league');
        await wait(1200);
        await snap(page, `${scene.name}-league-${v}`, logs);
        await ctx.close();
      }
    }
  } finally {
    stop(server);
  }
}

// Scenes side by side, each on its own server: the box's cores draw the 3D frames in software.
const LANES = Number(process.env.LANES ?? 2);
const PORT = Number(process.env.PORT ?? 3140);
let next = 0;
await Promise.all(
  Array.from({ length: LANES }, async () => {
    while (next < scenes.length) {
      const scene = scenes[next++];
      try {
        // A port of its own for every scene: the server of the scene before may still be on its way out.
        await shootScene(scene, PORT + SCENES.indexOf(scene));
      } catch (e) {
        problem(scene.name, `the scene was not shot to the end: ${e.message.split('\n')[0]}`);
      }
    }
  }),
);

await browser.close();
report.shots.sort();
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.shots.length} shots in ${OUT}`);
console.log(report.problems.length ? report.problems.join('\n') : 'no problems');
