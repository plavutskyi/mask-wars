// @vitest-environment happy-dom
// The Swap card itself, against /api/pay/swap in memory: paying from an EVM wallet (the refund goes back to it), paying
// from an exchange (a refund address on the paying network, read with certainty), a coin on NEAR paid from the NEAR
// wallet in one transaction, a token received on NEAR with the refund inside NEAR Intents, a quote that does not read
// back, and the turn-around.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRefund, swapCatalogOf, type SwapProgress, type SwapQuoteView, type Token, type Transaction } from '@maskwars/pay';
import { Swap } from './Swap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.setConfig({ testTimeout: 20_000 });
vi.mock('next/link', () => ({ default: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) => <a href={href} className={className}>{children}</a> }));

const nearSent: Transaction[][] = [];
const nearWallet = { timeout: false };
vi.mock('../wallet/near', () => ({
  nearSignIn: async () => ({
    accountId: 'kira.near',
    send: async (txs: Transaction[]) => {
      nearSent.push(txs);
      if (nearWallet.timeout) throw new Error('Request timed out');
      return [{ status: { SuccessValue: '' }, transaction: { hash: 'HYZ4ycqXgR4yEMhfsYgvkZjiU5V6YtbW2D5vhNVF2wWy' } }];
    },
  }),
}));

import fixture from '@maskwars/pay/fixtures/tokens.json';

const catalog = swapCatalogOf(fixture.tokens as Token[])!;
const coin = (chain: string, symbol: string) => catalog.chains.find((c) => c.id === chain)!.coins.find((c) => c.symbol === symbol)!;
const SOL_WALLET = '7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9';
const FROM = '0x1111111111111111111111111111111111111111';
const EVM_DEPOSIT = '0x9d366cbb21925d26e60b58124f3dba9474b208b8';
const NEAR_DEPOSIT = 'ff586ca661152445c7a3925587cb6a66a4f4906d04506e50b92316e280261794';

type Ask = { from: string; to: string; amount: string; dry: boolean; recipient?: string; payer?: string; refund?: string };
let asked: Ask[] = [];
let told: unknown[] = [];
let statuses: SwapProgress[] = [];
let bend: ((q: SwapQuoteView) => SwapQuoteView) | null = null;
let root: Root | null = null;
let box: HTMLDivElement;

/** A quote as /api/pay/swap/quote gives it: the server's own reading of the body, echoed back. */
function quoteFor(b: Ask): SwapQuoteView {
  const fromChain = catalog.chains.find((c) => c.coins.some((x) => x.assetId === b.from))!;
  const refund = b.payer
    ? { to: b.payer, type: 'ORIGIN_CHAIN' as const }
    : b.refund
      ? (readRefund(fromChain.id, b.refund) as { ok: true; refund: { to: string; type: 'ORIGIN_CHAIN' | 'INTENTS' } }).refund
      : { to: b.recipient ?? '', type: 'INTENTS' as const };
  const q: SwapQuoteView = {
    correlationId: b.dry ? 'preview0' : 'c0ffee00',
    dry: b.dry,
    depositAddress: b.dry ? null : fromChain.id === 'near' ? NEAR_DEPOSIT : EVM_DEPOSIT,
    depositMemo: null,
    originAsset: b.from,
    destinationAsset: b.to,
    recipient: b.dry ? null : (b.recipient ?? null),
    recipientType: 'DESTINATION_CHAIN',
    refundTo: b.dry ? null : refund.to,
    refundType: b.dry ? 'INTENTS' : refund.type,
    amountIn: b.amount,
    minAmountIn: ((BigInt(b.amount) * 99n) / 100n).toString(),
    amountOut: '293400000',
    minAmountOut: '290466000',
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    closes: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    timeEstimate: 20,
    fees: [{ recipient: 'maskwars.near', fee: 25 }],
    withdrawFee: '5000',
    refundFee: null,
  };
  return bend && !b.dry ? bend(q) : q;
}

