// /forge through real eyes, end to end: every step on desk 1440×900 and phone 375×812, and a mask really forged on a
// local NEAR sandbox with the real factory (contracts/masks). The page signs with a test signer that holds the sandbox
// person's key; nothing else differs from production. Checks the console, horizontal scroll, text that spills out of
// its box and finger-sized targets.
//
// Usage: node apps/web/scripts/forge-shots.mjs <base> <sandbox.json>
//   <sandbox.json> comes from `cargo run -p masks-sandbox --bin serve -- <sandbox.json>` in contracts/masks;
//   the site runs with NEXT_PUBLIC_FORGE_TEST=1 NEXT_PUBLIC_FORGE_RPC=<rpc> NEXT_PUBLIC_FORGE_FACTORY=<factory>.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58Decode, NearKey, signTx } from '../../../packages/race/src/near-tx.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'shots', 'forge');
const [BASE, SANDBOX] = process.argv.slice(2);
if (!BASE || !SANDBOX) throw new Error('usage: forge-shots.mjs <base> <sandbox.json>');
const sandbox = JSON.parse(readFileSync(SANDBOX, 'utf8'));
const key = new NearKey(sandbox.secret_key);
const rivalKey = new NearKey(sandbox.rival_key);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const report = { base: BASE, at: new Date().toISOString(), shots: [], problems: [] };
const problem = (where, what) => report.problems.push(`${where}: ${what}`);

async function rpc(method, params) {
  const res = await fetch(sandbox.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'forge-shots', method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** A person takes a moment in their wallet; the clay mask waits with them. */
const SIGN_MS = 1500;
/** Names to forge on the desk and the phone: `FORGE_NAMES=lena,vex` by default. */
const [DESK_NAME, PHONE_NAME] = (process.env.FORGE_NAMES ?? 'lena,vex').split(',');
/** Names a rival takes while the person signs, on the desk and the phone: `FORGE_RACED=zora,zeta` by default. */
const RACED = (process.env.FORGE_RACED ?? 'zora,zeta').split(',');

/** Signs one call with `who`'s key and sends it, waiting for the final outcome. */
async function send(who, nearKey, receiverId, params) {
  const ak = await rpc('query', {
    request_type: 'view_access_key',
    finality: 'final',
    account_id: who,
    public_key: nearKey.publicKeyText,
  });
  const block = await rpc('block', { finality: 'final' });
  const tx = signTx(
    {
      signer: who,
      publicKey: nearKey.publicKey,
      nonce: BigInt(ak.nonce) + 1n,
      receiver: receiverId,
      blockHash: base58Decode(block.header.hash),
      method: params.methodName,
      args: Buffer.from(JSON.stringify(params.args)),
      gas: BigInt(params.gas),
      deposit: BigInt(params.deposit),
    },
    nearKey,
  );
  await rpc('send_tx', { signed_tx_base64: tx.base64, wait_until: 'FINAL' });
  return tx.hash;
}

/**
 * Signs and sends the page's one call with the sandbox person's key, as a wallet would. For a raced name the rival
 * forges it first, between the page's check and the signature: the person's forge is refused on chain.
 */
async function sign(receiverId, action) {
  await new Promise((r) => setTimeout(r, SIGN_MS));
  const p = action.params;
  if (RACED.includes(p.args.name)) {
    await send(sandbox.rival, rivalKey, receiverId, { ...p, args: { ...p.args, strategy: null }, deposit: (10n ** 24n).toString() });
  }
  return send(sandbox.account, key, receiverId, p);
}

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];

const browser = await chromium.launch();

async function look(page, where) {
  const issues = await page.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`horizontal scroll ${document.documentElement.scrollWidth}`);
    for (const el of document.querySelectorAll('button, a, input')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.height < 44 || r.width < 44) out.push(`small target ${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    for (const el of document.querySelectorAll('h1 span, button, p, a')) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push(`text spills out of ${el.tagName} "${el.textContent.trim().slice(0, 24)}"`);
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1 || r.left < -1) out.push(`off screen ${el.tagName} "${el.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  for (const i of issues) problem(where, i);
}

async function shot(page, name, view) {
  await page.waitForTimeout(450);
  const file = `${name}-${view}.jpg`;
  await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 82 });
  await look(page, file);
  report.shots.push(file);
}

