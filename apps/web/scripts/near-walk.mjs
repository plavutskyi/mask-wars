// Get NEAR through real eyes: /near walked end to end on desk 1440×900 and phones 375×812 and 360×740, against 1Click in
// memory (the site runs with PAY_FIXTURE=1, so no money moves). Each step is a shot in apps/web/shots/near: the price,
// the coin picker, the account read, «i», the deposit address, the swap on its way, NEAR landed. Checks the console,
// horizontal scroll and finger-sized targets on every step.
// Usage: node apps/web/scripts/near-walk.mjs [base] [desk|phone|small]   (a server with PAY_FIXTURE=1 at base)
// With NEAR_WALK_END=refunded or =short (the server run with the same PAY_FIXTURE_END) it walks to that ending instead
// and adds its shots to the others. An EVM wallet stands in through EIP-6963 (it switches network, reads the coin and the
// balance, and "sends" without a network), so the pay-from-wallet path is walked too.
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Playwright is a dependency of packages/media (it films the arena); the site borrows it from there.
const require = createRequire(join(here, '..', '..', '..', 'packages', 'media', 'package.json'));
const { chromium } = require('playwright');
const SHOTS = join(here, '..', 'shots', 'near');
const BASE = process.argv[2] ?? 'http://localhost:3107';
const ONLY = process.argv[3] ?? null;
const ACCOUNT = process.env.NEAR_WALK_ACCOUNT ?? 'maskwars.near';

