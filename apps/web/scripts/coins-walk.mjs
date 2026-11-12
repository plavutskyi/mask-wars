// The coin lists of /swap and /near through real eyes, against the live 1Click list (mainnet, previews only: no deposit
// address, no money). On desk 1440×900 and phones 375×812 and 360×740: the closed form, the picker on Popular, every
// network in the rail, searches for usdt, usdt0, usdc, btc and eth, a coin's contract and explorer link, a coin switch,
// the turn-around button, and a price for four pairs. Each step checks that every logo loaded, nothing scrolls sideways,
// no coin name or network is cut, every target is finger-sized, and the console stays clean. Shots go to
// apps/web/shots/swap-logos (key steps) and, with a second argument, every step to that folder.
// Usage: node apps/web/scripts/coins-walk.mjs [base] [all-shots-dir]   (a server at base, default http://localhost:3107)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  ({ chromium } = createRequire(join(here, '..', '..', '..', 'packages', 'media', 'package.json'))('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}
const KEY = join(here, '..', 'shots', 'swap-logos');
const BASE = process.argv[2] ?? 'http://localhost:3107';
const ALL = process.argv[3] ?? null;
mkdirSync(KEY, { recursive: true });
if (ALL) mkdirSync(ALL, { recursive: true });

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['small', { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];
/** Steps whose shots go into the pull request's folder; the rest only to ALL. */
const KEEP = new Set(['swap', 'swap-popular', 'swap-net-arb', 'swap-net-eth', 'swap-net-near', 'swap-search-usdt0', 'swap-search-btc', 'swap-facts-usdt-arb', 'swap-details', 'swap-quote-arb-usdt-near', 'swap-quote-btc-tron-usdt', 'near', 'near-popular', 'near-facts-gram']);
const faults = [];
const report = [];

const fault = (view, step, what) => {
  faults.push(`${view} ${step}: ${what}`);
  console.log(`  ✗ ${what}`);
};

/** Everything that would look broken: a logo that did not load, a sideways scroll, a cut name, a small target. */
async function check(page, view, step) {
  await page.waitForTimeout(250);
  await page.evaluate(async () => {
    await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => i.addEventListener('load', r, { once: true }) || i.addEventListener('error', r, { once: true }))));
  });
  const r = await page.evaluate(() => {
    const out = { broken: [], cut: [], small: [], wide: document.scrollingElement.scrollWidth > window.innerWidth + 1, logos: 0 };
    for (const img of document.images) {
      if (!img.src.includes('/coins/') && !img.src.includes('/chains/')) continue;
      out.logos++;
      if (!img.complete || img.naturalWidth === 0) out.broken.push(img.src.split('/').slice(-2).join('/'));
    }
    for (const el of document.querySelectorAll('[role="dialog"] b, [role="dialog"] [class*="coinName"] span, [class*="coinBtnText"] b, [class*="coinBtnText"] span, [role="dialog"] nav button')) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.cut.push(el.textContent.trim().slice(0, 40));
    }
    // The card's own words beside a coin button: «You receive», its dollars, and the amount typed.
    for (const el of document.querySelectorAll('[class*="receiveText"], [class*="receiveText"] > span, form input[inputmode="decimal"]')) {
      if (el.scrollWidth > el.clientWidth + 1) out.cut.push(`${el.tagName.toLowerCase()} ${(el.value ?? el.textContent).trim().slice(0, 30)}`);
    }
    const scope = document.querySelector('[role="dialog"]') ?? document;
    for (const el of scope.querySelectorAll('button, a[href], input')) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (b.bottom < 0 || b.top > window.innerHeight) continue;
      // The site's header and the Get NEAR / Swap tabs are not part of the coin lists.
      if (el.closest('header, nav[aria-label="Main"], footer, [class*="tabs"]')) continue;
      if (b.height < 43.5 || b.width < 43.5) out.small.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 30)}" ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    return out;
  });
  if (r.broken.length) fault(view, step, `broken logos: ${r.broken.join(', ')}`);
  if (r.wide) fault(view, step, 'scrolls sideways');
  if (r.cut.length) fault(view, step, `cut: ${r.cut.join(' | ')}`);
  if (r.small.length) fault(view, step, `small targets: ${r.small.join(' | ')}`);
  return r;
}

/** Steps shot whole, top to bottom: «i» opens more than a screen on a phone. */
const FULL = new Set(['swap-details']);

async function shot(page, view, step) {
  const name = `${step}-${view}.jpg`;
  const o = { type: 'jpeg', quality: 82, fullPage: FULL.has(step) };
  if (KEEP.has(step)) await page.screenshot({ ...o, path: join(KEY, name) });
  if (ALL) await page.screenshot({ ...o, path: join(ALL, name) });
}

