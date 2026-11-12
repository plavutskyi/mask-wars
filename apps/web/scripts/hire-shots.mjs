// Hire the swarm through real eyes: a third-party page on another origin loads the pinned script (integrity checked by
// the browser) and puts the button on its own design; the button opens the checkout from this site in a frame; the
// payer proves the vault in the MASK WARS window with a passkey (Chrome's own WebAuthn, a virtual authenticator holding
// a key this script made), and the whole job is walked through to the money landing (Solana USDC → NEAR in the vault),
// with the host page logging every hire:* event it hears. Then /hire itself, a page naming a vault the payer does not
// hold, a page that names no job, the checkout before HIRE_LIVE, a reload mid-payment, and a checkout that never loads.
// Desk 1440×900, phone 375×812 and a small phone 360×640; every shot is checked for console errors, horizontal scroll and finger-sized targets,
// page and frame both. Every request the checkout makes is counted: none before the payer touches it, one price per
// coin and amount, never more.
//
// 1Click and NEAR Intents are simulated in memory (PAY_FIXTURE=1): no money moves.
// Usage: node apps/web/scripts/hire-shots.mjs [base]   (without a base it starts `next dev` on port 3211; a base must run
// with PAY_FIXTURE=1 and PASSKEY_RP_ID=localhost)
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const SHOTS = join(app, 'shots', 'hire');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { accountOf } = await import('../../../packages/pay/src/passkey.ts');
const release = JSON.parse(readFileSync(join(app, 'app', 'hire', 'release.json'), 'utf8'));

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
      if ((await fetch(`${BASE}/hire`)).ok) break;
    } catch {
      /* not yet */
    }
    await wait(500);
  }
}

/** A passkey for the payer's vault: a P-256 key made here, and the vault account NEAR Intents derives from it. */
function passkey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    vault: accountOf(new Uint8Array(raw)),
    credential: {
      credentialId: randomBytes(16).toString('base64'),
      isResidentCredential: true,
      rpId: 'localhost',
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      userHandle: randomBytes(16).toString('base64'),
      signCount: 0,
    },
  };
}
const payer = passkey();
const stranger = passkey();

// Another team's app, on another origin (127.0.0.1 is another site than localhost): its own look, our button, and a
// log of what the button tells it. `?bare` names no job; `?other` names a vault the payer does not hold.
const HOST_PORT = 4580;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const button = (q) =>
  q === 'bare'
    ? `<mask-wars-hire usd="60"></mask-wars-hire>`
    : `<mask-wars-hire job="Break our lending vault before mainnet" target="vault.northwind-lend.testnet" team="${q === 'other' ? stranger.vault : payer.vault}" usd="60"></mask-wars-hire>`;
