// Your vault through real eyes, end to end: a passkey made in a virtual authenticator (Chrome's own WebAuthn, the
// same ceremony a phone runs), a top-up from Solana up to its deposit address and through to the money landing, a
// cash-out to Base signed by that passkey (half, then all of it), and every way a cash-out or a top-up can end when it
// does not simply go through. Desk 1440×900 and phone 375×812. Checks the console, horizontal scroll and finger-sized
// targets on every shot.
//
// 1Click and NEAR Intents are simulated in memory (PAY_FIXTURE=1, packages/pay/src/fake.ts) from recorded answers:
// no money moves, and the passkey's signature is verified exactly as NEAR Intents verifies it.
// Usage: node apps/web/scripts/wallet-shots.mjs [base]   (without a base it starts `next dev` on port 3211)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const SHOTS = join(app, 'shots', 'wallet');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
let BASE = process.argv[2];
if (!BASE) {
  const port = 3211;
  BASE = `http://localhost:${port}`;
  server = spawn('pnpm', ['exec', 'next', 'dev', '-p', String(port)], {
    cwd: app,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PAY_FIXTURE: '1', PAY_FIXTURE_STEP_MS: '2500', PASSKEY_RP_ID: 'localhost' },
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/wallet`)).ok) break;
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
];
const BASE_ADDRESS = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';

const problems = [];
const browser = await chromium.launch();

/** A request the test stands in the middle of, sent on as the page's own: Playwright drops the Sec-Fetch-* headers. */
const forward = (route) => route.fetch({ headers: { ...route.request().headers(), 'sec-fetch-site': 'same-origin' } });

/** A browser profile with its own passkey authenticator: one that syncs (BE), unless `synced` is false. */
async function device(opts, view, { synced = true, credentials = [] } = {}) {
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && !/status of 503|status of 429/.test(m.text()) && problems.push(`${view}: console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${view}: page error: ${e.message}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      defaultBackupEligibility: synced,
      defaultBackupState: synced,
    },
  });
  for (const c of credentials) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: c });
  return { context, page, cdp, authenticatorId };
}