async function step(page, view, name, fn) {
  console.log(`${view} ${name}`);
  if (fn) await fn();
  const r = await check(page, view, name);
  await shot(page, view, name);
  return r;
}

const dialog = (page) => page.locator('[role="dialog"]');

async function openPicker(page, which) {
  await page.locator('button[aria-haspopup="dialog"]').nth(which).click();
  await dialog(page).waitFor();
  await page.waitForTimeout(350);
}

async function search(page, text) {
  const input = dialog(page).locator('input');
  await input.fill(text);
  await page.waitForTimeout(250);
}

/** Picks the row whose symbol and second line match, from whatever the picker shows now. */
async function pickRow(page, symbol, network) {
  const row = dialog(page)
    .locator('li')
    .filter({ has: page.locator('b', { hasText: new RegExp(`^${symbol}$`) }) })
    .filter({ hasText: network })
    .first();
  await row.locator('button').first().click();
  await dialog(page).waitFor({ state: 'detached' });
}

async function choose(page, which, symbol, network) {
  await openPicker(page, which);
  await search(page, symbol);
  await pickRow(page, symbol, network);
}

/** The hero's number once a fresh price is in. */
async function heroQuote(page) {
  await page.waitForFunction(() => /\d/.test(document.querySelector('[class*="bigNum"]')?.textContent ?? '') && !document.querySelector('[class*="result"][data-dim]'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const num = document.querySelector('[class*="bigNum"]')?.textContent?.trim() ?? '';
    const unit = document.querySelector('[class*="bigUnit"]')?.textContent?.trim() ?? '';
    const line = document.querySelector('[class*="heroLine"]')?.textContent?.trim() ?? '';
    const note = [...document.querySelectorAll('form [role="alert"], form [role="status"]')].map((e) => e.textContent.trim()).join(' ');
    return `${num} ${unit} · ${line} · ${note}`;
  });
}