function api() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/pay/swap') return Response.json({ live: true, maxUsd: 100, fee: { recipient: 'maskwars.near', fee: 25 }, near: catalog.near, chains: catalog.chains });
    if (url.startsWith('/api/pay/near/account')) {
      const id = new URL(url, 'https://maskwars.xyz').searchParams.get('id')!;
      return Response.json({ ok: true, id, kind: /^[0-9a-f]{64}$/.test(id) ? 'implicit' : 'named', exists: id !== 'nobody.near' });
    }
    if (url === '/api/pay/swap/quote') {
      const b = JSON.parse(String(init?.body)) as Ask;
      asked.push(b);
      return Response.json({ quote: quoteFor(b) });
    }
    if (url.startsWith('/api/pay/swap/status')) return Response.json(statuses.length > 1 ? statuses.shift() : (statuses[0] ?? progress({})));
    if (url.startsWith('/api/pay/swap/near')) return Response.json({ depositStorage: '1250000000000000000000', payerStorage: '0', balance: (50n * 10n ** 24n).toString(), near: (50n * 10n ** 24n).toString() });
    if (url === '/api/pay/swap/deposit') {
      told.push(JSON.parse(String(init?.body)));
      return Response.json({ told: true });
    }
    return new Response('{}', { status: 404 });
  });
}

const progress = (p: Partial<SwapProgress>): SwapProgress => ({
  stage: 'waiting',
  status: 'PENDING_DEPOSIT',
  correlationId: 'c0ffee00',
  updatedAt: '',
  deposited: null,
  amountOut: null,
  refunded: null,
  refundReason: null,
  txs: [],
  landed: null,
  ...p,
});

/** An EVM wallet that announces itself (EIP-6963) and answers as MetaMask would, starting on Ethereum. */
const wallet = {
  chain: '0x1',
  sent: [] as unknown[],
  async request({ method, params }: { method: string; params?: unknown }) {
    const p = params as Record<string, string>[];
    switch (method) {
      case 'eth_requestAccounts':
        return [FROM];
      case 'eth_chainId':
        return wallet.chain;
      case 'wallet_switchEthereumChain':
        wallet.chain = p[0]!.chainId!;
        return null;
      case 'eth_call':
        if (p[0]!.data === '0x313ce567') return `0x${(6).toString(16).padStart(64, '0')}`;
        return `0x${(10n ** 12n).toString(16).padStart(64, '0')}`;
      case 'eth_sendTransaction':
        wallet.sent.push(p[0]);
        return `0x${'ab'.repeat(32)}`;
      default:
        throw new Error(`unexpected ${method}`);
    }
  },
};
window.addEventListener('eip6963:requestProvider', () =>
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'u', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>', rdns: 'io.metamask' }, provider: wallet } }),
  ),
);

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 60))));

async function until(check: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`not met in ${ms} ms; page says: ${box.textContent?.slice(0, 600)}`);
    await settle();
  }
}

async function open() {
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  await act(async () => root!.render(<Swap />));
  await until(() => /You pay/i.test(text()) && /Fee 0\.25%/.test(text()));
}

const text = () => box.textContent ?? '';
const field = (placeholder: string) => box.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
const button = (name: string | RegExp) =>
  [...box.querySelectorAll('button')].find((b) => (typeof name === 'string' ? b.textContent?.trim() === name || b.getAttribute('aria-label') === name : name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))) ?? null;
const radio = (name: string) => [...box.querySelectorAll('[role="radio"]')].find((b) => b.textContent?.trim() === name) as HTMLButtonElement | undefined;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Picks a coin in the picker the coin button opens. */
async function pickCoin(side: RegExp, search: string, row: RegExp) {
  await act(async () => button(side)!.click());
  await until(() => document.querySelector('[role="dialog"]') !== null);
  await type(document.querySelector<HTMLInputElement>('[role="dialog"] input')!, search);
  const hit = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] li button')].find((b) => row.test(b.textContent ?? ''));
  if (!hit) throw new Error(`no row ${row} in ${document.querySelector('[role="dialog"]')?.textContent}`);
  await act(async () => hit.click());
  await until(() => document.querySelector('[role="dialog"]') === null);
}

