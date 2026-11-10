// The arena through real eyes: the home page, a race, a mask and the league, on desk 1440×900 and phone 375×812
// (and 390×844, 360×740), with reduced motion; /break, its empty submit and the 404. Checks the console, layout shift,
// LCP, horizontal scroll and finger-sized targets. Without a base it starts `next start` on the recorded testnet
// answers (packages/arena/test/fixtures/testnet.json), so every number on the shots is a real one, read with no network.
// Usage: node apps/web/scripts/shots.mjs [base]   (build first: pnpm --filter @maskwars/web build)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const SHOTS = join(app, 'shots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
let BASE = process.argv[2];
if (!BASE) {
  const port = 3123;
  BASE = `http://localhost:${port}`;
  server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
    cwd: app,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, ARENA_FIXTURE: '../../packages/arena/test/fixtures/testnet.json' },
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      /* not yet */
    }
    await wait(500);
  }
}

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['tablet', { viewport: { width: 1096, height: 1206 }, deviceScaleFactor: 1 }],
  ['phone390', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['small', { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];
const REDUCED = [
  ['desk-reduced', { ...VIEWS[0][1], reducedMotion: 'reduce' }],
  ['phone-reduced', { ...VIEWS[1][1], reducedMotion: 'reduce' }],
];
/** The four pages of the arena: path, shot name, settle time (the vault opens, the result rises). */
const PAGES = [
  ['/', 'home', 2400],
  ['/race/race-0003', 'race', 1600],
  ['/mask/nova', 'mask', 1600],
  ['/league', 'league', 1200],
];
const LIMITS = { cls: 0.02, lcp: 2500 };

const report = { base: BASE, at: new Date().toISOString(), shots: [], problems: [] };
const problem = (where, what) => report.problems.push(`${where}: ${what}`);

const browser = await chromium.launch();

async function open(opts, path) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await ctx.addInitScript(() => {
    window.__cls = 0;
    window.__lcp = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1);
      if (last) window.__lcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, logs };
}

async function measure(page, where, logs) {
  const m = await page.evaluate(() => {
    const small = [...document.querySelectorAll('button, a')]
      .filter((el) => !el.closest('[inert]'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44))
      .map(({ el, r }) => `${el.textContent?.trim() || el.getAttribute('aria-label')} ${Math.round(r.width)}×${Math.round(r.height)}`);
    return {
      cls: Number(window.__cls.toFixed(4)),
      lcp: Math.round(window.__lcp),
      hscroll: document.documentElement.scrollWidth > innerWidth,
      small,
    };
  });
  if (m.cls > LIMITS.cls) problem(where, `CLS ${m.cls}`);
  if (m.lcp > LIMITS.lcp) problem(where, `LCP ${m.lcp} ms`);
  if (m.hscroll) problem(where, 'horizontal scroll');
  for (const s of m.small) problem(where, `target under 44 px: ${s}`);
  for (const l of logs) problem(where, l);
  return m;
}

async function shoot(view, opts, path, name, settle, { act, full = false } = {}) {
  const where = `${name}-${view}`;
  const { ctx, page, logs } = await open(opts, path);
  await wait(settle);
  if (act) await act(page);
  const file = `${where}.jpg`;
  await page.screenshot({ path: join(SHOTS, file), type: 'jpeg', quality: 86, fullPage: full });
  const m = await measure(page, where, logs);
  report.shots.push({ file, ...m });
  await ctx.close();
}

async function fillBreak(page) {
  await page.getByLabel('Repository').fill('github.com/acme/lending-pool');
  await page.getByRole('button', { name: /next/i }).click();
  await page.getByRole('button', { name: '$5,000' }).click();
  await page.getByRole('button', { name: /next/i }).click();
  await page.getByLabel('Contact').fill('@acme');
  await wait(300);
}

for (const [view, opts] of VIEWS) {
  for (const [path, name, settle] of PAGES) await shoot(view, opts, path, name, settle);
}

// The whole course of a race and a mask's record, top to bottom.
for (const [view, opts] of VIEWS.slice(0, 2)) {
  await shoot(view, opts, '/race/race-0003', 'race-full', 1600, { full: true });
  await shoot(view, opts, '/mask/nova', 'mask-full', 1600, { full: true });
  // The quiet «i»: the money's trail on chain, one tap away.
  await shoot(view, opts, '/', 'home-info', 2400, {
    act: async (page) => {
      await page.getByRole('button', { name: 'Where the money came from' }).click();
      await wait(400);
    },
  });
}

for (const [view, opts] of REDUCED) {
  for (const [path, name] of PAGES) await shoot(view, opts, path, name, 900);
}

for (const [view, opts] of VIEWS.slice(0, 2)) {
  {
    const { ctx, page, logs } = await open(opts, '/no-such-page');
    await wait(800);
    await page.screenshot({ path: join(SHOTS, `404-${view}.jpg`), type: 'jpeg', quality: 86 });
    report.shots.push({ file: `404-${view}.jpg`, ...(await measure(page, `404-${view}`, logs.filter((l) => !/404/.test(l)))) });
    await ctx.close();
  }
  await shoot(view, opts, '/break', 'break', 900);
  await shoot(view, opts, '/break', 'break-filled', 700, { act: fillBreak });
  // An empty submit marks the field and sends nothing.
  await shoot(view, opts, '/break', 'break-empty', 600, {
    act: async (page) => {
      await page.getByRole('button', { name: /next/i }).click();
      await wait(300);
    },
  });
}

await browser.close();
if (server) {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}
writeFileSync(join(SHOTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.shots.length} shots in ${SHOTS}`);
if (report.problems.length) {
  console.log(report.problems.join('\n'));
  process.exitCode = 1;
} else console.log('no problems');
