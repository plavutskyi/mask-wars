// The encyclopedia through real eyes: a contract's page in four states, on desk 1440×900 and phones 375×812 and
// 360×780, the first screen and the whole page, plus the «i» open on a phone. Checks the console, horizontal scroll,
// text under 12 px, finger-sized targets and text that leaves its box, and writes apps/web/shots/contract/report.json.
//
// Without a base it starts `next start` twice on NEAR mainnet as it answered on 11.11.2026
// (packages/dossier/test/fixtures/mainnet.json), so every number on the shots is a real one read with no network, with
// the pages DeepSeek V4.1 Flash wrote in a TEE from exactly those facts (test/fixtures/written); and once on a chain
// that does not answer (test/fixtures/silent.json). With a base (a deploy, or a local server with a NEAR AI key) it
// shoots that instead, and the silent chain is skipped.
//
// Usage: MASKWARS_NETWORK=mainnet pnpm --filter @maskwars/web build && node packages/dossier/scripts/shots.mjs [base]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const app = join(root, 'apps/web');
const SHOTS = join(app, 'shots/contract');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const servers = [];
async function serve(port, fixture) {
  const child = spawn('pnpm', ['exec', 'next', 'start', '-p', String(port)], {
    cwd: app,
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      MASKWARS_NETWORK: 'mainnet',
      ARENA_FIXTURE: fixture,
      DOSSIER_WRITTEN: '../../packages/dossier/test/fixtures/written',
      NEARAI_CLOUD_API_KEY: '',
      NEAR_AI_API_KEY: '',
    },
  });
  servers.push(child);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/league`)).status < 500) return base;
    } catch {
      /* not yet */
    }
    await wait(500);
  }
  throw new Error(`next start on ${port} did not come up`);
}

let BASE = process.argv[2];
let SILENT = null;
if (!BASE) {
  BASE = await serve(3124, '../../packages/dossier/test/fixtures/mainnet.json');
  SILENT = await serve(3125, '../../packages/dossier/test/fixtures/silent.json');
}

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['phone360', { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];

/** The four states: the team's safe ORACLE broke, the house's daily vault, a contract no race targeted, a silent chain. */
const PAGES = [
  ['safe', BASE, '/contract/safe-0001.maskwars.near'],
  ['vault', BASE, '/contract/vault.house.maskwars.near'],
  ['untested', BASE, '/contract/wrap.near'],
  ...(SILENT ? [['silent', SILENT, '/contract/safe-0001.maskwars.near']] : []),
];

const report = [];
const browser = await chromium.launch();
try {
  for (const [view, opts] of VIEWS) {
    for (const [name, base, path] of PAGES) {
      const ctx = await browser.newContext(opts);
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(String(e)));
      const res = await page.goto(base + path, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await wait(1400);
      const file = `${name}-${view}`;
      await page.screenshot({ path: join(SHOTS, `${file}.jpg`), type: 'jpeg', quality: 86 });
      await page.screenshot({ path: join(SHOTS, `${file}-full.jpg`), type: 'jpeg', quality: 82, fullPage: true });
      const checks = await page.evaluate(() => {
        const scroll = document.documentElement.scrollWidth - window.innerWidth;
        const small = [];
        const tiny = [];
        for (const el of document.querySelectorAll('main *')) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (own && size < 12) small.push(`${el.tagName.toLowerCase()} ${size}px "${el.textContent.trim().slice(0, 30)}"`);
          if ((el.tagName === 'A' || el.tagName === 'BUTTON') && (r.height < 20 || r.width < 20)) tiny.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}×${Math.round(r.height)} "${el.textContent.trim().slice(0, 20)}"`);
        }
        const over = [...document.querySelectorAll('main h1, main p, main dd, main dt, main span')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow === 'visible' && el.getBoundingClientRect().right > window.innerWidth)
          .map((el) => el.textContent.trim().slice(0, 30));
        return { scroll, small, tiny, over, title: document.title };
      });
      report.push({ page: name, view, status: res?.status(), ...checks, errors });
      if (view === 'phone' && name === 'safe') {
        await page.locator('main button[aria-label="This contract on chain"]').first().click();
        await wait(500);
        await page.screenshot({ path: join(SHOTS, `${name}-info-${view}.jpg`), type: 'jpeg', quality: 86 });
        await page.keyboard.press('Escape');
        // How the record was written: the model, the TEE's attestation, the signed bytes.
        const record = page.locator('main button[aria-label="How this record was written"]').first();
        if (await record.count()) {
          await record.click();
          await wait(500);
          await page.screenshot({ path: join(SHOTS, `${name}-tee-${view}.jpg`), type: 'jpeg', quality: 86 });
        }
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  for (const s of servers) {
    try {
      process.kill(-s.pid);
    } catch {
      /* gone */
    }
  }
}

writeFileSync(join(SHOTS, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const r of report) {
  const bad = [r.scroll > 0 && `scroll ${r.scroll}px`, r.small.length && `small ${r.small.length}`, r.tiny.length && `tiny ${r.tiny.length}`, r.over.length && `overflow ${r.over.length}`, r.errors.length && `errors ${r.errors.length}`].filter(Boolean);
  console.log(`${r.page.padEnd(9)} ${r.view.padEnd(6)} ${r.status} ${bad.length ? bad.join(', ') : 'clean'}  ${r.title}`);
}