beforeEach(() => {
  localStorage.clear();
  asked = [];
  told = [];
  statuses = [];
  bend = null;
  nearSent.length = 0;
  nearWallet.timeout = false;
  wallet.chain = '0x1';
  wallet.sent = [];
  api();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  box?.remove();
  vi.unstubAllGlobals();
});

describe('paying from a wallet in this browser', () => {
  it('quotes with the wallet as the refund, then pays exactly the quote from it', async () => {
    await open();
    expect(text()).toMatch(/1 USDT ≈/);
    await until(() => radio('MetaMask')?.getAttribute('aria-checked') === 'true');
    await type(field('Solana address'), SOL_WALLET);
    await until(() => /A Solana wallet\./.test(text()));
    expect(text()).toMatch(/If it fails, it goes back to that wallet\./);
    await act(async () => button('Swap')!.click());
    await until(() => /Sent from MetaMask\./.test(text()));
    const real = asked.filter((a) => !a.dry);
    expect(real).toEqual([{ from: coin('arb', 'USDT').assetId, to: coin('sol', 'SOL').assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, payer: FROM }]);
    expect(wallet.chain).toBe('0xa4b1');
    expect(wallet.sent).toEqual([
      // Bound to Arbitrum: the wallet refuses to send it on any other network.
      { from: FROM, to: coin('arb', 'USDT').contract, data: `0xa9059cbb000000000000000000000000${EVM_DEPOSIT.slice(2)}${(25_000_000).toString(16).padStart(64, '0')}`, value: '0x0', chainId: '0xa4b1' },
    ]);
    expect(told).toEqual([{ address: EVM_DEPOSIT, txHash: `0x${'ab'.repeat(32)}` }]);
    const saved = JSON.parse(localStorage.getItem('maskwars:swap')!);
    expect(saved.refund).toEqual({ to: FROM, type: 'ORIGIN_CHAIN' });
    expect(saved.paid.by).toBe('MetaMask');
  });

  it('refuses a receiver of another network, naming it, before anything is asked', async () => {
    await open();
    await type(field('Solana address'), FROM);
    await until(() => /That is an Ethereum address\. This needs one on Solana\./.test(text()));
    expect(button('Swap')!.disabled).toBe(true);
    expect(asked.filter((a) => !a.dry)).toEqual([]);
  });
});

