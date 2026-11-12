// Swap through real eyes: /swap walked end to end on desk 1440×900 and phones 375×812 and 360×740, against 1Click in
// memory (the site runs with PAY_FIXTURE=1 and NEXT_PUBLIC_PAY_TEST=1, so no money moves). Each step is a shot in
// apps/web/shots/swap: the price, both pickers, a wrong address, paying from an EVM wallet to Solana, paying from an
// exchange with a refund address, a coin on NEAR paid from the NEAR wallet, a token on NEAR received with the refund
// inside NEAR Intents, «i», the swap on its way and landed. Checks the console, horizontal scroll and finger-sized
// targets on every step.
// Usage: node apps/web/scripts/swap-walk.mjs [base] [desk|phone|small]   (a server with PAY_FIXTURE=1 at base)
// An EVM wallet stands in through EIP-6963 and a NEAR wallet through the test build's hook: they switch network, read
// the coin and the balance, and "send" without a network.
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Playwright is a dependency of packages/media (it films the arena); the site borrows it from there.
const require = createRequire(join(here, '..', '..', '..', 'packages', 'media', 'package.json'));
const { chromium } = require('playwright');
const SHOTS = join(here, '..', 'shots', 'swap');
const BASE = process.argv[2] ?? 'http://localhost:3107';
const ONLY = process.argv[3] ?? null;
/** A NEAR account that is on mainnet (the account check reads NEAR itself), and a Solana wallet on the curve. */
const NEAR_ACCOUNT = 'maskwars.near';
const SOL_WALLET = '7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9';
const ARB_REFUND = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
/**
 * With SWAP_WALK_END=short or =short-unknown (the server run with the same PAY_FIXTURE_END), only that ending is walked:
 * a deposit that came in short, with the rest named, or with no number while 1Click has not said how much came.
 */
const END = process.env.SWAP_WALK_END ?? null;

mkdirSync(SHOTS, { recursive: true });
// A full walk takes new shots of its own steps and keeps the endings walked on their own server.
if (!END) for (const f of readdirSync(SHOTS)) if ((!ONLY || f.startsWith(`${ONLY}-`)) && !/-18-|^faults-short/.test(f)) rmSync(join(SHOTS, f));