for (const [view, opts] of VIEWS) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await ctx.exposeFunction('__forgeSign', sign);
  await ctx.addInitScript((account) => {
    window.__forgeSigner = { accountId: account, call: (receiverId, action) => window.__forgeSign(receiverId, action) };
  }, sandbox.account);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/forge`, { waitUntil: 'networkidle' });
  const next = () => page.locator('form button[type=submit]').click();

  await shot(page, '1-face', view);
  await page.getByRole('radio', { name: 'Crimson' }).click();
  await shot(page, '1-face-crimson', view);
  await next();
  await shot(page, '2-mind', view);
  await page.getByRole('radio', { name: 'DeepSeek V4.1 Flash' }).click();
  await page.getByRole('button', { name: 'Details' }).click();
  await shot(page, '2-mind-details', view);
  await next();
  await page.getByRole('radio', { name: 'Cunning' }).click();
  await shot(page, '3-style', view);
  await next();
  await shot(page, '4-plan', view);
  await page.locator('form input').fill('Wait for the window. Then take it all.');
  await shot(page, '4-plan-typed', view);
  await next();
  await shot(page, '5-fuel', view);
  await page.getByRole('button', { name: 'Details' }).click();
  await shot(page, '5-fuel-details', view);
  await next();
  await shot(page, '6-name', view);
  await page.locator('form input').fill('kira');
  await page.waitForTimeout(900);
  await shot(page, '6-name-taken', view);
  // A rival forges the name while the person signs: the page must say so, never show the rival's mask as hers.
  const raced = view === 'desk' ? RACED[0] : RACED[1];
  await page.locator('form input').fill(raced);
  await page.waitForTimeout(900);
  await next();
  await page.getByText(`${raced.toUpperCase()} was just taken. Your NEAR came back.`).waitFor({ timeout: 60_000 });
  await shot(page, '6-name-raced', view);
  if (await page.getByText('Ready to race').count()) problem(view, `the rival's ${raced} shown as forged`);
  const name = view === 'desk' ? DESK_NAME : PHONE_NAME;
  await page.locator('form input').fill(name);
  await page.waitForTimeout(900);
  await shot(page, '6-name-free', view);
  await next();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `7-clay-${view}.jpg`), type: 'jpeg', quality: 82 });
  report.shots.push(`7-clay-${view}.jpg`);
  await page.getByText('Ready to race').waitFor({ timeout: 60_000 });
  // The reveal: the line of light crosses the mask in about a second, then the eyes catch fire.
  for (const [at, wait] of [['a', 150], ['b', 300], ['c', 300]]) {
    await page.waitForTimeout(wait);
    await page.screenshot({ path: join(OUT, `8-reveal-${at}-${view}.jpg`), type: 'jpeg', quality: 82 });
    report.shots.push(`8-reveal-${at}-${view}.jpg`);
  }
  await page.waitForTimeout(1500);
  await shot(page, '9-forged', view);

  const mask = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: sandbox.factory,
    method_name: 'get_mask',
    args_base64: Buffer.from(JSON.stringify({ name })).toString('base64'),
  });
  const view_ = JSON.parse(Buffer.from(mask.result).toString('utf8'));
  report[`${view}-mask`] = view_;
  if (view_?.owner !== sandbox.account || view_?.look !== 'crimson' || view_?.style !== 'cunning' || !view_?.strategy) {
    problem(view, `the forged mask is not what was chosen: ${JSON.stringify(view_)}`);
  }
  const keys = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: view_.account });
  if (keys.keys.length !== 0) problem(view, `the new mask has keys: ${JSON.stringify(keys.keys)}`);
  for (const e of errors) problem(view, `console: ${e}`);
  await ctx.close();
}

await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ shots: report.shots.length, problems: report.problems }, null, 2));
