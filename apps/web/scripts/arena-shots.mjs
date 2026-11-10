// The arena engine through real eyes: every state on desk 1440×900 and phone 375×812, at full quality and in
// the simplified scene, plus reduced motion. Each state is reached by switching from the one before it in the
// lab, so the moments (entrance, break, payout, lock) really play, then shot once they settle.
// Checks the console, horizontal scroll and finger-sized targets.
// Usage: node apps/web/scripts/arena-shots.mjs <base> [out dir]; ONLY=live,paid,page shoots a part.
// The lab is off in production builds unless MASKWARS_LAB=1.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] ?? 'http://localhost:3000';
const OUT = process.argv[3] ?? join(here, '..', 'components', 'arena3d', 'shots');
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// No GPU in CI or a cloud box: WebGL runs on SwiftShader. Slow, but the pixels are the same.
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

const VIEWS = {
  desk: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
// Each state and the state the lab switches from, so its moment plays.
const ROUTE = [
  ['idle', null],
  ['live', 'idle'],
  ['breach', 'live'],
  ['paid', 'breach'],
  ['held', 'live'],
];
const SETTLE = { idle: 5000, live: 7000, breach: 6000, paid: 7000, held: 5000 };
const report = { base: BASE, at: new Date().toISOString(), shots: [], problems: [] };

async function shoot(view, state, from, { quality = 'high', reduced = false, insets = false, suffix = '' } = {}) {
  const ctx = await browser.newContext({ ...VIEWS[view], colorScheme: 'dark', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  const start = from ?? state;
  await page.goto(`${BASE}/lab/arena?state=${start}&q=${quality}${insets ? '&insets=1' : ''}`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForSelector('section[aria-label="Arena"][data-ready]', { timeout: 120000 });
  await wait(from ? 3500 : 1500);
  if (from) await page.getByRole('button', { name: state, exact: true }).click();
  // Hide the lab's switch for the picture.
  await page.addStyleTag({ content: 'nav[aria-label="Arena lab"]{display:none!important}' });
  // Software WebGL draws the phone's 2× buffer slowly: give the moments more wall time there.
  await wait(SETTLE[state] * (view === 'phone' ? 2 : 1));
  const name = `${state}-${view}${suffix}`;
  const file = `${name}.jpg`;
  await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 90 });
  const m = await page.evaluate(() => {
    const root = document.querySelector('section[aria-label="Arena"]');
    const small = [...root.querySelectorAll('button, a')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
      .map(({ el, r }) => `${el.getAttribute('aria-label') ?? el.textContent} ${Math.round(r.width)}×${Math.round(r.height)}`);
    return { tier: root.getAttribute('data-tier'), hscroll: document.documentElement.scrollWidth > innerWidth, small };
  });
  if (m.hscroll) report.problems.push(`${name}: horizontal scroll`);
  for (const s of m.small) report.problems.push(`${name}: target under 44 px: ${s}`);
  for (const l of logs) if (!/React DevTools|HMR/.test(l)) report.problems.push(`${name}: ${l}`);
  report.shots.push({ file, tier: m.tier });
  console.log(file, m.tier);
  await ctx.close();
}

const only = process.env.ONLY?.split(',');
for (const view of Object.keys(VIEWS)) {
  for (const [state, from] of ROUTE) {
    if (only && !only.includes(state)) continue;
    await shoot(view, state, from);
  }
}
const extra = (tag) => !only || only.includes(tag);
// The simplified scene on the phone, where it matters, and reduced motion.
if (extra('low')) {
  await shoot('phone', 'live', 'idle', { quality: 'low', suffix: '-low' });
  await shoot('phone', 'paid', 'breach', { quality: 'low', suffix: '-low' });
}
if (extra('reduced')) await shoot('desk', 'breach', 'live', { reduced: true, suffix: '-reduced' });
// With the page's own header and deck over the arena.
if (extra('page')) {
  await shoot('desk', 'live', 'idle', { insets: true, suffix: '-page' });
  await shoot('phone', 'live', 'idle', { insets: true, suffix: '-page' });
}

// A partial run updates its own shots in the report and keeps the rest.
if (only && existsSync(join(OUT, 'report.json'))) {
  const before = JSON.parse(readFileSync(join(OUT, 'report.json'), 'utf8'));
  const mine = new Set(report.shots.map((x) => x.file));
  const stems = [...mine].map((f) => f.replace('.jpg', ''));
  report.shots = [...before.shots.filter((x) => !mine.has(x.file)), ...report.shots];
  report.problems = [...before.problems.filter((p) => !stems.some((s) => p.startsWith(`${s}:`))), ...report.problems];
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(report.problems.length ? report.problems.join('\n') : 'no problems');
await browser.close();