for (const [view, opts] of VIEWS) {
  let n = 0;
  const shotOf = (page) => async (name, settle = 500) => {
    await wait(settle);
    n += 1;
    const file = `${String(n).padStart(2, '0')}-${name}-${view}.jpg`;
    await page.screenshot({ path: join(SHOTS, file), type: 'jpeg', quality: 82 });
    const audit = await page.evaluate(() => {
      const out = [];
      if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`horizontal scroll ${document.documentElement.scrollWidth}px`);
      for (const el of document.querySelectorAll('button, a, input')) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
        if (r.height < 44 || r.width < 44) out.push(`small target ${Math.round(r.width)}×${Math.round(r.height)}: ${(el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30)}`);
        if (r.right > window.innerWidth + 1 || r.left < -1) out.push(`off screen: ${(el.textContent || el.tagName).trim().slice(0, 30)}`);
      }
      for (const el of document.querySelectorAll('p, span, b, button, a')) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow === 'hidden') out.push(`text cut: ${(el.textContent || '').trim().slice(0, 30)}`);
      }
      return out;
    });
    for (const a of audit) problems.push(`${view} ${file}: ${a}`);
  };

  const a = await device(opts, view);
  const page = a.page;
  const shot = shotOf(page);
  const click = async (name) => page.getByRole('button', { name, exact: true }).first().click();
  const tap = async (name) => page.getByRole('button', { name, exact: true }).last().click();

  // Signed out. «Continue» looks for a passkey first: there is none yet, so the page offers a new vault.
  await page.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  await shot('signin', 1200);
  await click('Details');
  await shot('signin-details');
  await click('Details');
  await page.getByPlaceholder('you@mail.com').fill('kira@mail.com');
  await click('Continue');
  await page.getByText(/No vault opened/).waitFor();
  await shot('signin-new');
  await tap('New vault');
  await page.getByRole('button', { name: 'Add money', exact: true }).waitFor();
  await shot('vault-empty', 900);

  // Top up from Solana: network, coin, amount, deposit address, the transfer landing.
  const topUp = async (shots) => {
    await click('Add money');
    if (shots) await shot('add-from');
    await click('Next');
    if (shots) await shot('add-coin');
    await click('Next');
    await page.getByText(/NEAR lands in your vault/).waitFor();
    if (shots) {
      await shot('add-amount');
      await page.getByRole('radio', { name: '$100', exact: true }).click();
      await page.getByText(/NEAR lands in your vault/).waitFor();
      await page.getByRole('radio', { name: '$25', exact: true }).click();
      await page.getByText(/NEAR lands in your vault/).waitFor();
    }
    await click('Get address');
    await page.getByText(/Waiting for it/).waitFor();
    if (shots) {
      await shot('add-send', 700);
      await click('Details');
      await shot('add-send-details');
      await click('Details');
      await page.getByText(/Swapping it to NEAR/).waitFor({ timeout: 20000 });
      await shot('add-swapping', 300);
    }
    await page.getByText(/Added .* NEAR to your vault/).waitFor({ timeout: 20000 });
    if (shots) await shot('add-done', 1300);
    await click('Done');
  };
  await topUp(true);
  await shot('vault-full', 900);

  // Cash out to Base, signed by the passkey: half, then all of what is left.
  const toBase = async (shots) => {
    await click('Cash out');
    if (shots) await shot('out-to');
    await page.getByRole('radio', { name: 'Base', exact: true }).click();
    await click('Next');
    if (shots) await shot('out-coin');
    await click('Next');
    await page.getByRole('textbox').fill(BASE_ADDRESS);
    if (shots) await shot('out-address');
    await click('Next');
  };
  await toBase(true);
  await page.getByRole('radio', { name: '50%', exact: true }).click();
  await page.getByText(/arrives at/).waitFor();
  await shot('out-amount');
  await tap('Cash out');
  await page.getByText(/On its way to Base/).waitFor({ timeout: 20000 });
  await shot('out-going', 200);
  await page.getByText(/^Sent /).waitFor({ timeout: 20000 });
  await shot('out-done', 900);
  await click('Done');
  await shot('vault-after', 900);

  await toBase(false);
  await page.getByRole('radio', { name: 'All', exact: true, checked: true }).waitFor();
  await page.getByText(/arrives at/).waitFor();
  await shot('out-all');
  await tap('Cash out');
  await page.getByText(/^Sent /).waitFor({ timeout: 20000 });
  await shot('out-all-done', 900);
  await click('Done');
  await page.getByText(/^\$0$/).waitFor({ timeout: 10000 });
  await shot('vault-emptied', 900);

  // A top-up that does not go through: 1Click refunds it to the vault.
  await page.route('**/api/pay/status**', async (route) => {
    const res = await forward(route);
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, stage: 'refunded', status: 'REFUNDED', refunded: '25000000', refundReason: 'QUOTE_EXPIRED' } });
  });
  await click('Add money');
  await click('Next');
  await click('Next');
  await page.getByText(/NEAR lands in your vault/).waitFor();
  await click('Get address');
  await page.getByText(/back in your vault/).waitFor({ timeout: 20000 });
  await shot('add-refunded', 400);
  await click('Back to vault');
  await page.unroute('**/api/pay/status**');

  // Money again, then a cash-out whose answer is lost on the way while 1Click did take it: the page keeps following it
  // and says «Sent», instead of letting a second one start.
  await topUp(false);
  await page.route('**/api/pay/quote', async (route) => {
    const dry = JSON.parse(route.request().postData() || '{}').dry;
    if (dry) return route.fulfill({ status: 429, json: { error: 'busy' } });
    return route.fallback();
  });
  await toBase(false);
  await page.getByText(/Prices are busy right now/).waitFor();
  await shot('out-busy');
  await page.unroute('**/api/pay/quote');
  await page.route('**/api/pay/submit', async (route) => {
    await forward(route);
    await route.fulfill({ status: 503, json: { error: 'busy' } });
  });
  await page.getByRole('radio', { name: '50%', exact: true }).click();
  await page.getByText(/arrives at/).waitFor();
  await tap('Cash out');
  await page.getByText(/^Sent /).waitFor({ timeout: 30000 });
  await shot('out-lost-sent', 600);
  await click('Done');
  await page.unroute('**/api/pay/submit');

  // A cash-out whose sending failed and never reached 1Click: «Cash out» brings it back, even after a reload, until its
  // intent runs out; then the page says nothing left the vault.
  await page.route('**/api/pay/submit', (route) => route.fulfill({ status: 503, json: { error: 'busy' } }));
  await toBase(false);
  await page.getByText(/arrives at/).waitFor();
  await tap('Cash out');
  await page.getByText(/Checking it went out/).waitFor({ timeout: 20000 });
  await shot('out-unsure', 600);
  await page.unroute('**/api/pay/submit');
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('maskwars:cashout'));
    localStorage.setItem('maskwars:cashout', JSON.stringify({ ...p, until: Date.now() + 6000 }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText(/Checking it went out/).waitFor();
  await page.getByText(/It did not go out/).waitFor({ timeout: 30000 });
  await shot('out-none', 600);
  await click('Back to vault');

  // Another device: the same passkey opens the same vault from «Continue».
  const { credentials } = await a.cdp.send('WebAuthn.getCredentials', { authenticatorId: a.authenticatorId });
  // Chrome's virtual authenticator answers the email field's passkey autofill by itself, which would sign straight back
  // in: this device forgets the passkey first, so the shot shows what a person sees after «Sign out».
  await a.cdp.send('WebAuthn.clearCredentials', { authenticatorId: a.authenticatorId });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByPlaceholder('you@mail.com').waitFor();
  await shot('signed-out', 600);
  const b = await device(opts, view, { credentials });
  await b.page.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  // Chrome offers the passkey in the email field's autofill and the virtual authenticator picks it at once; where it
  // does not, «Continue» opens the picker.
  const opened = b.page.getByRole('button', { name: 'Add money', exact: true });
  await Promise.race([
    opened.waitFor(),
    (async () => {
      await b.page.getByPlaceholder('you@mail.com').fill('kira@mail.com', { timeout: 3000 });
      await b.page.getByRole('button', { name: 'Continue', exact: true }).click();
    })().catch(() => {}),
  ]);
  await opened.waitFor();
  await shotOf(b.page)('other-device', 900);
  await b.context.close();

  // A passkey that would live on this device only: no vault is made from it.
  const c = await device(opts, view, { synced: false });
  await c.page.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  await c.page.getByPlaceholder('you@mail.com').fill('kira@mail.com');
  await c.page.getByRole('button', { name: 'New vault', exact: true }).click();
  await c.page.getByText(/stays on this device only/).waitFor();
  await shotOf(c.page)('one-device', 600);
  await c.context.close();

  // The coins on offer cannot be loaded: the vault says so and offers a retry, which then works.
  const d = await device(opts, view, { credentials });
  await d.page.route('**/api/pay/catalog', (route) => route.fulfill({ status: 503, json: { error: 'busy' } }));
  await d.page.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  const tryAgain = d.page.getByRole('button', { name: 'Try again', exact: true });
  await Promise.race([
    d.page.getByRole('button', { name: 'Sign out', exact: true }).waitFor(),
    (async () => {
      await d.page.getByPlaceholder('you@mail.com').fill('kira@mail.com', { timeout: 3000 });
      await d.page.getByRole('button', { name: 'Continue', exact: true }).click();
    })().catch(() => {}),
  ]);
  await tryAgain.waitFor({ timeout: 40000 });
  await shotOf(d.page)('coins-down', 300);
  await d.page.unroute('**/api/pay/catalog');
  await tryAgain.click();
  await d.page.getByRole('button', { name: 'Add money', exact: true }).waitFor();
  await d.context.close();

  // Before season 0: prices are live, deposit addresses are not handed out yet.
  const e = await device(opts, view, { credentials });
  await e.page.route('**/api/pay/catalog', async (route) => {
    const res = await forward(route);
    await route.fulfill({ response: res, json: { ...(await res.json()), live: false } });
  });
  await e.page.goto(`${BASE}/wallet`, { waitUntil: 'networkidle' });
  const opened3 = e.page.getByRole('button', { name: 'Add money', exact: true });
  await Promise.race([
    opened3.waitFor(),
    (async () => {
      await e.page.getByPlaceholder('you@mail.com').fill('kira@mail.com', { timeout: 3000 });
      await e.page.getByRole('button', { name: 'Continue', exact: true }).click();
    })().catch(() => {}),
  ]);
  await opened3.click();
  await e.page.getByRole('button', { name: 'Next', exact: true }).click();
  await e.page.getByRole('button', { name: 'Next', exact: true }).click();
  await e.page.getByText(/Deposits open with season 0/).waitFor();
  await shotOf(e.page)('closed', 500);
  await e.context.close();

  // On a domain the passkeys are not bound to (a preview URL): a NEAR wallet is the way in.
  const f = await browser.newContext(opts);
  const page4 = await f.newPage();
  await page4.goto(`${BASE.replace('localhost', '127.0.0.1')}/wallet`, { waitUntil: 'networkidle' });
  await page4.getByText(/Here, sign in with your NEAR wallet/).waitFor();
  await shotOf(page4)('no-passkey', 500);
  await f.close();
  await a.context.close();
}

await browser.close();
if (server) process.kill(-server.pid);
console.log(problems.length ? `PROBLEMS\n${problems.join('\n')}` : 'no problems');
console.log(`shots in ${SHOTS}`);
