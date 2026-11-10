// Confidential copying through real eyes, on a local NEAR sandbox from
// `contracts/masks/sandbox/src/bin/serve-copy.rs`: ANN forged KIRA with a sealed strategy and opened it to copying for
// 30%, and VERA with a strategy she has not opened; BOB forged NINA as a copy, and a prize waits on NINA; MIRA, another
// copy, won and its owner withdrew, so KIRA was already paid on it. Every action is a real transaction on the sandbox,
// signed with the owners' keys as their wallets would, and every result the page shows is read back from the chain.
//
// What it walks, on desk 1440×900 and phone 375×812:
// - KIRA's page as a stranger: the "Copy this mind" panel, the copies and what KIRA earned, the «i»; the owner's
//   control refuses a stranger's wallet;
// - NINA's page: the quiet line naming its author, and what its owner takes out;
// - `/forge?copy=kira` as BOB: the banner with the share; (desk) BOB walks the forge while ANN changes the share, and
//   the page says the share changed and nothing was forged; BOB forges again on the new terms;
// - KIRA's page as ANN: the owner's control open; (desk) change the share, collect what waits on the copies; (phone)
//   stop new copies, then open VERA to copies.
// It checks the console, horizontal scroll, text that spills out of its box and finger-sized targets.
//
// Usage: node apps/web/scripts/copy-shots.mjs <base> <copy-serve.json>
//   <copy-serve.json> from `cargo run -p masks-sandbox --bin serve-copy -- <file>`; the site runs with
//   NEXT_PUBLIC_FORGE_TEST=1 NEXT_PUBLIC_FORGE_RPC=<rpc> NEXT_PUBLIC_FORGE_FACTORY=<factory>.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base58Decode, NearKey, signTx } from '../../../packages/race/src/near-tx.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'shots', 'copy');
const [BASE, SANDBOX] = process.argv.slice(2);
if (!BASE || !SANDBOX) throw new Error('usage: copy-shots.mjs <base> <copy-serve.json>');
const sandbox = JSON.parse(readFileSync(SANDBOX, 'utf8'));
const AUTHOR = sandbox.author;
const COPY = sandbox.copy;
const CLOSED = sandbox.closed;
const KEYS = {
  [sandbox.author_owner]: new NearKey(sandbox.author_owner_key),
  [sandbox.copy_owner]: new NearKey(sandbox.copy_owner_key),
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const report = { base: BASE, at: new Date().toISOString(), shots: [], problems: [], chain: {} };
const problem = (where, what) => report.problems.push(`${where}: ${what}`);

async function rpc(method, params) {
  const res = await fetch(sandbox.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'copy-shots', method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const call = async (account, method, args) => {
  const r = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(args === null ? '' : JSON.stringify(args)).toString('base64'),
  });
  return Buffer.from(r.result).toString('utf8');
};
const mask = async (name) => JSON.parse(await call(sandbox.factory, 'get_mask', { name }));
const terms = async (account) => {
  const f = (await call(account, 'copy_terms', null)).split('|');
  return { author: f[0], bps: Number(f[1]), paid: BigInt(f[2]), owed: BigInt(f[3]), due: BigInt(f[4]), owner: BigInt(f[5]) };
};

/** A person's wallet: signs one call with their key and sends it. NEAR may still fail it: the hash comes back either
 * way, as a wallet hands it back. */
async function sign(signer, receiverId, action) {
  await new Promise((r) => setTimeout(r, 600));
  const key = KEYS[signer];
  const p = action.params;
  const ak = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: signer, public_key: key.publicKeyText });
  const block = await rpc('block', { finality: 'final' });
  const tx = signTx(
    {
      signer,
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
    for (const el of document.querySelectorAll('main button, main a, main summary, main label')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.height < 44 || r.width < 44) out.push(`small target ${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    for (const el of document.querySelectorAll('h1, h2, button, p, a, span, dd, li, label, legend')) {
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

/** A browser context whose wallet is `account`'s; a stranger's wallet refuses to sign anything. */
async function as(browser, opts, account) {
  const ctx = await browser.newContext({ ...opts, colorScheme: 'dark' });
  if (KEYS[account]) {
    await ctx.exposeFunction('__copySign', (receiverId, action) => sign(account, receiverId, action));
    await ctx.addInitScript((a) => {
      window.__forgeSigner = { accountId: a, call: (receiverId, action) => window.__copySign(receiverId, action) };
    }, account);
  } else {
    await ctx.addInitScript((a) => {
      window.__forgeSigner = { accountId: a, call: async () => { throw new Error('a stranger signs nothing'); } };
    }, account);
  }
  const page = await ctx.newPage();
  const errors = [];
  // The dev server's hot-reload socket cannot open through the agent proxy; that noise is not the app's.
  const noise = (t) => /_next\/hmr|websocket/i.test(t);
  page.on('console', (m) => m.type() === 'error' && !noise(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => !noise(String(e)) && errors.push(String(e)));
  return { ctx, page, errors };
}

const browser = await chromium.launch();
for (const [view, opts] of VIEWS) {
  // ---- a stranger on KIRA's page and NINA's ------------------------------------------------------------------------
  {
    const { ctx, page, errors } = await as(browser, opts, 'carol.test.near');
    await page.goto(`${BASE}/mask/${AUTHOR}`, { waitUntil: 'networkidle' });
    await page.getByText('Copy this mind', { exact: false }).first().waitFor({ timeout: 20_000 });
    await page.getByText(/copy · |copies · /i).first().waitFor({ timeout: 20_000 }).catch(() => problem(`author ${view}`, 'no copy count shown'));
    await shot(page, '1-author', view);
    await shot(page, '2-author-full', view, true);
    await page.getByRole('button', { name: /Copying, on chain/i }).first().click().catch(() => problem(`author ${view}`, 'no Copying info button'));
    await page.waitForTimeout(400);
    await shot(page, '3-author-info', view);
    await page.keyboard.press('Escape');
    // The owner's control is there for all to see; a stranger's wallet is refused before anything is sent.
    await page.getByRole('button', { name: 'Manage copying' }).click();
    await page.getByRole('button', { name: 'Stop new copies' }).click();
    await page.getByText('Only KIRA’s owner does this. This wallet is carol.test.near.').waitFor({ timeout: 20_000 }).catch(() => problem(`author ${view}`, 'a stranger was not refused'));
    await page.locator('[aria-label^="KIRA’s copying"]').scrollIntoViewIfNeeded();
    await shot(page, '4-author-stranger', view);
    if (!(await mask(AUTHOR)).copyable) problem(`author ${view}`, 'a stranger closed KIRA');

    await page.goto(`${BASE}/mask/${COPY}`, { waitUntil: 'networkidle' });
    await page.getByText('Plays', { exact: false }).first().waitFor({ timeout: 20_000 }).catch(() => problem(`copy ${view}`, 'no author line on the copy'));
    await page.getByRole('link', { name: new RegExp(AUTHOR, 'i') }).first().waitFor({ timeout: 5_000 }).catch(() => problem(`copy ${view}`, 'no author link on the copy'));
    await shot(page, '5-copy', view);
    if (errors.length) problem(`console stranger ${view}`, errors.join(' | '));
    await ctx.close();
  }

  // ---- BOB copies KIRA -------------------------------------------------------------------------------------------
  {
    const { ctx, page, errors } = await as(browser, opts, sandbox.copy_owner);
    await page.goto(`${BASE}/forge?copy=${AUTHOR}`, { waitUntil: 'networkidle' });
    const shown = (await mask(AUTHOR)).author_bps / 100;
    await page.getByText(new RegExp(`Copying ${AUTHOR}`, 'i')).first().waitFor({ timeout: 20_000 }).catch(() => problem(`forge ${view}`, 'no copy banner on /forge'));
    await page.getByText(`earns ${shown}% of what you win`, { exact: false }).waitFor({ timeout: 5_000 }).catch(() => problem(`forge ${view}`, `the banner does not say ${shown}%`));
    await shot(page, '6-forge-copy', view);

    if (view === 'desk') {
      // Finding 4 through the page: BOB reads 30% and walks the forge; before he signs, ANN changes the share to 20%.
      const next = () => page.locator('form button[type=submit]').click();
      for (let i = 0; i < 4; i++) {
        await next();
        await page.waitForTimeout(250);
      }
      await page.locator('form input').fill('zara');
      await page.waitForTimeout(900);
      await sign(sandbox.author_owner, sandbox.factory, { params: { methodName: 'allow_copy', args: { name: AUTHOR, author_bps: 2000 }, gas: '30000000000000', deposit: '100000000000000000000000' } });
      await next();
      await page.getByText('KIRA’s owner changed the share to 20%.', { exact: false }).waitFor({ timeout: 60_000 }).catch(() => problem('forge desk', 'the changed share was not told'));
      await shot(page, '7-forge-share-changed', view);
      if ((await mask('zara')) !== null) problem('forge desk', 'a copy was forged on terms BOB never saw');
      // BOB reads 20% now and forges on those terms.
      await page.getByText('earns 20% of what you win', { exact: false }).waitFor({ timeout: 5_000 }).catch(() => problem('forge desk', 'the banner does not show the new share'));
      await next();
      await page.getByText('Ready to race').waitFor({ timeout: 60_000 }).catch(() => problem('forge desk', 'the copy at 20% was not forged'));
      await page.waitForTimeout(2500);
      await shot(page, '8-forge-copied', view);
      const zara = await mask('zara');
      report.chain.zara = zara;
      if (zara?.copy_of !== AUTHOR || zara?.copy_bps !== 2000) problem('forge desk', `ZARA is not a copy at 20%: ${JSON.stringify(zara)}`);
    }
    if (errors.length) problem(`console copier ${view}`, errors.join(' | '));
    await ctx.close();
  }

  // ---- ANN, KIRA's owner -----------------------------------------------------------------------------------------
  {
    const { ctx, page, errors } = await as(browser, opts, sandbox.author_owner);
    await page.goto(`${BASE}/mask/${AUTHOR}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Manage copying' }).click();
    const box = page.locator('[aria-label^="KIRA’s copying"]');
    await box.scrollIntoViewIfNeeded();
    await shot(page, '9-author-manage', view);

    if (view === 'desk') {
      // A new share for new copies.
      await box.getByText('25%', { exact: true }).click();
      await page.getByRole('button', { name: 'Change share to 25%' }).click();
      await page.getByText('Done. New copies of KIRA pay you 25%', { exact: false }).waitFor({ timeout: 60_000 }).catch(() => problem('owner desk', 'the share change was not confirmed'));
      await shot(page, '10-author-share', view);
      const k = await mask(AUTHOR);
      if (k.author_bps !== 2500) problem('owner desk', `KIRA's share on chain is ${k.author_bps}`);
      // Collect what waits on NINA: NINA's own code pays KIRA's account.
      const before = await terms(sandbox.copy_account);
      report.chain.ninaBefore = { ...before, paid: String(before.paid), owed: String(before.owed), due: String(before.due), owner: String(before.owner) };
      await page.getByRole('button', { name: /^Collect / }).click();
      await page.getByText(/Collected .* NEAR to KIRA’s account/).waitFor({ timeout: 90_000 }).catch(() => problem('owner desk', 'the collect was not confirmed'));
      await page.waitForTimeout(2500);
      await shot(page, '11-author-collected', view);
      await shot(page, '11-author-collected-full', view, true);
      const after = await terms(sandbox.copy_account);
      report.chain.ninaAfter = { ...after, paid: String(after.paid), owed: String(after.owed), due: String(after.due), owner: String(after.owner) };
      if (after.paid - before.paid !== before.due) problem('owner desk', `collected ${after.paid - before.paid}, was due ${before.due}`);
    } else {
      // Stop new copies: the copies made keep their terms.
      await page.getByRole('button', { name: 'Stop new copies' }).click();
      const stopped = page.getByText('Closed to new copies. The', { exact: false });
      await stopped.waitFor({ timeout: 60_000 }).catch(() => problem('owner phone', 'the stop was not confirmed'));
      await page.waitForTimeout(2000);
      await stopped.scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, '12-author-stopped', view);
      const k = await mask(AUTHOR);
      if (k.copyable) problem('owner phone', 'KIRA is still open on chain');
      // VERA: a mask with a strategy, never opened. ANN opens it at 15%.
      await page.goto(`${BASE}/mask/${CLOSED}`, { waitUntil: 'networkidle' });
      await page.locator('#copy').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await shot(page, '13-closed', view);
      await page.getByRole('button', { name: 'Let others copy' }).click();
      const vbox = page.locator('[aria-label^="VERA’s copying"]');
      await vbox.getByText('15%', { exact: true }).click();
      await vbox.scrollIntoViewIfNeeded();
      await shot(page, '14-closed-open', view);
      await page.getByRole('button', { name: 'Let others copy · 15%' }).click();
      const opened = page.getByText('VERA is open to copies. Each copy pays you 15%', { exact: false });
      await opened.waitFor({ timeout: 60_000 }).catch(() => problem('owner phone', 'opening VERA was not confirmed'));
      await page.waitForTimeout(2000);
      await opened.scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, '15-closed-opened', view);
      const v = await mask(CLOSED);
      if (!v.copyable || v.author_bps !== 1500) problem('owner phone', `VERA on chain: ${v.copyable} ${v.author_bps}`);
    }
    if (errors.length) problem(`console owner ${view}`, errors.join(' | '));
    await ctx.close();
  }
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ shots: report.shots.length, problems: report.problems }, null, 2));
if (report.problems.length) process.exit(1);