const END = process.env.NEAR_WALK_END ?? null;
mkdirSync(SHOTS, { recursive: true });
// A full walk takes new shots of its own steps and keeps the endings walked on their own server.
if (!END) for (const f of readdirSync(SHOTS)) if (!/-11-|^faults-/.test(f)) rmSync(join(SHOTS, f));

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['small', { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
].filter(([name]) => !ONLY || ONLY === name);

const faults = [];

/** A stand-in EVM wallet, announced through EIP-6963 the way a real one is. No keys, no network. */
const STAND_IN_WALLET = `(() => {
  let chain = '0x1';
  const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const provider = {
    async request({ method, params }) {
      switch (method) {
        case 'eth_requestAccounts': return ['0x1111111111111111111111111111111111111111'];
        case 'eth_chainId': return chain;
        case 'wallet_switchEthereumChain': chain = params[0].chainId; return null;
        case 'eth_call': return params[0].data === '0x313ce567' ? word(6) : word(10n ** 12n);
        case 'eth_getBalance': return word(10n ** 20n);
        case 'eth_sendTransaction': await new Promise((r) => setTimeout(r, 500)); return '0x' + 'ab'.repeat(32);
      }
      throw new Error(method);
    },
  };
  window.addEventListener('eip6963:requestProvider', () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'walk', name: 'MetaMask', icon: '', rdns: 'walk.stand-in' }, provider } })));
})();`;
const browser = await chromium.launch();

/** Horizontal scroll, and anything a finger has to hit that is smaller than 40×40. */
async function audit(page, view, step) {
  const r = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth > window.innerWidth + 1;
    // The page's own targets; the header's network switch is the site's, sized there.
    const small = [...document.querySelectorAll('button, a, input, [role="radio"]')]
      .filter((el) => !el.closest('nav[aria-label="Network"]'))
      .filter((el) => {
        const b = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return b.width > 0 && b.height > 0 && style.visibility !== 'hidden' && (b.width < 40 || b.height < 40);
      })
      .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)}`);
    return { wide, small };
  });
  if (r.wide) faults.push(`${view} ${step}: scrolls sideways`);
  for (const s of r.small) faults.push(`${view} ${step}: small target ${s}`);
}

for (const [view, opts] of VIEWS) {
  const ctx = await browser.newContext({ ...opts, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(STAND_IN_WALLET);
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && faults.push(`${view}: console ${m.text().slice(0, 160)}`));
  page.on('pageerror', (e) => faults.push(`${view}: page error ${e.message.slice(0, 160)}`));
  const shot = async (step, full = false) => {
    await page.waitForTimeout(450);
    await audit(page, view, step);
    await page.screenshot({ path: join(SHOTS, `${view}-${step}.jpg`), fullPage: full, type: 'jpeg', quality: 82 });
  };

  await page.goto(`${BASE}/near`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /USDT/ }).waitFor();

  if (END) {
    // Straight to an ending that is not NEAR landing: the way back to the coin in NEAR Intents.
    await page.getByRole('textbox', { name: 'To' }).fill(ACCOUNT);
    await page.getByText(/^On NEAR\./).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Get NEAR' }).click();
    await page.getByRole('button', { name: 'Copy address' }).waitFor({ timeout: 20_000 });
    const end =
      END === 'short'
        ? page.getByText(/Send .* more by/)
        : END === 'short-unknown'
          ? page.getByText(/How much is not known yet/)
          : page.getByRole('link', { name: 'Open NEAR Intents' });
    await end.waitFor({ timeout: 40_000 }).catch(() => faults.push(`${view}: never ${END}`));
    await shot(`11-${END}`);
    await ctx.close();
    continue;
  }
  await page.waitForFunction(() => !document.querySelector('[data-dim]'), null, { timeout: 15_000 }).catch(() => faults.push(`${view}: no price`));
  await shot('1-price');

  // The picker: popular first, then a search, then a network.
  await page.getByRole('button', { name: /USDT/ }).click();
  await page.getByRole('dialog').waitFor();
  await shot('2-picker');
  await page.getByRole('textbox', { name: /Search/ }).fill('sol');
  await shot('3-search');
  await page.getByRole('textbox', { name: /Search/ }).fill('');
  await page.getByRole('button', { name: 'Tron', exact: true }).click();
  await shot('4-network');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  // A receiver a link names is marked and waits for the person to say it is theirs.
  await page.goto(`${BASE}/near?to=${ACCOUNT}`, { waitUntil: 'networkidle' });
  await page.getByText('From a link. Check it is your own account.').waitFor({ timeout: 15_000 }).catch(() => faults.push(`${view}: link not marked`));
  if (!(await page.getByRole('button', { name: 'Get NEAR' }).isDisabled())) faults.push(`${view}: Get NEAR open for a link's account`);
  await shot('4b-from-link');
  await page.getByRole('button', { name: 'It is mine' }).click();
  await page.getByText(/^On NEAR\./).waitFor({ timeout: 15_000 }).catch(() => faults.push(`${view}: link account not confirmed`));

  // An Ethereum address is refused, a name NEAR knows is ready.
  const to = page.getByRole('textbox', { name: 'To' });
  await to.fill('0x3602b546589a8fcafdce7fad64a46f91db0e4d50');
  await shot('5-eth-address');
  await to.fill(ACCOUNT);
  await page.getByText(/^On NEAR\./).waitFor({ timeout: 15_000 }).catch(() => faults.push(`${view}: ${ACCOUNT} not read`));
  await page.getByRole('radio', { name: '$50' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-dim]'), null, { timeout: 15_000 }).catch(() => faults.push(`${view}: no price for $50`));
  await shot('6-ready');
  await page.getByRole('button', { name: 'Details' }).click();
  await shot('7-details', true);
  await page.getByRole('button', { name: 'Details' }).click();

  // The deposit address, then the swap as 1Click in memory moves it along.
  await page.getByRole('button', { name: 'Get NEAR' }).click();
  await page.getByRole('button', { name: 'Copy address' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Pay with MetaMask' }).waitFor({ timeout: 5_000 }).catch(() => faults.push(`${view}: no pay-from-wallet button`));
  // Which coin on which network, plainly, with its contract on the network's explorer.
  await page.getByText('Send only USDT on Arbitrum', { exact: true }).waitFor({ timeout: 5_000 }).catch(() => faults.push(`${view}: the coin to send not named`));
  if ((await page.getByRole('link', { name: /view on Arbiscan/ }).getAttribute('href').catch(() => null)) !== 'https://arbiscan.io/token/0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9') {
    faults.push(`${view}: no Arbiscan link to the USDT contract`);
  }
  await shot('8-send');
  if (view !== 'desk') {
    await page.getByRole('button', { name: 'Show QR' }).click();
    await shot('8b-qr', true);
    await page.getByRole('button', { name: 'Hide QR' }).click();
  }
  await page.getByRole('button', { name: 'Pay with MetaMask' }).click();
  await page.getByText('Sent from MetaMask.', { exact: true }).waitFor({ timeout: 10_000 }).catch(() => faults.push(`${view}: wallet payment not shown`));
  await shot('8c-paid');
  await page.getByRole('button', { name: 'Copy address' }).click();
  await page.getByText('Swapping it to NEAR now.').waitFor({ timeout: 30_000 }).catch(() => faults.push(`${view}: never swapping`));
  await shot('9-swapping');
  await page.getByRole('link', { name: 'Go to the race' }).waitFor({ timeout: 30_000 }).catch(() => faults.push(`${view}: never landed`));
  await shot('10-landed');
  // The landed swap is forgotten on reload: the page starts fresh.
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Get NEAR' }).waitFor();
  await ctx.close();
}

await browser.close();
writeFileSync(join(SHOTS, END ? `faults-${END}.txt` : 'faults.txt'), (faults.length ? faults.join('\n') : 'no faults') + '\n');
console.log(faults.length ? faults.join('\n') : 'no faults');