const VIEWS = [
  ['desk', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ['phone', { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
  ['small', { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
].filter(([name]) => !ONLY || ONLY === name);

const faults = [];

/** A stand-in EVM wallet announced through EIP-6963, and the test build's NEAR wallet. No keys, no network. */
const STAND_INS = `(() => {
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
  window.__sentNear = [];
  window.__payWallet = {
    accountId: '${NEAR_ACCOUNT}',
    signMessage: async () => { throw new Error('not here'); },
    addKey: async () => null,
    send: async (txs) => {
      window.__sentNear.push(txs);
      await new Promise((r) => setTimeout(r, 500));
      return txs.map(() => ({ status: { SuccessValue: '' }, transaction: { hash: 'HYZ4ycqXgR4yEMhfsYgvkZjiU5V6YtbW2D5vhNVF2wWy' } }));
    },
    signOut: async () => {},
  };
})();`;
const browser = await chromium.launch();

/** Horizontal scroll, and anything a finger has to hit that is smaller than 40×40. */
async function audit(page, view, step) {
  const r = await page.evaluate(() => {
    const wide = document.documentElement.scrollWidth > window.innerWidth + 1;
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

const settled = (page) => page.waitForFunction(() => !document.querySelector('[data-dim]'), null, { timeout: 15_000 });

for (const [view, opts] of VIEWS) {
  const ctx = await browser.newContext({ ...opts, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(STAND_INS);
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && faults.push(`${view}: console ${m.text().slice(0, 160)}`));
  page.on('pageerror', (e) => faults.push(`${view}: page error ${e.message.slice(0, 160)}`));
  const shot = async (step, full = false) => {
    await page.waitForTimeout(450);
    await audit(page, view, step);
    await page.screenshot({ path: join(SHOTS, `${view}-${step}.jpg`), fullPage: full, type: 'jpeg', quality: 82 });
  };
  const fault = (what) => () => faults.push(`${view}: ${what}`);
  const receiveBtn = () => page.getByRole('button', { name: /^Receive / });
  const payBtn = () => page.getByRole('button', { name: /^Pay .* on / });
  const pickIn = async (button, search, rowName) => {
    await button.click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('textbox', { name: /Search/ }).fill(search);
    await page.getByRole('dialog').getByRole('button', { name: rowName }).first().click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  };

  if (END) {
    // Straight to a deposit that came in short, from an exchange to Solana with a refund address on Arbitrum.
    await page.goto(`${BASE}/swap`, { waitUntil: 'networkidle' });
    await payBtn().waitFor({ timeout: 20_000 });
    await page.getByRole('radio', { name: 'Exchange' }).click();
    await page.getByRole('textbox', { name: /^To/ }).fill(SOL_WALLET);
    await page.getByRole('textbox', { name: /^Refund to/ }).fill(ARB_REFUND);
    await page.getByText('A refund comes back here, on Arbitrum.').waitFor({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Get deposit address' }).click();
    await page.getByRole('button', { name: 'Copy address' }).waitFor({ timeout: 20_000 });
    const end = END === 'short' ? page.getByText(/Send 0\.5 USDC more by/) : page.getByText(/How much is not known yet/);
    await end.waitFor({ timeout: 40_000 }).catch(fault(`never ${END}`));
    if (END === 'short-unknown' && (await page.getByRole('button', { name: /^Copy the amount/ }).count())) faults.push(`${view}: an amount to copy while it is unknown`);
    await shot(`18-${END}`);
    await ctx.close();
    continue;
  }

  // Get NEAR keeps its card; the tabs lead to Swap.
  await page.goto(`${BASE}/near`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'Swap' }).waitFor();
  await shot('0-get-near-tabs');
  await page.getByRole('link', { name: 'Swap' }).click();
  await page.waitForURL(/\/swap$/);

  // The price, the pickers.
  await payBtn().waitFor({ timeout: 20_000 });
  await settled(page).catch(fault('no price'));
  await shot('1-price');
  await receiveBtn().click();
  await page.getByRole('dialog').waitFor();
  await shot('2-picker-receive');
  await page.getByRole('textbox', { name: /Search/ }).fill('near');
  await shot('3-search-near');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  // A wrong address on Solana is named for what it is.
  const to = page.getByRole('textbox', { name: /^To/ });
  await to.fill('0x3602b546589a8fcafdce7fad64a46f91db0e4d50');
  await page.getByText('That is an Ethereum address. This needs one on Solana.').waitFor({ timeout: 5_000 }).catch(fault('Ethereum address on Solana not named'));
  await shot('4-wrong-address');

  // Paying from the EVM wallet: the refund goes back to it, the swap lands on Solana.
  await to.fill(SOL_WALLET);
  await page.getByText('A Solana wallet.').waitFor({ timeout: 5_000 }).catch(fault('Solana wallet not read'));
  await page.getByRole('radio', { name: 'MetaMask' }).waitFor({ timeout: 5_000 }).catch(fault('no MetaMask to pay from'));
  await settled(page).catch(fault('no price before the wallet swap'));
  await shot('5-ready-wallet');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.getByText('Sent from MetaMask.', { exact: true }).waitFor({ timeout: 20_000 }).catch(fault('wallet payment not shown'));
  await shot('6-paid');
  await page.getByText(/^Swapping it to SOL/).waitFor({ timeout: 30_000 }).catch(fault('never swapping'));
  await shot('7-swapping');
  await page.getByRole('link', { name: 'View on Solana' }).waitFor({ timeout: 30_000 }).catch(fault('never landed with a Solana link'));
  await shot('8-landed');
  await page.getByRole('button', { name: 'Swap again' }).click();

  // From an exchange to Solana: a refund address on Arbitrum, read with certainty.
  await page.getByRole('radio', { name: 'Exchange' }).click();
  const refund = page.getByRole('textbox', { name: /^Refund to/ });
  await refund.fill(NEAR_ACCOUNT);
  await page.getByText('That is a NEAR address. This needs one on Arbitrum.').waitFor({ timeout: 5_000 }).catch(fault('NEAR account as an Arbitrum refund not named'));
  await shot('9-refund-wrong');
  await refund.fill(ARB_REFUND);
  await page.getByText('A refund comes back here, on Arbitrum.').waitFor({ timeout: 5_000 }).catch(fault('refund address not read'));
  await settled(page).catch(fault('no price for the exchange swap'));
  await shot('10-exchange-ready');
  await page.getByRole('button', { name: 'Get deposit address' }).click();
  await page.getByRole('button', { name: 'Copy address' }).waitFor({ timeout: 20_000 }).catch(fault('no deposit address'));
  // Which coin on which network, plainly, with its contract one tap away.
  await page.getByText('Send only USDC on Arbitrum', { exact: true }).waitFor({ timeout: 5_000 }).catch(fault('the coin to send not named'));
  const contract = page.getByRole('link', { name: /USDC contract 0xaf88d065e77c8cc2239327c5edb3a432268e5831, view on Arbiscan/ });
  if ((await contract.getAttribute('href').catch(() => null)) !== 'https://arbiscan.io/token/0xaf88d065e77c8cc2239327c5edb3a432268e5831') faults.push(`${view}: no Arbiscan link to the USDC contract`);
  if ((await contract.getAttribute('rel').catch(() => null)) !== 'noopener noreferrer') faults.push(`${view}: contract link without noopener noreferrer`);
  await shot('11-address');
  if (view !== 'desk') {
    await page.getByRole('button', { name: 'Show QR' }).click();
    await shot('11b-qr', true);
    await page.getByRole('button', { name: 'Hide QR' }).click();
  }
  // Starting over asks once more: a deposit already sent still lands or goes back.
  await page.getByRole('button', { name: 'Change' }).click();
  await page.getByText(/Anything already sent still lands/).waitFor({ timeout: 5_000 }).catch(fault('Change did not ask once more'));
  await shot('11c-change');
  await page.getByRole('button', { name: 'Start over' }).click();

  // A coin on NEAR, paid from the NEAR wallet in one transaction.
  await pickIn(payBtn(), 'NEAR', /^NEAR NEAR/);
  await page.getByRole('radio', { name: 'NEAR wallet' }).waitFor({ timeout: 5_000 }).catch(fault('no NEAR wallet to pay from'));
  if (await page.getByRole('radio', { name: 'Exchange' }).count()) faults.push(`${view}: an exchange offered for a coin on NEAR`);
  await settled(page).catch(fault('no price from NEAR'));
  await shot('12-from-near');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.getByText('Sent from NEAR wallet.', { exact: true }).waitFor({ timeout: 20_000 }).catch(fault('NEAR wallet payment not shown'));
  const sent = await page.evaluate(() => window.__sentNear);
  const actions = sent?.[0]?.[0]?.actions?.map((a) => a.params.methodName).join(',');
  if (sent?.[0]?.[0]?.receiverId !== 'wrap.near' || actions !== 'storage_deposit,storage_deposit,near_deposit,ft_transfer') faults.push(`${view}: NEAR wallet sent ${JSON.stringify(sent)}`);
  await shot('13-near-paid');
  await page.getByRole('link', { name: 'View on Solana' }).waitFor({ timeout: 40_000 }).catch(fault('NEAR swap never landed'));
  await page.getByRole('button', { name: 'Swap again' }).click();

  // A token on NEAR received from an exchange: the refund waits for the receiving account inside NEAR Intents.
  await pickIn(payBtn(), 'Arbitrum', /^USDT Arbitrum/);
  await pickIn(receiveBtn(), 'usdc', /^USDC NEAR/);
  await page.getByRole('radio', { name: 'Exchange' }).click();
  await page.getByRole('textbox', { name: /^To/ }).fill(NEAR_ACCOUNT);
  await page.getByText(/^On NEAR\./).waitFor({ timeout: 15_000 }).catch(fault(`${NEAR_ACCOUNT} not read`));
  await page.getByText(/inside NEAR Intents$/).first().waitFor({ timeout: 5_000 }).catch(fault('refund to NEAR Intents not said'));
  await settled(page).catch(fault('no price to NEAR'));
  await shot('14-to-near');
  await page.getByRole('button', { name: 'Details' }).click();
  await shot('15-details', true);
  await page.getByRole('button', { name: 'Details' }).click();
  // The turn-around: USDC on NEAR is paid, USDT on Arbitrum received.
  await page.getByRole('button', { name: 'Turn the swap around' }).click();
  await page.getByRole('radio', { name: 'NEAR wallet' }).waitFor({ timeout: 5_000 }).catch(fault('turn-around did not pay from NEAR'));
  await settled(page).catch(fault('no price after the turn-around'));
  await shot('16-turned');
  // A meme coin's millions: one line in the big number, nothing off screen.
  await pickIn(receiveBtn(), 'pepe', /^PEPE Ethereum/);
  await settled(page).catch(fault('no price for a meme coin'));
  const big = await page.evaluate(() => document.querySelector('[class*="bigNum"]')?.textContent ?? '');
  if (!/^\d+(\.\d+)?[MB]$/.test(big)) faults.push(`${view}: meme coin big number reads ${big}`);
  await shot('17-meme');
  await ctx.close();
}

await browser.close();
writeFileSync(join(SHOTS, `faults${END ? `-${END}` : ''}${ONLY ? `-${ONLY}` : ''}.txt`), (faults.length ? faults.join('\n') : 'no faults') + '\n');
console.log(faults.length ? faults.join('\n') : 'no faults');
