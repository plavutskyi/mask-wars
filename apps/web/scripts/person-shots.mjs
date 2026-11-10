// A person's mask through real eyes: /mask/<name> after a real sealed round on a local NEAR sandbox, the round in
// contracts/challenges/runner/tests/human.rs. ANN forged KIRA, the keeper armed it, KIRA won seal #0 in its own slot,
// the bounty contract paid KIRA's own account, the keeper settled its mind. The test stops before the owner takes the
// prize out and keeps the sandbox up; this script looks at the page on desk 1440×900 and phone 375×812, takes the
// prize out with the owner's key as a wallet would, and checks the chain moved it; first a wallet whose transaction NEAR
// fails, which must not read as taken out; last, the owner takes the tank back and the page says "Out of fuel". Also
// /forge with a change of the factory waiting, and the race page with KIRA beside NOVA. Checks the console, horizontal
// scroll, text that spills out of its box and finger-sized targets.
//
// Usage: node apps/web/scripts/person-shots.mjs <base> <human-serve.json>
//   <human-serve.json> comes from `HUMAN_SERVE=<file> cargo test -p race-runner --test human a_person -- --nocapture`
//   in contracts/challenges; the indexer from `node apps/web/scripts/sandbox-indexer.mjs <rpc> 3939`; the site runs with
//   NEXT_PUBLIC_FORGE_TEST=1 NEXT_PUBLIC_FORGE_RPC=<rpc> NEXT_PUBLIC_FORGE_FACTORY=<factory> ARENA_RPC=<rpc>
//   ARENA_INDEXER=http://127.0.0.1:3939 ARENA_CONTRACTS=<bounty>.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58Decode, NearKey, signTx } from '../../../packages/race/src/near-tx.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'shots', 'person');
const [BASE, SANDBOX] = process.argv.slice(2);
if (!BASE || !SANDBOX) throw new Error('usage: person-shots.mjs <base> <human-serve.json>');
const sandbox = JSON.parse(readFileSync(SANDBOX, 'utf8'));
const key = new NearKey(sandbox.owner_key);
const NAME = sandbox.mask.split('.')[0];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, at: new Date().toISOString(), shots: [], problems: [], chain: {} };
const problem = (where, what) => report.problems.push(`${where}: ${what}`);

async function rpc(method, params) {
  const res = await fetch(sandbox.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'person-shots', method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const balance = async (id) => BigInt((await rpc('query', { request_type: 'view_account', finality: 'final', account_id: id })).amount);

/** The owner's wallet: signs the page's one call with the owner's key and sends it. NEAR may still fail it: the hash
 * comes back either way, as a wallet hands it back. */
async function sign(receiverId, action) {
  await new Promise((r) => setTimeout(r, 900));
  const p = action.params;
  const ak = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: sandbox.owner, public_key: key.publicKeyText });
  const block = await rpc('block', { finality: 'final' });
  const tx = signTx(
    {
      signer: sandbox.owner,
      publicKey: key.publicKey,
      nonce: BigInt(ak.nonce) + 1n,
      receiver: receiverId,
      blockHash: base58Decode(block.header.hash),
      method: p.methodName,
      args: Buffer.from(JSON.stringify(p.args)),
      gas: BigInt(p.gas),
      deposit: BigInt(p.deposit),
    },
    key,
  );
  await rpc('send_tx', { signed_tx_base64: tx.base64, wait_until: 'FINAL' });
  return tx.hash;
}

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
];

async function look(page, where) {
  const issues = await page.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) out.push(`horizontal scroll ${document.documentElement.scrollWidth}`);
    for (const el of document.querySelectorAll('main button, main a, main summary')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.height < 44 || r.width < 44) out.push(`small target ${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    for (const el of document.querySelectorAll('h1, h2, button, p, a, span, dd, li')) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') out.push(`text spills out of ${el.tagName} "${el.textContent.trim().slice(0, 24)}"`);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) out.push(`off screen ${el.tagName} "${el.textContent.trim().slice(0, 24)}"`);
    }
    return out;
  });
  for (const i of issues) problem(where, i);
}

async function shot(page, name, view, full = false) {
  await page.waitForTimeout(500);
  const file = `${name}-${view}.jpg`;
  await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 84, fullPage: full });
  await look(page, file);
  report.shots.push(file);
}

const browser = await chromium.launch();
for (const [view, opts] of VIEWS) {
  // A stranger first: the prize is there for all to see, and only the owner's wallet takes it out.
  const stranger = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await stranger.addInitScript(() => {
    window.__forgeSigner = { accountId: 'bob.test.near', call: async () => { throw new Error('not the owner'); } };
  });
  const sp = await stranger.newPage();
  await sp.goto(`${BASE}/mask/${NAME}`, { waitUntil: 'networkidle' });
  await shot(sp, '1-mask', view);
  await shot(sp, '2-mask-full', view, true);
  await sp.getByRole('button', { name: 'Take it out' }).click();
  await sp.getByText('Only KIRA’s owner takes it out.', { exact: false }).waitFor({ timeout: 20_000 });
  await sp.locator('#take').scrollIntoViewIfNeeded();
  await shot(sp, '3-prize-stranger', view);
  await sp.getByRole('button', { name: /on chain/ }).first().click().catch(() => {});
  await shot(sp, '4-mask-info', view);
  await stranger.close();

  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await ctx.exposeFunction('__ownerSign', sign);
  await ctx.addInitScript((account) => {
    window.__forgeSigner = { accountId: account, call: (receiverId, action) => window.__ownerSign(receiverId, action) };
  }, sandbox.owner);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${BASE}/race/${sandbox.round}`, { waitUntil: 'networkidle' });
  await shot(page, '5-race', view);
  await shot(page, '6-race-full', view, true);

  await page.goto(`${BASE}/forge`, { waitUntil: 'networkidle' });
  const change = page.locator('details summary').filter({ hasText: /[Cc]hange/ }).first();
  await change.waitFor({ timeout: 20_000 });
  await shot(page, '7-forge-change', view);
  await change.click();
  await shot(page, '8-forge-change-open', view);

  await page.goto(`${BASE}/mask/${NAME}`, { waitUntil: 'networkidle' });
  if (view === 'phone') {
    await shot(page, '9-owner', view);
  }
  for (const e of errors) problem(view, `console: ${e}`);
  await ctx.close();
}