const hostPage = (q) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Northwind Lend · launch checklist</title>
<script src="${BASE}/hire/${release.file}" integrity="${release.integrity}" crossorigin="anonymous" async></script>
<style>
  *{box-sizing:border-box;margin:0}
  body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f4f5f7;color:#16181d}
  header{display:flex;align-items:center;gap:12px;height:64px;padding:0 max(16px,4vw);background:#fff;border-bottom:1px solid #e3e5ea}
  .logo{width:28px;height:28px;border-radius:8px;background:#2f5bea}
  header b{font-size:17px} header span{color:#6b7280;font-size:14px}
  main{max-width:1040px;margin:0 auto;padding:40px max(16px,4vw) 64px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px}
  h1{font-size:30px;line-height:1.2;margin-bottom:6px} .sub{color:#6b7280;margin-bottom:24px}
  ul{list-style:none;padding:0;display:grid;gap:10px;margin-bottom:24px}
  li{display:flex;gap:12px;align-items:center;padding:14px 16px;background:#fff;border:1px solid #e3e5ea;border-radius:10px}
  li i{width:22px;height:22px;border-radius:50%;border:2px solid #c5cad3;flex:none}
  li.done i{background:#22a06b;border-color:#22a06b}
  .card{padding:24px;background:#fff;border:1px solid #e3e5ea;border-radius:12px}
  .card h2{font-size:20px;margin-bottom:6px} .card p{color:#4b5563;margin-bottom:18px}
  aside{padding:20px;background:#fff;border:1px solid #e3e5ea;border-radius:12px;align-self:start}
  aside h3{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin-bottom:10px}
  #log{list-style:none;padding:0;display:grid;gap:6px;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#16181d}
  #log li{padding:8px 10px;border-radius:6px;background:#f4f5f7;border:0;display:block;overflow-wrap:anywhere}
  #log .none{color:#9ca3af;background:none;padding:0}
  @media (max-width:760px){main{grid-template-columns:minmax(0,1fr);padding-top:24px}h1{font-size:24px}}
</style></head>
<body>
<header><div class="logo"></div><b>Northwind Lend</b><span>v2 · testnet</span></header>
<main>
  <section>
    <h1>Launch checklist</h1>
    <p class="sub">Everything between testnet and mainnet.</p>
    <ul>
      <li class="done"><i></i>Contracts frozen</li>
      <li class="done"><i></i>Testnet deploy: vault.northwind-lend.testnet</li>
      <li><i></i>Break it before mainnet</li>
    </ul>
    <div class="card">
      <h2>Before mainnet</h2>
      <p>Put money on our testnet vault and let the masks try to break it.</p>
      ${button(q)}
    </div>
  </section>
  <aside><h3>Events</h3><ul id="log"><li class="none">Nothing yet.</li></ul></aside>
</main>
<script>
  const log = document.getElementById('log');
  for (const t of ['open','deposit','dropped','progress','funded','refunded','failed','close']) {
    document.addEventListener('hire:' + t, (e) => {
      log.querySelector('.none')?.remove();
      const d = e.detail || {};
      const li = document.createElement('li');
      li.textContent = 'hire:' + t + (d.stage ? ' ' + d.stage : '') + (d.near ? ' ' + Number(d.near).toFixed(2) + ' NEAR' : '') + (d.job && d.job.id ? ' ' + d.job.id : '');
      log.append(li);
    });
  }
</script>
</body></html>`;
const host = createServer((req, res) => {
  const q = new URL(req.url, HOST).search.slice(1);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(hostPage(q));
}).listen(HOST_PORT, '127.0.0.1');

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['small', { viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];
const problems = [];
const browser = await chromium.launch();

/**
 * A browser profile; `expected` names console errors a scenario causes on purpose (a frame it blocks). Every page it
 * opens (the vault window too) gets a passkey authenticator holding the payer's key, and every request to the site's
 * API is logged.
 */
async function context(opts, view, expected = null) {
  const ctx = await browser.newContext(opts);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const calls = [];
  const watch = (page) => {
    page.on('console', (m) => m.type() === 'error' && !(expected && expected.test(m.text())) && problems.push(`${view}: console: ${m.text()}`));
    page.on('pageerror', (e) => problems.push(`${view}: page error: ${e.message}`));
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/api/')) calls.push(u.pathname);
    });
  };
  const popups = [];
  ctx.on('page', async (p) => {
    watch(p);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: payer.credential });
    p.__ready = true;
    popups.push(p);
  });
  const page = await ctx.newPage();
  return { ctx, page, calls, popups };
}

/** Horizontal scroll, and targets smaller than a finger, in a page or a frame. */
const LOOK = () => {
  const out = [];
  const w = document.documentElement.clientWidth;
  if (document.scrollingElement.scrollWidth > w + 1) out.push(`scrolls sideways: ${document.scrollingElement.scrollWidth} > ${w}`);
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < w;
  };
  for (const el of document.querySelectorAll('button, a[href], input, textarea, [role=radio], [role=tab]')) {
    if (!seen(el) || el.closest('[aria-hidden=true]')) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5)
      out.push(
        `small target ${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`,
      );
  }
  for (const el of document.querySelectorAll('body *')) {
    // Art that bleeds past the edge on purpose sits in an aria-hidden box the page clips.
    if (!seen(el) || el.children.length || el.closest('[aria-hidden=true]')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > w + 1) out.push(`past the right edge: ${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 30)}"`);
  }
  return out;
};

async function shot(page, name, view, frame = null, settle = 450) {
  await wait(settle);
  for (const p of await page.evaluate(LOOK)) problems.push(`${name}-${view}: page: ${p}`);
  if (frame) for (const p of await frame.evaluate(LOOK)) problems.push(`${name}-${view}: checkout: ${p}`);
  await page.screenshot({ path: join(SHOTS, `${name}-${view}.jpg`), type: 'jpeg', quality: 88 });
}

/** The checkout's frame, once it says it is ready. */
async function checkout(page) {
  await page.waitForSelector('mask-wars-hire-sheet[data-ready]', { state: 'attached', timeout: 30_000 });
  const handle = await page.waitForSelector('mask-wars-hire-sheet iframe');
  const frame = await handle.contentFrame();
  await frame.waitForSelector('main form, main [role=status]');
  await wait(400);
  return frame;
}

const text = (frame, t) => frame.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), t, { timeout: 40_000 });
const count = (calls, path) => calls.filter((c) => c === path).length;

/**
 * Opens the vault window from the checkout and proves the vault with the payer's passkey. A real popup is a small
 * window on a desk and a whole tab on a phone; `shots` names the window's two shots, taken before it closes itself.
 */
async function prove(ctx, popups, frame, view, shots = null, expectProven = true) {
  const before = popups.length;
  await frame.getByRole('button', { name: 'Open your vault', exact: true }).click();
  for (let i = 0; i < 100 && (popups.length === before || !popups.at(-1).__ready); i++) await wait(100);
  const w = popups.at(-1);
  if (!w) throw new Error('no vault window');
  // A popup on a desk is the size the checkout asks for; a phone opens it as a whole tab.
  await w.setViewportSize(view === 'desk' ? { width: 480, height: 760 } : view === 'small' ? { width: 360, height: 640 } : { width: 375, height: 812 });
  await w.waitForSelector('main [role=group]', { timeout: 30_000 });
  await w.waitForFunction(() => document.fonts.status === 'loaded');
  // The window closes itself once it is done: here it only notes that it asked, so its last screen can be seen.
  await w.evaluate(() => {
    window.close = () => {
      window.__closeAsked = true;
    };
  });
  if (shots) await shot(w, shots[0], view, null, 600);
  await w.getByRole('button', { name: 'Passkey', exact: true }).click();
  if (!expectProven) return w;
  await w.waitForSelector('text=Proven', { timeout: 30_000 });
  if (shots) await shot(w, shots[1], view, null, 900);
  if (!(await w.evaluate(() => window.__closeAsked === true || new Promise((r) => setTimeout(() => r(window.__closeAsked === true), 2000))))) {
    problems.push(`${view}: the vault window did not close itself`);
  }
  await w.close();
  return w;
}

for (const [view, opts] of VIEWS) {
  // 1. Another team's app, its button, the vault proved, and the whole job paid.
  {
    const { ctx, page, calls, popups } = await context(opts, view);
    await page.goto(HOST, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => customElements.get('mask-wars-hire') && document.fonts.status === 'loaded');
    await shot(page, '01-host', view);
    await page.locator('mask-wars-hire').locator('button').click();
    let frame = await checkout(page);
    await text(frame, 'Show it is yours.');
    // Opened and left alone, the checkout asks nothing of 1Click or NEAR.
    await wait(2500);
    if (calls.length) problems.push(`${view}: before a touch the checkout called ${calls.join(', ')}`);
    await shot(page, '02-vault', view, frame);
    await prove(ctx, popups, frame, view, ['03-window', '04-proven']);
    await text(frame, 'Where your money is now.');
    await shot(page, '05-from', view, frame);
    if (count(calls, '/api/hire/catalog') !== 1) problems.push(`${view}: the coin list was asked ${count(calls, '/api/hire/catalog')} times`);
    await frame.getByRole('button', { name: 'Next', exact: true }).click();
    await shot(page, '06-coin', view, frame);
    await frame.getByRole('button', { name: 'Next', exact: true }).click();
    await text(frame, 'lands in');
    await shot(page, '07-amount', view, frame);
    // One price for this coin and amount; none more while nothing changes; one more for a new amount.
    await wait(3000);
    if (count(calls, '/api/hire/preview') !== 1) problems.push(`${view}: priced ${count(calls, '/api/hire/preview')} times for one amount`);
    // A new amount is priced once it settles: two quick taps are one price, for the amount they end on. The chips stop at
    // the season's limit for one hire ($250, packages/network/mainnet.json): $60, $120, $240.
    await frame.getByRole('radio', { name: '$120', exact: true }).click();
    await frame.waitForFunction(() => /≈ [\d.,]+ NEAR lands in/.test(document.body.innerText));
    await wait(1200);
    if (count(calls, '/api/hire/preview') !== 2) problems.push(`${view}: priced ${count(calls, '/api/hire/preview')} times for two amounts`);
    await frame.getByRole('radio', { name: '$240', exact: true }).click();
    await frame.getByRole('radio', { name: '$60', exact: true }).click();
    await wait(1500);
    if (count(calls, '/api/hire/preview') !== 3) problems.push(`${view}: priced ${count(calls, '/api/hire/preview')} times, not once for two quick taps`);
    await frame.getByRole('button', { name: 'Get address', exact: true }).click();
    await text(frame, 'Waiting for it');
    await page.waitForFunction(() => document.getElementById('log').innerText.includes('hire:deposit'));
    await shot(page, '08-send', view, frame);
    await frame.getByRole('button', { name: 'Details', exact: true }).click();
    await shot(page, '09-send-details', view, frame);
    await frame.getByRole('button', { name: 'Details', exact: true }).click();
    await text(frame, 'Swapping it to NEAR');
    await shot(page, '10-swapping', view, frame);
    await text(frame, 'Funded');
    await wait(800);
    await shot(page, '11-funded', view, frame);
    await frame.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('mask-wars-hire-sheet')?.hidden === true);
    await page.waitForFunction(() => document.getElementById('log').innerText.includes('hire:close'));
    await shot(page, '12-host-after', view);
    // Closed means gone: nothing of the sheet stays over the host page to catch a click.
    const under = await page.evaluate(() => {
      const r = document.querySelector('mask-wars-hire').getBoundingClientRect();
      const h1 = document.querySelector('h1').getBoundingClientRect();
      return [document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.tagName, document.elementFromPoint(h1.x + 10, h1.y + 10)?.tagName];
    });
    if (under[0] !== 'MASK-WARS-HIRE' || under[1] !== 'H1') problems.push(`${view}: after closing, a click lands on ${under.join(' and ')}`);
    const log = await page.evaluate(() => document.getElementById('log').innerText);
    for (const want of ['hire:open', 'hire:deposit', 'hire:progress waiting', 'hire:funded', 'hire:close']) {
      if (!log.includes(want)) problems.push(`${view}: the host page never heard ${want}`);
    }
    // Opening again starts a fresh checkout: the last job ended, and its vault is proved again.
    await page.locator('mask-wars-hire').locator('button').click();
    frame = await checkout(page);
    await text(frame, 'Show it is yours.');
    await page.keyboard.press('Escape');
    // The checkout opened as a page of its own goes to /hire: a link cannot dress it up as maskwars.xyz asking for money.
    await page.goto(`${BASE}/hire/embed?job=Send+me+money+now&target=vault.near&team=${stranger.vault}&usd=500`, { waitUntil: 'networkidle' });
    if (new URL(page.url()).pathname !== '/hire') problems.push(`${view}: the checkout opened on its own at ${page.url()}`);
    await ctx.close();
  }

  // 2. /hire: the name, the real button, the route, the one line.
  {
    const { ctx, page, popups } = await context(opts, view);
    await page.goto(`${BASE}/hire`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    await shot(page, '13-hire', view);
    if (view !== 'desk') {
      await page.screenshot({ path: join(SHOTS, `13-hire-full-${view}.jpg`), type: 'jpeg', quality: 88, fullPage: true });
    }
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await shot(page, '14-hire-details', view);
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByRole('tab', { name: 'React', exact: true }).click();
    await page.getByRole('tab', { name: 'React', exact: true }).scrollIntoViewIfNeeded();
    await shot(page, '15-hire-react', view);
    await page.getByRole('tab', { name: 'Events', exact: true }).click();
    await page.getByRole('tab', { name: 'Events', exact: true }).scrollIntoViewIfNeeded();
    await shot(page, '15-hire-events', view);
    await page.getByRole('tab', { name: 'HTML', exact: true }).click();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes('COPIED') || document.body.innerText.includes('Copied'));
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
    const want = `<script src="${BASE}/hire/${release.file}" integrity="${release.integrity}" crossorigin="anonymous" async></script><mask-wars-hire `;
    if (!copied.startsWith(want)) problems.push(`${view}: Copy gave ${copied.slice(0, 90)}`);
    await page.evaluate(() => scrollTo(0, 0));

    // The live button: the job and dollars named, the contract asked, the vault proved in the checkout.
    await page.locator('mask-wars-hire').locator('button').click();
    const frame = await checkout(page);
    await text(frame, 'Mainnet or testnet.');
    await frame.locator('input').fill('vault.acme.testnet');
    await shot(page, '16-target', view, frame);
    await frame.getByRole('button', { name: 'Next', exact: true }).click();
    await text(frame, 'Show which one.');
    await prove(ctx, popups, frame, view);
    await text(frame, 'Where your money is now.');
    await frame.getByRole('button', { name: 'Back', exact: true }).click();
    await text(frame, 'is yours. The money lands there.');
    await shot(page, '17-vault-done', view, frame);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('mask-wars-hire-sheet')?.hidden === true);
    await ctx.close();
  }

  // 3. A page names a vault the payer does not hold: the payer's passkey proves their own, and no address follows.
  {
    const { ctx, page, popups } = await context(opts, view);
    await page.goto(`${HOST}/?other`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => customElements.get('mask-wars-hire'));
    await page.locator('mask-wars-hire').locator('button').click();
    const frame = await checkout(page);
    const w = await prove(ctx, popups, frame, view, null, false);
    await w.waitForSelector('text=This job pays into', { timeout: 30_000 });
    await shot(w, '18-other-vault', view, null, 500);
    await w.close();
    await text(frame, 'Waiting for your vault');
    await shot(page, '19-other-checkout', view, frame);
    if (await frame.getByRole('button', { name: 'Get address' }).count()) problems.push(`${view}: an address was offered for a vault the payer does not hold`);
    await ctx.close();
  }

  // 4. A page that names no job: the checkout asks for it first.
  {
    const { ctx, page } = await context(opts, view);
    await page.goto(`${HOST}/?bare`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => customElements.get('mask-wars-hire'));
    await page.locator('mask-wars-hire').locator('button').click();
    const frame = await checkout(page);
    await frame.locator('textarea').fill('Drain my staking pool before the audit');
    await shot(page, '20-job', view, frame);
    await ctx.close();
  }

  // 5. Before HIRE_LIVE: the whole path to the amount with a live price, and an honest line.
  {
    const { ctx, page, popups } = await context(opts, view);
    await ctx.route('**/api/hire/catalog', async (route) => {
      const res = await route.fetch({ headers: { ...route.request().headers(), 'sec-fetch-site': 'same-origin' } });
      const json = await res.json();
      await route.fulfill({ response: res, json: { ...json, live: false } });
    });
    await page.goto(HOST, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => customElements.get('mask-wars-hire'));
    await page.locator('mask-wars-hire').locator('button').click();
    const frame = await checkout(page);
    await prove(ctx, popups, frame, view);
    await frame.getByRole('button', { name: 'Next', exact: true }).click();
    await frame.getByRole('button', { name: 'Next', exact: true }).click();
    await text(frame, 'Hiring opens soon');
    await shot(page, '21-closed', view, frame);
    await ctx.close();
  }

  // 6. The host page reloads while money is on its way: the checkout finds the same deposit again, in this browser.
  {
    const { ctx, page, popups } = await context(opts, view);
    await page.goto(HOST, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => customElements.get('mask-wars-hire'));
    await page.locator('mask-wars-hire').locator('button').click();
    let frame = await checkout(page);
    await prove(ctx, popups, frame, view);
    await frame.getByRole('button', { name: 'Next', exact: true }).click();
    await frame.getByRole('button', { name: 'Next', exact: true }).click();
    await text(frame, 'lands in');
    await frame.getByRole('button', { name: 'Get address', exact: true }).click();
    await text(frame, 'Waiting for it');
    const address = await frame.evaluate(() => document.querySelector('[class*="addr"]')?.textContent ?? '');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => customElements.get('mask-wars-hire'));
    await page.locator('mask-wars-hire').locator('button').click();
    frame = await checkout(page);
    await text(frame, 'on Solana');
    const again = await frame.evaluate(() => document.querySelector('[class*="addr"]')?.textContent ?? '');
    if (!address || again !== address) problems.push(`${view}: after a reload the checkout showed ${again || 'no address'}, not ${address}`);
    await shot(page, '22-resumed', view, frame);
    // A new address is two taps: the first says money may already be on its way to this one.
    await frame.getByRole('button', { name: 'Change', exact: true }).click();
    await text(frame, 'Sent it already?');
    await shot(page, '23-change', view, frame);
    await frame.getByRole('button', { name: 'New address', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('log').innerText.includes('hire:dropped'));
    await ctx.close();
  }

  // 7. The checkout never loads (the page's own policy, a blocker, the network): the sheet says so and lets go.
  {
    const { ctx, page } = await context(opts, view, /ERR_FAILED/);
    await ctx.route('**/hire/embed*', (route) => route.abort());
    await page.goto(HOST, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => customElements.get('mask-wars-hire'));
    await page.locator('mask-wars-hire').locator('button').click();
    await page.waitForSelector('mask-wars-hire-sheet[data-failed]', { state: 'attached', timeout: 20_000 });
    await shot(page, '24-not-loaded', view);
    await page.locator('mask-wars-hire-sheet').locator('.x').click();
    await page.waitForFunction(() => document.querySelector('mask-wars-hire-sheet')?.hidden === true);
    if ((await page.evaluate(() => document.documentElement.style.overflow)) !== '') problems.push(`${view}: page scroll stayed locked`);
    await ctx.close();
  }
}

await browser.close();
host.close();
console.log(problems.length ? `problems:\n${problems.join('\n')}` : 'no problems');
try {
  if (server) process.kill(-server.pid);
} catch {
  /* the dev server is gone already */
}
process.exit(problems.length ? 1 : 0);