const b = await chromium.launch();
for (const [view, opts] of VIEWS) {
  const ctx = await b.newContext(opts);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      const t = m.text();
      if (/Download the React DevTools|\[HMR\]|\[Fast Refresh\]/.test(t)) return;
      fault(view, 'console', `${m.type()}: ${t.slice(0, 160)}`);
    }
  });
  page.on('pageerror', (e) => fault(view, 'page', e.message.slice(0, 160)));
  page.on('requestfailed', (r) => {
    if (/\/(coins|chains)\//.test(r.url())) fault(view, 'request', `failed ${r.url()}`);
  });

  // ---- Swap ----
  await page.goto(`${BASE}/swap`, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 60000 });
  await step(page, view, 'swap', () => heroQuote(page));
  const lede = await page.locator('h1 + p').textContent();
  report.push(`${view} swap lede: ${lede}`);

  await openPicker(page, 0);
  await step(page, view, 'swap-popular');
  const popular = await dialog(page).locator('li b').allTextContents();
  const popularNets = await dialog(page).locator('li [class*="coinName"] span').allTextContents();
  report.push(`${view} swap popular: ${popular.map((s, i) => `${s}/${popularNets[i]}`).join(', ')}`);

  const nets = await dialog(page).locator('nav button').allTextContents();
  for (let i = 1; i < nets.length; i++) {
    const btn = dialog(page).locator('nav button').nth(i);
    const id = await page.evaluate((el) => el.querySelector('img')?.getAttribute('src')?.split('/').pop()?.replace('.svg', '') ?? '', await btn.elementHandle());
    await btn.scrollIntoViewIfNeeded();
    await step(page, view, `swap-net-${id}`, () => btn.click());
    if (view === 'desk') report.push(`net ${id}: ${(await dialog(page).locator('li b').allTextContents()).join(' ')}`);
  }
  await dialog(page).locator('nav button').first().click();

  for (const q of ['usdt', 'usdt0', 'usdc', 'btc', 'eth']) {
    await step(page, view, `swap-search-${q}`, () => search(page, q));
    const hits = await dialog(page).locator('li').evaluateAll((lis) => lis.map((li) => `${li.querySelector('b')?.textContent}/${li.querySelector('[class*="coinName"] span')?.textContent}`));
    report.push(`${view} search ${q}: ${hits.join(', ')}`);
  }

  // The contract of USDT on Arbitrum, behind its «i».
  await search(page, 'usdt0');
  const arbRow = dialog(page).locator('li').filter({ hasText: 'Arbitrum' }).first();
  await step(page, view, 'swap-facts-usdt-arb', async () => {
    await arbRow.locator('button[aria-expanded]').click();
    await page.waitForTimeout(300);
  });
  const link = arbRow.locator('a');
  report.push(`${view} USDT/Arbitrum facts: ${(await arbRow.locator('[class*="facts"]').first().textContent()).trim()} → ${await link.getAttribute('href')} target=${await link.getAttribute('target')} rel=${await link.getAttribute('rel')}`);
  await search(page, 'eth');
  const ethRow = dialog(page).locator('li').filter({ hasText: 'Ethereum' }).filter({ has: page.locator('b', { hasText: /^ETH$/ }) }).first();
  await step(page, view, 'swap-facts-eth-native', async () => {
    await ethRow.locator('button[aria-expanded]').click();
    await page.waitForTimeout(300);
  });
  report.push(`${view} ETH/Ethereum facts: ${(await ethRow.locator('[class*="facts"]').first().textContent()).trim()}`);
  await page.keyboard.press('Escape');

  // A coin switch, «i» on the form, the turn-around.
  await step(page, view, 'swap-switch', () => choose(page, 0, 'USDC', 'Base'));
  await step(page, view, 'swap-details', async () => {
    await heroQuote(page);
    await page.locator('form button[aria-label="Details"]').click();
    await page.waitForTimeout(300);
  });
  report.push(`${view} details: ${(await page.locator('form dl').textContent()).replace(/\s+/g, ' ').slice(0, 400)}`);
  await page.locator('form button[aria-label="Details"]').click();
  await step(page, view, 'swap-flip', async () => {
    await page.locator('button[aria-label="Turn the swap around"]').click();
    await page.waitForTimeout(400);
  });
  report.push(`${view} after flip: ${(await page.locator('button[aria-haspopup="dialog"]').allTextContents()).join(' → ')}`);

  // The longest network names on the coin buttons.
  await step(page, view, 'swap-long-names', async () => {
    await choose(page, 0, 'BCH', 'Bitcoin Cash');
    await choose(page, 1, 'USDT', 'Optimism');
  });
  await step(page, view, 'swap-long-names-2', () => choose(page, 0, 'XRP', 'XRP Ledger'));

  // Prices for four pairs.
  for (const [from, to, name] of [
    [['USDT', 'Arbitrum'], ['NEAR', 'NEAR'], 'swap-quote-arb-usdt-near'],
    [['USDC', 'Arbitrum'], ['SOL', 'Solana'], 'swap-quote-arb-usdc-sol'],
    [['USDC', 'Base'], ['NEAR', 'NEAR'], 'swap-quote-base-usdc-near'],
    [['BTC', 'Bitcoin'], ['USDT', 'Tron'], 'swap-quote-btc-tron-usdt'],
  ]) {
    await choose(page, 0, ...from);
    await choose(page, 1, ...to);
    if (from[0] === 'BTC') await page.locator('form input').first().fill('0.0005');
    else await page.locator('form input').first().fill('25');
    let q = '';
    await step(page, view, name, async () => {
      q = await heroQuote(page);
    });
    report.push(`${view} ${from.join(' on ')} → ${to.join(' on ')}: ${q}`);
  }

  // ---- Get NEAR ----
  await page.goto(`${BASE}/near`, { waitUntil: 'networkidle' });
  await page.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 60000 });
  await step(page, view, 'near', () => heroQuote(page));
  report.push(`${view} near lede: ${await page.locator('h1 + p').textContent()}`);
  await openPicker(page, 0);
  await step(page, view, 'near-popular');
  await search(page, 'ton');
  const gram = dialog(page).locator('li').filter({ has: page.locator('b', { hasText: /^GRAM$/ }) }).first();
  await step(page, view, 'near-facts-gram', async () => {
    await gram.locator('button[aria-expanded]').click();
    await page.waitForTimeout(300);
  });
  report.push(`${view} search ton: ${(await dialog(page).locator('li b').allTextContents()).join(' ')}; GRAM facts: ${(await gram.locator('[class*="facts"]').first().textContent()).trim()}`);
  await pickRow(page, 'USDT', 'TON');
  await step(page, view, 'near-switch', () => heroQuote(page));
  await ctx.close();
}
await b.close();

writeFileSync(join(ALL ?? KEY, 'coins-walk.txt'), `${report.join('\n')}\n\nFaults (${faults.length}):\n${faults.join('\n')}\n`);
console.log(`\n${report.join('\n')}\n\nFaults: ${faults.length}`);
for (const f of faults) console.log(`  ${f}`);
process.exit(faults.length ? 1 : 0);
