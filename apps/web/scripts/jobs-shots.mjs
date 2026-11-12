// The jobs pages through real eyes: the board, a job in each state, the «i» sheet, the "Post a job" sheet, and the
// board with no job (the contract not deployed, and deployed with no job). Every page is checked on desk 1440×900,
// phone 375×812 and small phone 360×640; a picture is kept of the desk and the phone.
// It starts the built site (`pnpm --filter @maskwars/web build` first) with `next start`, once per board:
//
//   sandbox     the recorded answers of the sandbox world (packages/arena/test/fixtures/jobs-sandbox.json): the real
//               jobs and crews contracts in a local NEAR sandbox. Every number on those shots is one that chain answered.
//   undeployed  the network's jobs account does not exist yet: /jobs and every job page are not found, and the
//               menu shows no Jobs. Checked by status, with no picture.
//   deployed    the contract is on chain with no job: what the site shows right after.
//   live        with --live <rpc> <indexer>: a sandbox world that is running now (packages/arena/jobs-world).
//
// Each shot's name says which. Checks the console, anything wider than the screen, text cut with an ellipsis and
// finger-sized targets; writes apps/web/shots/jobs/report.json and fails on any of them.
//
//   node apps/web/scripts/jobs-shots.mjs [--live <rpc> <indexer> <job id>…]
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const require = createRequire(join(web, 'package.json'));
// Playwright is a dependency of packages/media, where the site's other pictures are taken.
const { chromium } = createRequire(join(web, '..', '..', 'packages', 'media', 'package.json'))('playwright');
const NEXT = require.resolve('next/dist/bin/next');
const OUT = join(web, 'shots', 'jobs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const liveAt = argv.indexOf('--live');
const live = liveAt >= 0 ? { rpc: argv[liveAt + 1], indexer: argv[liveAt + 2], jobs: argv.slice(liveAt + 3) } : null;

const servers = [];
/** Stops every server this script started, with whatever they started in turn. */
function stop() {
  for (const s of servers.splice(0)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(s.pid), '/T', '/F'], { stdio: 'ignore' });
    else s.kill();
  }
}
process.on('exit', stop);

