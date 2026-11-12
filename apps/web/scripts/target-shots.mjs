// The safe's line through real eyes: «Arena target. MASK WARS funds it, the masks break it.» and its «i», closed and
// open, on the home page between rounds (the house's vault and its next round), the race page of race-0002 and the
// vault's own page, on desk 1440×900, phone 375×812 and a small phone 360×740. Checks the console, horizontal scroll,
// finger-sized targets, the line and its sheet inside the screen, and the line clear of the vault under it.
//
// Without a base it starts `next start` on NEAR mainnet as it answered on 11.11.2026
// (packages/dossier/test/fixtures/mainnet.json): every account, sum and transaction on the shots is a real one, read with
// no network. The browser's clock stands at 12 Nov 09:12:40 UTC, between rounds, when the stage is the next round's vault.
//
// Usage: MASKWARS_NETWORK=mainnet pnpm --filter @maskwars/web build && node apps/web/scripts/target-shots.mjs [base]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const SHOTS = join(app, 'shots');
mkdirSync(SHOTS, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
let BASE = process.argv[2];
if (!BASE) {
  const port = 3127;
  BASE = `http://localhost:${port}`;
  server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
    cwd: app,
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      MASKWARS_NETWORK: 'mainnet',
      ARENA_FIXTURE: '../../packages/dossier/test/fixtures/mainnet.json',
      DOSSIER_WRITTEN: '../../packages/dossier/test/fixtures/written',
      NEARAI_CLOUD_API_KEY: '',
      NEAR_AI_API_KEY: '',
    },
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/league`)).status < 500) break;
    } catch {
      /* not yet */
    }
    await wait(500);
  }
}

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['360', { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];
/** Path and shot name: the home page keeps the plain name, as the brief asked for it. */
const PAGES = [
  ['/', 'arena-target'],
  ['/race/race-0002', 'arena-target-race'],
  ['/contract/vault.house.maskwars.near', 'arena-target-contract'],
];
/** 12 Nov 2026, 09:12:40 UTC: the last round is long over, the next one opens at 18:00. */
const CLOCK = Date.UTC(2026, 10, 12, 9, 12, 40);
const LABEL = 'The arena target';

const report = { base: BASE, shots: [], problems: [] };
const problem = (where, what) => report.problems.push(`${where}: ${what}`);
const browser = await chromium.launch();

async function shoot(view, opts, path, name, open) {
  const where = `${name}${open ? '-info' : ''}-${view}`;
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await ctx.addInitScript(`(() => { const real = Date.now.bind(Date); const off = ${CLOCK} - real(); Date.now = () => real() + off; })();`);
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  await wait(2400);
  const button = page.getByRole('button', { name: LABEL });
  if ((await button.count()) !== 1) problem(where, `${await button.count()} «i» of the line`);
  if (open) {
    await button.click();
    await wait(500);
  }
  // The name keeps the brief's order: arena-target-info-desk, arena-target-race-info-phone.
  const file = `${name}${open ? '-info' : ''}-${view}.jpg`;
  await page.screenshot({ path: join(SHOTS, file), type: 'jpeg', quality: 86 });
  const m = await page.evaluate((label) => {
    const i = document.querySelector(`button[aria-label="${label}"]`);
    const line = i?.closest('p');
    const r = line?.getBoundingClientRect();
    const sheet = document.querySelector(`[role="dialog"][aria-label="${label}"]`)?.getBoundingClientRect();
    // On the home page the line stands in the top the arena composes under: the vault's ring starts below it.
    const top = document.querySelector('[data-top]')?.getBoundingClientRect();
    const door = document.querySelector('section[aria-label*="vault" i], section[aria-label*="next round" i]')?.firstElementChild?.getBoundingClientRect();
    const small = [...document.querySelectorAll('button, a')]
      .filter((el) => !el.closest('[inert]') && el.getClientRects().length)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el, r }) => (r.width < 44 || r.height < 44) && el.closest('p') === line)
      .map(({ el, r }) => `${el.textContent?.trim() || el.getAttribute('aria-label')} ${Math.round(r.width)}×${Math.round(r.height)}`);
    const out = (b) => b && (b.left < 0 || b.right > innerWidth + 0.5 || b.top < 0 || b.bottom > innerHeight + 0.5);
    return {
      hscroll: document.documentElement.scrollWidth > innerWidth,
      line: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) } : null,
      lineOut: out(r),
      sheetOut: out(sheet),
      vaultUnder: top && door ? Math.round(door.top - top.bottom) : null,
      small,
    };
  }, LABEL);
  if (m.hscroll) problem(where, 'horizontal scroll');
  if (!m.line) problem(where, 'no line');
  if (m.lineOut) problem(where, 'the line leaves the screen');
  if (m.sheetOut) problem(where, 'the sheet leaves the screen');
  if (open && m.sheetOut === undefined) problem(where, 'the sheet did not open');
  if (m.vaultUnder !== null && m.vaultUnder < 0) problem(where, `the vault runs ${-m.vaultUnder} px over the line`);
  for (const s of m.small) problem(where, `target under 44 px: ${s}`);
  for (const l of logs) problem(where, l);
  report.shots.push({ file, ...m });
  await ctx.close();
}

try {
  for (const [path, name] of PAGES) {
    for (const [view, opts] of VIEWS) {
      await shoot(view, opts, path, name, false);
      await shoot(view, opts, path, name, true);
    }
  }
} finally {
  await browser.close();
  if (server) process.kill(-server.pid);
}

console.log(JSON.stringify(report, null, 2));
if (report.problems.length) process.exitCode = 1;