// The review's finding 6: the owner's wallet answers with a transaction, but NEAR fails it (too little gas for the
// withdraw). The page used to say "Taken out" with its own figure; now it asks NEAR and says what NEAR says.
for (const [view, opts] of VIEWS) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await ctx.exposeFunction('__ownerSignShort', (receiverId, action) =>
    sign(receiverId, { ...action, params: { ...action.params, gas: '500000000000' } }),
  );
  await ctx.addInitScript((account) => {
    window.__forgeSigner = { accountId: account, call: (receiverId, action) => window.__ownerSignShort(receiverId, action) };
  }, sandbox.owner);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/mask/${NAME}`, { waitUntil: 'networkidle' });
  const before = await balance(sandbox.mask);
  await page.getByRole('button', { name: 'Take it out' }).click();
  await page.getByText(/^Not taken out\./).waitFor({ timeout: 90_000 });
  if (await page.getByText(/^Taken out\./).count()) problem(view, 'a failed withdraw reads as taken out');
  if ((await balance(sandbox.mask)) < before - 10n ** 22n) problem(view, 'the failed withdraw moved the prize');
  await page.locator('#take').scrollIntoViewIfNeeded();
  await shot(page, '9-take-failed', view);
  for (const e of errors) problem(view, `console: ${e}`);
  await ctx.close();
}

// The owner takes the prize out, last, once both views have seen it waiting.
for (const [view, opts] of VIEWS.slice(0, 1)) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  await ctx.exposeFunction('__ownerSign', sign);
  await ctx.addInitScript((account) => {
    window.__forgeSigner = { accountId: account, call: (receiverId, action) => window.__ownerSign(receiverId, action) };
  }, sandbox.owner);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/mask/${NAME}`, { waitUntil: 'networkidle' });
  {
    const mask = sandbox.mask;
    const before = { owner: await balance(sandbox.owner), mask: await balance(mask) };
    await page.getByRole('button', { name: 'Take it out' }).click();
    await page.getByText(/^Taken out\./).waitFor({ timeout: 90_000 });
    // The amount on the page is the one the mask's own log names on chain.
    const line = await page.locator('#take ~ p, [role=status]').filter({ hasText: /^Taken out\./ }).first().textContent();
    report.chain.page_line = line;
    await page.locator('#take').scrollIntoViewIfNeeded();
    await shot(page, '9-taken-out', view);
    const after = { owner: await balance(sandbox.owner), mask: await balance(mask) };
    report.chain = {
      ...report.chain,
      owner_gained: (after.owner - before.owner).toString(),
      mask_before: before.mask.toString(),
      mask_after: after.mask.toString(),
    };
    if (after.owner <= before.owner) problem(view, 'the owner got nothing');
    if (after.mask >= before.mask) problem(view, 'the mask kept its prize');
    await page.reload({ waitUntil: 'networkidle' });
    if (await page.getByRole('button', { name: 'Take it out' }).count()) problem(view, 'the prize is still offered after it was taken');
    await shot(page, '10-after', view, true);
  }
  for (const e of errors) problem(view, `console: ${e}`);
  await ctx.close();
}
// The review's finding 8: ANN takes KIRA's tank back. With nothing left for its mind the page says so, and it promises
// no race: rounds with the people's masks open by hand, not on a schedule.
await sign(sandbox.factory, { params: { methodName: 'unfuel', args: { name: NAME }, gas: '50000000000000', deposit: '0' } });
for (const [view, opts] of VIEWS) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/mask/${NAME}`, { waitUntil: 'networkidle' });
  await page.getByText('Out of fuel').waitFor({ timeout: 20_000 });
  if (await page.getByText(/next race|next round/i).count()) problem(view, 'an empty tank still promises a race');
  await shot(page, '11-out-of-fuel', view);
  for (const e of errors) problem(view, `console: ${e}`);
  await ctx.close();
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ shots: report.shots.length, problems: report.problems, chain: report.chain }, null, 2));