async function start(port, env) {
  const server = spawn(process.execPath, [NEXT, 'start', '-p', String(port)], { cwd: web, stdio: 'ignore', env: { ...process.env, ...env } });
  servers.push(server);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/jobs`)).ok) return base;
    } catch {
      /* not yet */
    }
    await wait(500);
  }
  throw new Error(`next start on ${port} did not come up`);
}

const ARENA = { ARENA_FIXTURE: '../../packages/arena/test/fixtures/testnet.json' };
const SANDBOX = await start(3123, { ...ARENA, JOBS_FIXTURE: '../../packages/arena/test/fixtures/jobs-sandbox.json' });
const UNDEPLOYED = await start(3124, { ...ARENA, JOBS_FIXTURE: 'undeployed' });
const DEPLOYED = await start(3125, { ...ARENA, JOBS_FIXTURE: 'deployed' });
const LIVE = live
  ? await start(3126, { ...ARENA, JOBS_FIXTURE: '', MASKWARS_JOBS_CONTRACT: 'jobs.test.near', MASKWARS_CREWS_CONTRACT: 'crews.test.near', MASKWARS_RPC: live.rpc, MASKWARS_INDEXER: live.indexer })
  : null;

// Only this script's own shots are replaced: the folder's README stays, and the live shots unless a live world is given.
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) {
  if (!/\.(jpg|json)$/.test(f)) continue;
  if (f.includes('-live-') && !live) continue;
  rmSync(join(OUT, f));
}

/** `keep`: a picture of this screen is kept. The small phone is checked like the others, with no picture. */
const VIEWS = {
  desk: { keep: true, context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
  phone: { keep: true, context: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  small: { keep: false, context: { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
};

/**
 * [base, path, name, what to shoot]. The whole page is always kept. `open`: also the screen with a sheet open, by the
 * label of the button that opens it and the suffix of the picture.
 */
const SHOTS = [
  [SANDBOX, '/jobs', 'board-sandbox', { open: [['Post a job', '-post']] }],
  [SANDBOX, '/jobs/audit-0006', 'job-open-audit-0006-sandbox', { open: [['The job on chain', '-info']] }],
  [SANDBOX, '/jobs/tests-0005', 'job-revealing-tests-0005-sandbox', {}],
  [SANDBOX, '/jobs/review-0004', 'job-decided-review-0004-sandbox', {}],
  [SANDBOX, '/jobs/review-0001', 'job-paid-review-0001-sandbox', {}],
  [SANDBOX, '/jobs/review-0003', 'job-closed-review-0003-sandbox', {}],
  [DEPLOYED, '/jobs', 'board-empty-deployed', { open: [['Post a job', '-post']] }],
  // Checked on every screen, with no picture kept: the rest of the sandbox world's jobs.
  [SANDBOX, '/jobs/drain-0007', 'job-open-drain-0007-sandbox', { check: true }],
  [SANDBOX, '/jobs/review-0009', 'job-checking-review-0009-sandbox', { check: true }],
  [SANDBOX, '/jobs/review-0010', 'job-judge-retries-review-0010-sandbox', { check: true }],
  [SANDBOX, '/jobs/drain-0001', 'job-paid-drain-0001-sandbox', { check: true }],
  [SANDBOX, '/jobs/bench-0002', 'job-refused-bench-0002-sandbox', { check: true }],
  ...(LIVE ? [[LIVE, '/jobs', 'board-sandbox-live', {}], ...live.jobs.map((id) => [LIVE, `/jobs/${id}`, `job-${id}-sandbox-live`, {}])] : []),
];

const report = [];
// Where the jobs contract is not on chain there is no jobs section: its pages are not found, /api/jobs-open says so.
for (const path of ['/jobs', '/jobs/break-safe-0004']) {
  const status = (await fetch(UNDEPLOYED + path)).status;
  report.push({ view: 'http', path, name: 'undeployed', scroll: 0, wide: [], small: [], cut: [], action: null, problems: status === 404 ? [] : [`${path} answered ${status}, not 404`] });
}
const gate = await (await fetch(`${UNDEPLOYED}/api/jobs-open`)).json();
if (gate.open !== false) report.push({ view: 'http', path: '/api/jobs-open', name: 'undeployed', scroll: 0, wide: [], small: [], cut: [], action: null, problems: [`/api/jobs-open answered ${JSON.stringify(gate)}`] });
const browser = await chromium.launch();
for (const [view, { keep, context }] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext(context);
  for (const [base, path, name, what] of SHOTS) {
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => problems.push(String(e).slice(0, 200)));
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
    });
    await page.goto(base + path, { waitUntil: 'load' });
    await wait(2200);
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('main *')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          if (r.width === 0) return false;
          for (let p = e.parentElement; p && p.tagName !== 'MAIN'; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if ((o === 'hidden' || o === 'clip') && p.getBoundingClientRect().right <= innerWidth + 1) return false;
          }
          return r.right > innerWidth + 1 || r.left < -1;
        })
        .map((e) => String(e.className || e.tagName).slice(0, 40)),
    );
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('main a, main button, header a, header button')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && (r.height < 40 || r.width < 40);
        })
        .map((e) => `${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24)} ${Math.round(e.getBoundingClientRect().width)}×${Math.round(e.getBoundingClientRect().height)}`),
    );
    // Text the page cut: with an ellipsis on one line, or by a clamp of its lines.
    const cut = await page.evaluate(() =>
      [...document.querySelectorAll('main *')]
        .filter((e) => {
          if (e.children.length !== 0 || !(e.textContent || '').trim()) return false;
          const st = getComputedStyle(e);
          const line = e.scrollWidth > e.clientWidth + 1 && st.textOverflow === 'ellipsis';
          const lines = st.webkitLineClamp !== 'none' && e.scrollHeight > e.clientHeight + 1;
          return line || lines;
        })
        .map((e) => (e.textContent || '').trim().slice(0, 40)),
    );
    // The first screen holds the page's one action: the solid button is on it, whole.
    const action = await page.evaluate(() => {
      const b = [...document.querySelectorAll('main a, main button')].find((e) => /btn/.test(String(e.className)) && e.getBoundingClientRect().width > 0);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim(), onFirstScreen: r.top >= 0 && r.bottom <= innerHeight };
    });
    const shot = (suffix, full) => page.screenshot({ path: join(OUT, `${name}-${view}${suffix}.jpg`), type: 'jpeg', quality: 76, fullPage: full });
    if (keep && !what.check) await shot('', true);
    for (const [label, suffix] of what.open ?? []) {
      // The first control with this name: a button's own label, or its words.
      const button = page.locator(`button[aria-label="${label}"], main button:text-is("${label}")`).first();
      await button.click();
      await wait(450);
      // A sheet fixed to the screen stays inside it: nothing of it is off the edge. (On a desk an «i» opens beside
      // its mark and scrolls with the page.)
      const off = await page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"]')]
          .filter((e) => {
            let fixed = false;
            for (let p = e; p && p !== document.body && !fixed; p = p.parentElement) fixed = getComputedStyle(p).position === 'fixed';
            const r = e.getBoundingClientRect();
            return fixed && r.width > 0 && (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1);
          })
          .map((e) => `${e.getAttribute('aria-label') || 'a sheet'} is off the screen`),
      );
      problems.push(...off);
      if (keep) await shot(suffix, false);
      await page.keyboard.press('Escape');
      await wait(150);
    }
    report.push({ view, path, name, scroll, wide, small, cut, action, problems });
    console.log(`${view.padEnd(6)} ${name.padEnd(40)} wide ${wide.length + (scroll > 0 ? 1 : 0)} small ${small.length} cut ${cut.length} problems ${problems.length}${action ? ` · ${action.text}${action.onFirstScreen ? '' : ' (below the first screen)'}` : ''}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
stop();
// A page whose first screen must carry its action: the board, full or empty, and a job masks can take.
const mustAct = (r) => /^board-|^job-open-/.test(r.name) && r.action && !r.action.onFirstScreen;
const bad = report.filter((r) => r.scroll > 0 || r.wide.length || r.small.length || r.cut.length || r.problems.length || mustAct(r));
if (bad.length) {
  console.error(JSON.stringify(bad, null, 2));
  process.exit(1);
}
console.log(`${report.length} pages checked on ${Object.keys(VIEWS).length} screens: nothing wider than the screen, no cut text, every target 40 px or more, a clean console.`);
