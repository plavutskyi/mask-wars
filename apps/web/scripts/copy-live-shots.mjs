// Confidential copying through real eyes, on testnet: the demo stack of docs/spec/copy.md, every number read from the
// chain. ANN's LYRA is open to copies at 20%; BOB's ECHO copies it, raced a sealed round and won; BOB shares ECHO's
// history with himself and CAT; EVE holds a view key but no view.
//
// What it walks, on desk 1440×900, phone 375×812 and phone 360×780:
// - LYRA's page as a stranger: the Copy panel (you keep, the author takes, copies, "Copy · 1 NEAR"), its «i»;
// - ECHO's page: the line naming its author, the private history;
// - ECHO's history as CAT: the wallet signs the view message, the page makes CAT's view key and opens the races sealed
//   for it, here in the browser; a race's «i»;
// - ECHO's history as EVE: refused, nothing opened;
// - ECHO's "Who reads it" as BOB;
// - `/forge?copy=lyra`: forging a copy, the share on top.
// It checks the console, horizontal scroll, text that spills out of its box and finger-sized targets.
//
// Usage: node apps/web/scripts/copy-live-shots.mjs <base> <demo.json>
//   <demo.json>: { "people": { "bob": { "id", "key" }, "cat": {…}, "eve": {…} }, "authorName", "copyName" }, the keys
//   of the demo's own testnet accounts (never committed). The site runs with MASKWARS_NETWORK=testnet,
//   NEXT_PUBLIC_FORGE_TEST=1, NEXT_PUBLIC_FORGE_FACTORY=<the demo factory>.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NearKey } from '../../../packages/race/src/near-tx.ts';
import { VIEW_MESSAGE, VIEW_RECIPIENT, viewMessageBytes } from '../../../packages/forge/src/history.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'shots', 'copy-live');
const [BASE, DEMO] = process.argv.slice(2);
if (!BASE || !DEMO) throw new Error('usage: copy-live-shots.mjs <base> <demo.json>');
const demo = JSON.parse(readFileSync(DEMO, 'utf8'));
const AUTHOR = demo.authorName;
const COPY = demo.copyName;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, at: new Date().toISOString(), shots: [], problems: [] };
const problem = (where, what) => report.problems.push(`${where}: ${what}`);

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['phone360', { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];

async function look(page, where) {
  const issues = await page.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`horizontal scroll ${document.documentElement.scrollWidth}`);
    for (const el of document.querySelectorAll('main button, main a, main summary, main label, main input')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.height < 44 || r.width < 44) out.push(`small target ${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    for (const el of document.querySelectorAll('main h1, main h2, main button, main p, main a, main span, main dd, main dt, main li, main label')) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push(`text spills out of ${el.tagName} "${el.textContent.trim().slice(0, 24)}"`);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) out.push(`off screen ${el.tagName} "${el.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  for (const i of issues) problem(where, i);
}

async function shot(page, name, view, full = false) {
  await page.waitForTimeout(600);
  const file = `${name}-${view}.jpg`;
  await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 84, fullPage: full });
  await look(page, file);
  report.shots.push(file);
}

/** A browser context whose wallet is `who`'s: it signs the view message as a NEAR wallet does (NEP-413, ed25519 over
 * the payload's sha256) and refuses to send any transaction: this walk reads, it changes nothing on chain. */
async function as(browser, opts, who) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  const errors = [];
  if (who) {
    const person = demo.people[who];
    const key = new NearKey(person.key);
    await ctx.exposeFunction('__liveSignMessage', (message, recipient) => {
      if (message !== VIEW_MESSAGE || recipient !== VIEW_RECIPIENT) throw new Error('only the view message');
      return Array.from(key.sign(createHash('sha256').update(viewMessageBytes()).digest()));
    });
    await ctx.addInitScript((a) => {
      window.__forgeSigner = {
        accountId: a,
        call: async () => {
          throw new Error('this walk sends nothing');
        },
        signMessage: async (m, r, n) => Uint8Array.from(await window.__liveSignMessage(m, r, Array.from(n))),
      };
    }, person.id);
  }
  ctx.on('page', (p) => p.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200))));
  return { ctx, errors };
}

async function open(ctx, path) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.waitForTimeout(500);
  return page;
}

const browser = await chromium.launch();
for (const [view, opts] of VIEWS) {
  // LYRA's page as a stranger.
  {
    const { ctx, errors } = await as(browser, opts, null);
    const page = await open(ctx, `/mask/${AUTHOR}`);
    const panel = page.locator('section[aria-labelledby="copy"]');
    if (!(await panel.isVisible())) problem(`author-${view}`, 'no Copy panel');
    const btn = panel.getByRole('link', { name: /Copy .* for/ });
    if (!(await btn.isVisible())) problem(`author-${view}`, 'no Copy button');
    await panel.scrollIntoViewIfNeeded();
    await shot(page, '1-author-copy', view);
    await panel.getByRole('button', { name: 'Copying, on chain' }).click();
    await shot(page, '2-author-info', view);
    await page.keyboard.press('Escape');
    await shot(page, '3-author-full', view, true);
    for (const e of errors) problem(`author-${view}`, `console: ${e}`);
    await ctx.close();
  }
  // ECHO's page: its author, its private history.
  {
    const { ctx, errors } = await as(browser, opts, null);
    const page = await open(ctx, `/mask/${COPY}`);
    await shot(page, '4-copy-full', view, true);
    for (const e of errors) problem(`copy-${view}`, `console: ${e}`);
    await ctx.close();
  }
  // CAT opens ECHO's history; EVE is refused; BOB sees who reads it.
  for (const who of ['cat', 'eve', 'bob']) {
    const { ctx, errors } = await as(browser, opts, who);
    const page = await open(ctx, `/mask/${COPY}`);
    const hist = page.locator('section', { has: page.getByText('Race history', { exact: true }) });
    await hist.scrollIntoViewIfNeeded();
    if (who === 'bob') {
      await hist.getByRole('button', { name: 'Who reads it' }).click();
      await shot(page, '7-history-owner', view);
    } else {
      await hist.getByRole('button', { name: 'Open history' }).click();
      if (who === 'cat') {
        await hist.locator('ol li').first().waitFor({ timeout: 30_000 }).catch(() => problem(`history-cat-${view}`, 'no race opened'));
        await shot(page, '5-history-reader', view);
        const info = hist.locator('ol li').first().getByRole('button');
        if (await info.count()) {
          await info.first().click();
          await shot(page, '5-history-race-info', view);
          await page.keyboard.press('Escape');
        }
      } else {
        await hist.getByText('Only the accounts', { exact: false }).waitFor({ timeout: 20_000 }).catch(() => problem(`history-eve-${view}`, 'not refused'));
        if (await hist.locator('ol li').count()) problem(`history-eve-${view}`, 'a stranger opened a race');
        await shot(page, '6-history-stranger', view);
      }
    }
    for (const e of errors) problem(`history-${who}-${view}`, `console: ${e}`);
    await ctx.close();
  }
  // Forging a copy.
  {
    const { ctx, errors } = await as(browser, opts, null);
    const page = await open(ctx, `/forge?copy=${AUTHOR}`);
    await page.waitForTimeout(1500);
    await shot(page, '8-forge-copy', view);
    for (const e of errors) problem(`forge-${view}`, `console: ${e}`);
    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`${report.shots.length} shots, ${report.problems.length} problems`);
for (const p of report.problems) console.log(`  ${p}`);