describe('paying from an exchange', () => {
  it('asks for a refund address on the paying network, read with certainty, then gives the deposit address', async () => {
    await open();
    await until(() => radio('Exchange') !== undefined);
    await act(async () => radio('Exchange')!.click());
    await type(field('Solana address'), SOL_WALLET);
    await until(() => /A Solana wallet\./.test(text()));
    // Nothing typed yet: the refund field is where the person is sent.
    await act(async () => button('Get deposit address')!.click());
    await until(() => document.activeElement === field('0x…'));
    expect(asked.filter((a) => !a.dry)).toEqual([]);
    await type(field('0x…'), 'kira.near');
    await until(() => /That is a NEAR address\. This needs one on Arbitrum\./.test(text()));
    await type(field('0x…'), '0x71C7656EC7ab88b098defB751B7401B5f6d8976f');
    await until(() => /One character is off\./.test(text()));
    await type(field('0x…'), '0x71C7656EC7ab88b098defB751B7401B5f6d8976F');
    await until(() => /A refund comes back here, on Arbitrum\./.test(text()));
    await act(async () => button('Get deposit address')!.click());
    await until(() => button('Copy address') !== null);
    expect(asked.filter((a) => !a.dry)).toEqual([
      { from: coin('arb', 'USDT').assetId, to: coin('sol', 'SOL').assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, refund: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F' },
    ]);
    expect(text()).toContain(EVM_DEPOSIT);
    expect(text()).not.toMatch(/for you/);
  });

  it('to NEAR: the refund waits for the receiving account inside NEAR Intents, said by name, unless changed', async () => {
    await open();
    await pickCoin(/^Receive /, 'usdc', /^USDC\s*NEAR/);
    await act(async () => radio('Exchange')!.click());
    await type(field('your-name.near'), 'MaskWars.near');
    await until(() => /On NEAR\. Your own wallet, not an exchange\./.test(text()));
    expect(text()).toMatch(/Refund: maskwars\.near, inside NEAR Intents/);
    await act(async () => button('Get deposit address')!.click());
    await until(() => button('Copy address') !== null);
    const real = asked.filter((a) => !a.dry);
    expect(real).toEqual([{ from: coin('arb', 'USDT').assetId, to: coin('near', 'USDC').assetId, amount: '25000000', dry: false, recipient: 'maskwars.near' }]);
    expect(JSON.parse(localStorage.getItem('maskwars:swap')!).refund).toEqual({ to: 'maskwars.near', type: 'INTENTS' });
  });

  it('to NEAR for someone else: the refund address on the paying network instead', async () => {
    await open();
    await pickCoin(/^Receive /, 'usdc', /^USDC\s*NEAR/);
    await act(async () => radio('Exchange')!.click());
    await type(field('your-name.near'), 'maskwars.near');
    await until(() => /Refund: maskwars\.near/.test(text()));
    await act(async () => button('Change')!.click());
    await type(field('0x…'), '0x71c7656ec7ab88b098defb751b7401b5f6d8976f');
    await until(() => /A refund comes back here, on Arbitrum\./.test(text()) && /On NEAR\. Your own wallet/.test(text()));
    await act(async () => button('Get deposit address')!.click());
    await until(() => button('Copy address') !== null);
    expect(asked.filter((a) => !a.dry)[0]).toMatchObject({ recipient: 'maskwars.near', refund: '0x71c7656ec7ab88b098defb751b7401b5f6d8976f' });
  });

  it('gives no address for a quote that does not read back as asked', async () => {
    bend = (q) => ({ ...q, recipient: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' });
    await open();
    await act(async () => radio('Exchange')!.click());
    await type(field('Solana address'), SOL_WALLET);
    await type(field('0x…'), FROM);
    await until(() => /A refund comes back here/.test(text()));
    await act(async () => button('Get deposit address')!.click());
    await until(() => /That quote did not read right\. Nothing to send\./.test(text()));
    expect(button('Copy address')).toBeNull();
    expect(localStorage.getItem('maskwars:swap')).toBeNull();
  });
});

describe('a coin on NEAR', () => {
  it('is paid from the NEAR wallet only, in one transaction that registers the deposit account and sends the coin', async () => {
    await open();
    await pickCoin(/^Pay /, 'usdt', /^USDT\s*NEAR/);
    await until(() => radio('NEAR wallet')?.getAttribute('aria-checked') === 'true');
    expect(radio('Exchange')).toBeUndefined();
    await type(field('Solana address'), SOL_WALLET);
    await until(() => /A Solana wallet\./.test(text()));
    await act(async () => button('Swap')!.click());
    await until(() => /Sent from NEAR wallet\./.test(text()));
    expect(asked.filter((a) => !a.dry)[0]).toMatchObject({ from: coin('near', 'USDT').assetId, payer: 'kira.near' });
    expect(nearSent).toEqual([
      [
        {
          receiverId: 'usdt.tether-token.near',
          actions: [
            { type: 'FunctionCall', params: { methodName: 'storage_deposit', args: { account_id: NEAR_DEPOSIT, registration_only: true }, gas: '10000000000000', deposit: '1250000000000000000000' } },
            { type: 'FunctionCall', params: { methodName: 'ft_transfer', args: { receiver_id: NEAR_DEPOSIT, amount: '25000000' }, gas: '30000000000000', deposit: '1' } },
          ],
        },
      ],
    ]);
    expect(told).toEqual([{ address: NEAR_DEPOSIT, txHash: 'HYZ4ycqXgR4yEMhfsYgvkZjiU5V6YtbW2D5vhNVF2wWy', nearSender: 'kira.near' }]);
    // No deposit address on the card: an exchange could send native NEAR to it, which would not count.
    expect(text()).not.toContain(NEAR_DEPOSIT);
  });
});

describe('a wallet that answers unclearly or from another account', () => {
  it('never pays from an account other than the one the refund was quoted to', async () => {
    const other = '0x2222222222222222222222222222222222222222';
    localStorage.setItem(
      'maskwars:swap',
      JSON.stringify({
        from: { chain: { id: 'arb', name: 'Arbitrum' }, coin: coin('arb', 'USDT') },
        to: { chain: { id: 'sol', name: 'Solana' }, coin: coin('sol', 'SOL') },
        recipient: SOL_WALLET,
        refund: { to: other, type: 'ORIGIN_CHAIN' },
        payment: { by: 'wallet', wallet: 'MetaMask', walletId: 'evm:io.metamask', address: other },
        quote: quoteFor({ from: coin('arb', 'USDT').assetId, to: coin('sol', 'SOL').assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, payer: other }),
      }),
    );
    box = document.createElement('div');
    document.body.append(box);
    root = createRoot(box);
    await act(async () => root!.render(<Swap />));
    await until(() => button('Pay with MetaMask') !== null);
    await act(async () => button('Pay with MetaMask')!.click());
    await until(() => /MetaMask is on another account\. Switch it to 0x2222…2222: the refund goes there\./.test(text()));
    expect(wallet.sent).toEqual([]);
    expect(told).toEqual([]);
  });

  it('after a NEAR wallet that gave no clear answer, says to check it before paying again', async () => {
    nearWallet.timeout = true;
    await open();
    await pickCoin(/^Pay /, 'usdt', /^USDT\s*NEAR/);
    await type(field('Solana address'), SOL_WALLET);
    await until(() => /A Solana wallet\./.test(text()));
    await act(async () => button('Swap')!.click());
    await until(() => /did not say whether it sent\. Check it before paying again/.test(text()));
    expect(JSON.parse(localStorage.getItem('maskwars:swap')!).paid).toBeUndefined();
  });
});

describe('a deposit that comes in short', () => {
  /** A swap paid from MetaMask whose deposit came in short. */
  function shortSwap() {
    localStorage.setItem(
      'maskwars:swap',
      JSON.stringify({
        from: { chain: { id: 'arb', name: 'Arbitrum' }, coin: coin('arb', 'USDT') },
        to: { chain: { id: 'sol', name: 'Solana' }, coin: coin('sol', 'SOL') },
        recipient: SOL_WALLET,
        refund: { to: FROM, type: 'ORIGIN_CHAIN' },
        payment: { by: 'wallet', wallet: 'MetaMask', walletId: 'evm:io.metamask', address: FROM },
        quote: quoteFor({ from: coin('arb', 'USDT').assetId, to: coin('sol', 'SOL').assetId, amount: '25000000', dry: false, recipient: SOL_WALLET, payer: FROM }),
      }),
    );
  }

  async function render() {
    box = document.createElement('div');
    document.body.append(box);
    root = createRoot(box);
    await act(async () => root!.render(<Swap />));
  }

  it('asks the wallet for the rest only, never the whole amount again', async () => {
    shortSwap();
    statuses = [progress({ stage: 'short', status: 'INCOMPLETE_DEPOSIT', deposited: '24500000' })];
    await render();
    await until(() => /Send 0\.5 USDT more by/.test(text()) && button('Pay with MetaMask') !== null);
    expect(text()).toMatch(/Send the rest/);
    expect(text()).not.toMatch(/\b25 USDT/);
    await act(async () => button('Pay with MetaMask')!.click());
    await until(() => wallet.sent.length === 1);
    expect((wallet.sent[0] as { data: string }).data.slice(-64)).toBe((500_000).toString(16).padStart(64, '0'));
  });

  it('after a wallet payment that came in short, shows the address again with the rest and pays only the rest', async () => {
    shortSwap();
    const saved = JSON.parse(localStorage.getItem('maskwars:swap')!);
    localStorage.setItem('maskwars:swap', JSON.stringify({ ...saved, paid: { by: 'MetaMask', tx: `0x${'ab'.repeat(32)}`, link: null } }));
    statuses = [progress({ stage: 'short', status: 'INCOMPLETE_DEPOSIT', deposited: '24500000' })];
    await render();
    await until(() => /Send 0\.5 USDT more by/.test(text()) && button('Pay with MetaMask') !== null);
    expect(text()).toContain(EVM_DEPOSIT);
    expect(button('Copy the amount, 0.5 USDT')).not.toBeNull();
    await act(async () => button('Pay with MetaMask')!.click());
    await until(() => wallet.sent.length === 1);
    expect((wallet.sent[0] as { data: string }).data.slice(-64)).toBe((500_000).toString(16).padStart(64, '0'));
  });

  it('shows no number and no wallet button while 1Click has not said how much came', async () => {
    shortSwap();
    statuses = [progress({ stage: 'short', status: 'INCOMPLETE_DEPOSIT', deposited: null })];
    await render();
    await until(() => /How much is not known yet: wait a moment before sending more\./.test(text()));
    expect(text()).toMatch(/Part arrived/);
    expect(text()).toMatch(/Checking the amount/);
    expect(button('Pay with MetaMask')).toBeNull();
    expect(text()).not.toMatch(/\b25 USDT/);
    expect(text()).not.toMatch(/for you/);
  });
});

describe('Tron', () => {
  it('pays only by the deposit address: no wallet is offered, as on Get NEAR', async () => {
    (window as unknown as { tronLink: unknown; tronWeb: unknown }).tronLink = { request: async () => null };
    (window as unknown as { tronWeb: unknown }).tronWeb = { defaultAddress: { base58: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7' } };
    await open();
    await pickCoin(/^Pay /, 'tron', /^USDT\s*Tron/);
    await until(() => /Pay USDT on Tron/.test(button(/^Pay /)!.getAttribute('aria-label')!));
    expect([...box.querySelectorAll('[role="radio"]')].map((r) => r.textContent?.trim())).toEqual(['Exchange']);
    delete (window as unknown as { tronLink?: unknown }).tronLink;
    delete (window as unknown as { tronWeb?: unknown }).tronWeb;
  });
});

describe('a deposit address waiting for the coin', () => {
  it('lights nothing before anything is sent, and asks once more before starting over', async () => {
    await open();
    await act(async () => radio('Exchange')!.click());
    await type(field('Solana address'), SOL_WALLET);
    await type(field('0x…'), FROM);
    await until(() => /A refund comes back here/.test(text()));
    await act(async () => button('Get deposit address')!.click());
    await until(() => button('Copy address') !== null);
    expect(box.querySelectorAll('li[data-now], li[data-done]')).toHaveLength(0);
    await act(async () => button('Change')!.click());
    await until(() => /Anything already sent still lands, or goes back to 0x1111…1111 on Arbitrum\. Start over\?/.test(text()));
    expect(localStorage.getItem('maskwars:swap')).not.toBeNull();
    await act(async () => button('Start over')!.click());
    await until(() => button('Get deposit address') !== null);
    expect(localStorage.getItem('maskwars:swap')).toBeNull();
  });
});

describe('the turn-around', () => {
  it('pays what was received at the same dollars, and cannot pay out where no address is read', async () => {
    await open();
    await act(async () => button('Turn the swap around')!.click());
    await until(() => /Pay SOL on Solana/.test(button(/^Pay /)!.getAttribute('aria-label')!) && /Receive USDT on Arbitrum/.test(button(/^Receive /)!.getAttribute('aria-label')!));
    await pickCoin(/^Pay /, 'ton', /^USDT\s*TON/);
    expect(button('Turn the swap around')!.disabled).toBe(true);
  });

  it('lands with a link to the payout on its own network', async () => {
    statuses = [progress({ stage: 'done', status: 'SUCCESS', amountOut: '293400000', landed: { hash: 'x'.repeat(88), link: 'https://solscan.io/tx/abc' } })];
    await open();
    await type(field('Solana address'), SOL_WALLET);
    await until(() => /A Solana wallet\./.test(text()));
    await act(async () => button('Swap')!.click());
    await until(() => /landed in/.test(text()));
    expect(text()).toMatch(/Done\. 0\.2934 SOL landed in 7v54NW…VFi9 on Solana\./);
    expect(box.querySelector('a[href="https://solscan.io/tx/abc"]')?.textContent).toMatch(/View on Solana/i);
    expect(localStorage.getItem('maskwars:swap')).toBeNull();
  });
});
