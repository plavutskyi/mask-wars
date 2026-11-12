// @vitest-environment happy-dom
// The page itself, against /api/pay/near in memory: the coin a first visit starts from, who receives when a link names
// someone, a deposit that comes in short and is then topped up, paying from an EVM wallet in the browser, and the
// receiver from the person's NEAR wallet.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nearCatalogOf, type NearProgress, type NearQuoteView, type Token } from '@maskwars/pay';
import type { PendingNear } from './flow';
import { GetNear } from './GetNear';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/link', () => ({ default: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) => <a href={href} className={className}>{children}</a> }));
vi.mock('../wallet/near', () => ({ nearSignIn: async () => ({ accountId: 'mine.near' }) }));

import fixture from '@maskwars/pay/fixtures/tokens.json';

const tokens = fixture.tokens as Token[];
const catalog = nearCatalogOf(tokens)!;
const usdc = catalog.chains.find((c) => c.id === 'arb')!.coins.find((c) => c.symbol === 'USDC')!;
const usdt = catalog.chains.find((c) => c.id === 'arb')!.coins.find((c) => c.symbol === 'USDT')!;

const preview: NearQuoteView = {
  correlationId: 'p',
  dry: true,
  depositAddress: null,
  depositMemo: null,
  originAsset: usdt.assetId,
  destinationAsset: 'nep141:wrap.near',
  recipient: null,
  recipientType: 'DESTINATION_CHAIN',
  refundTo: null,
  refundType: 'INTENTS',
  amountIn: '25000000',
  minAmountIn: '24750000',
  amountOut: '6710000000000000000000000',
  minAmountOut: '6640000000000000000000000',
  deadline: new Date(Date.now() + 3_600_000).toISOString(),
  closes: new Date(Date.now() + 4 * 86_400_000).toISOString(),
  timeEstimate: 25,
  fees: [{ recipient: 'maskwars.near', fee: 13 }, { recipient: '5880ad2b', fee: 20 }],
};

const progress = (p: Partial<NearProgress>): NearProgress => ({
  stage: 'waiting',
  status: 'PENDING_DEPOSIT',
  correlationId: 'aa39ab52',
  updatedAt: '',
  deposited: null,
  amountOut: null,
  refunded: null,
  refundReason: null,
  txs: [],
  landedTx: null,
  ...p,
});

let statuses: NearProgress[] = [];
let asked: { from: string; usd: number; dry: boolean }[] = [];
let told: unknown[] = [];
let root: Root | null = null;
let box: HTMLDivElement;

function api() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/pay/near') return Response.json({ live: true, maxUsd: 100, fee: { recipient: 'maskwars.near', fee: 25 }, near: catalog.near, chains: catalog.chains });
    if (url.startsWith('/api/pay/near/account')) {
      const id = new URL(url, 'https://maskwars.xyz').searchParams.get('id')!;
      return Response.json({ ok: true, id, kind: 'named', exists: true });
    }
    if (url === '/api/pay/near/quote') {
      const b = JSON.parse(String(init?.body)) as { from: string; usd: number; dry: boolean };
      asked.push(b);
      return Response.json({ quote: { ...preview, originAsset: b.from } });
    }
    if (url.startsWith('/api/pay/near/status')) return Response.json(statuses.length > 1 ? statuses.shift() : statuses[0]);
    if (url === '/api/pay/near/deposit') {
      told.push(JSON.parse(String(init?.body)));
      return Response.json({ told: true });
    }
    return new Response('{}', { status: 404 });
  });
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 60))));

async function until(check: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`not met in ${ms} ms; page says: ${box.textContent?.slice(0, 400)}`);
    await settle();
  }
}

async function open(url: string) {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  await act(async () => root!.render(<GetNear />));
}

const text = () => box.textContent ?? '';
const to = () => box.querySelector<HTMLInputElement>('input[placeholder="your-name.near"]')!;
const button = (name: string) => [...box.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) ?? null;

beforeEach(() => {
  localStorage.clear();
  statuses = [];
  asked = [];
  told = [];
  api();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  box?.remove();
  vi.unstubAllGlobals();
});

describe('a first visit', () => {
  it('starts from USDC on Arbitrum and asks its price', async () => {
    await open('https://maskwars.xyz/near');
    await until(() => asked.length > 0);
    expect(box.querySelector('button[id$="-coin"]')!.textContent).toMatch(/^USDC\s*Arbitrum$/);
    expect(asked[0]).toMatchObject({ from: usdc.assetId, dry: true });
  });

  it('comes back to the coin this browser used last, USDT on Arbitrum too', async () => {
    localStorage.setItem('maskwars:near:last', JSON.stringify({ from: usdt.assetId }));
    await open('https://maskwars.xyz/near');
    await until(() => asked.some((a) => a.from === usdt.assetId));
    expect(box.querySelector('button[id$="-coin"]')!.textContent).toMatch(/^USDT\s*Arbitrum$/);
  });
});

describe('a receiver a link names', () => {
  it('never replaces the account this browser used before', async () => {
    localStorage.setItem('maskwars:near:last', JSON.stringify({ to: 'mine.near' }));
    await open('https://maskwars.xyz/near?to=scam.near');
    await until(() => to()?.value === 'mine.near' && /On NEAR\./.test(text()));
    expect(text()).not.toMatch(/From a link/);
    expect(text()).not.toMatch(/scam\.near/);
  });

  it('is marked as from the link and gives no address until the person says it is theirs', async () => {
    await open('https://maskwars.xyz/near?to=scam.near');
    await until(() => to()?.value === 'scam.near' && /From a link\. Check it is your own account\./.test(text()) && /0\.33%/.test(text()));
    expect(button('Get NEAR')!.disabled).toBe(true);
    expect(text()).not.toMatch(/Your own wallet, not an exchange/);
    await act(async () => button('It is mine')!.click());
    await until(() => /On NEAR\. Your own wallet, not an exchange\./.test(text()));
    expect(button('Get NEAR')!.disabled).toBe(false);
  });

  it('counts as the person’s own once they type over it', async () => {
    await open('https://maskwars.xyz/near?to=scam.near');
    await until(() => /From a link/.test(text()));
    const input = to();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'mine.near');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await until(() => /On NEAR\. Your own wallet/.test(text()));
    expect(text()).not.toMatch(/From a link/);
  });
});

describe('a deposit that comes in short', () => {
  it('keeps the address, the clock and the polling, and lands once the rest arrives', async () => {
    const pending: PendingNear = {
      recipient: 'maskwars.near',
      chain: { id: 'arb', name: 'Arbitrum' },
      coin: usdt,
      usd: 10,
      quote: {
        ...preview,
        dry: false,
        correlationId: 'aa39ab52-6158',
        depositAddress: '0x9d366cbb21925d26e60b58124f3dba9474b208b8',
        recipient: 'maskwars.near',
        refundTo: 'maskwars.near',
        amountIn: '10000000',
        minAmountIn: '9900000',
        amountOut: '2680000000000000000000000',
        minAmountOut: '2650000000000000000000000',
      },
    };
    localStorage.setItem('maskwars:near', JSON.stringify(pending));
    // Binance took its fee out of the 10: 9.80 arrived. Then the person sends the rest and the swap lands.
    statuses = [
      progress({ stage: 'short', status: 'INCOMPLETE_DEPOSIT', deposited: '9800000' }),
      progress({ stage: 'done', status: 'SUCCESS', deposited: '10000000', amountOut: '2680000000000000000000000', landedTx: 'HYZ4ycqXcvWsdfK95qmHE17TBGQz5SP1YzfqXaj8JJvJ' }),
    ];
    await open('https://maskwars.xyz/near');
    await until(() => /Send 0\.2 USDT more by/.test(text()));
    // Only the rest on the card: nobody sends the whole 10 twice.
    expect(text()).toMatch(/0\.2 USDT/);
    expect(text()).toMatch(/More, only USDT on Arbitrum/);
    expect(text()).not.toMatch(/\b10 USDT/);
    expect(text()).toMatch(/Send the rest/);
    expect(text()).toMatch(/Waiting for the rest/);
    expect(button('Copy address')).not.toBeNull();
    expect(text()).toMatch(/0x9d366cbb21925d26e60b58124f3dba9474b208b8/);
    expect(text()).toMatch(/\d+:\d{2}/);
    // Still remembered: a reload comes back to the same address.
    expect(localStorage.getItem('maskwars:near')).not.toBeNull();
    expect(text()).not.toMatch(/for you/);

    await until(() => /Done\. The arena is waiting\./.test(text()), 9000);
    expect(text()).toMatch(/Landed/i);
    expect(localStorage.getItem('maskwars:near')).toBeNull();
  }, 15_000);
});

// ---- Paying from a wallet in this browser ----

const DEPOSIT = '0x9d366cbb21925d26e60b58124f3dba9474b208b8';
const FROM = '0x1111111111111111111111111111111111111111';

/** An EVM wallet that announces itself (EIP-6963) and answers as MetaMask would, starting on Ethereum. */
const wallet = {
  chain: '0x1',
  balance: 50_000_000n,
  refuse: false,
  sent: [] as { from: string; to: string; data?: string; value: string }[],
  calls: [] as string[],
  async request({ method, params }: { method: string; params?: unknown }) {
    wallet.calls.push(method);
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
        return `0x${wallet.balance.toString(16).padStart(64, '0')}`;
      case 'eth_sendTransaction':
        if (wallet.refuse) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        wallet.sent.push(p[0] as never);
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

function waitingFor(amountIn = '10000000') {
  const pending: PendingNear = {
    recipient: 'maskwars.near',
    chain: { id: 'arb', name: 'Arbitrum' },
    coin: usdt,
    usd: 10,
    quote: { ...preview, dry: false, correlationId: 'c0ffee00', depositAddress: DEPOSIT, recipient: 'maskwars.near', refundTo: 'maskwars.near', amountIn, minAmountIn: '9900000' },
  };
  localStorage.setItem('maskwars:near', JSON.stringify(pending));
  statuses = [progress({ stage: 'waiting', status: 'PENDING_DEPOSIT' })];
}

describe('paying from a wallet in this browser', () => {
  beforeEach(() => {
    wallet.chain = '0x1';
    wallet.balance = 50_000_000n;
    wallet.refuse = false;
    wallet.sent = [];
    wallet.calls = [];
  });

  it('switches the wallet to the network, checks the coin and the balance, and sends exactly the quote', async () => {
    waitingFor();
    await open('https://maskwars.xyz/near');
    await until(() => button('Pay with MetaMask') !== null);
    expect(button('Copy address')).not.toBeNull();
    await act(async () => button('Pay with MetaMask')!.click());
    await until(() => /Sent from MetaMask\./.test(text()));
    expect(wallet.chain).toBe('0xa4b1');
    // The network is read back after the switch and once more right before signing; the transaction names it.
    expect(wallet.calls).toEqual(['eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_call', 'eth_call', 'eth_chainId', 'eth_sendTransaction']);
    expect(wallet.sent).toEqual([
      { from: FROM, to: usdt.contract, data: `0xa9059cbb000000000000000000000000${DEPOSIT.slice(2)}${(10_000_000).toString(16).padStart(64, '0')}`, value: '0x0', chainId: '0xa4b1' },
    ]);
    // 1Click is told the transaction; a reload never offers to pay twice.
    expect(told).toEqual([{ address: DEPOSIT, txHash: `0x${'ab'.repeat(32)}` }]);
    expect(JSON.parse(localStorage.getItem('maskwars:near')!).paid).toEqual({ by: 'MetaMask', tx: `0x${'ab'.repeat(32)}`, link: `https://arbiscan.io/tx/0x${'ab'.repeat(32)}` });
    expect(button('Pay with MetaMask')).toBeNull();
    expect(text()).toMatch(/Waiting for Arbitrum to confirm it\./);
  });

  it('sends nothing when the wallet holds too little, and says how much it has', async () => {
    waitingFor();
    wallet.balance = 1_500_000n;
    await open('https://maskwars.xyz/near');
    await until(() => button('Pay with MetaMask') !== null);
    await act(async () => button('Pay with MetaMask')!.click());
    await until(() => /Not enough USDT on Arbitrum in this wallet \(1\.5\)/.test(text()));
    expect(wallet.sent).toEqual([]);
    expect(told).toEqual([]);
    expect(button('Pay with MetaMask')).not.toBeNull();
  });

  it('says a refusal in the wallet sent nothing', async () => {
    waitingFor();
    wallet.refuse = true;
    await open('https://maskwars.xyz/near');
    await until(() => button('Pay with MetaMask') !== null);
    await act(async () => button('Pay with MetaMask')!.click());
    await until(() => /Cancelled in the wallet\. Nothing was sent\./.test(text()));
    expect(JSON.parse(localStorage.getItem('maskwars:near')!).paid).toBeUndefined();
  });
});

describe('paying from a wallet after a short deposit', () => {
  beforeEach(() => {
    wallet.chain = '0xa4b1';
    wallet.balance = 50_000_000n;
    wallet.refuse = false;
    wallet.sent = [];
    wallet.calls = [];
  });

  it('asks the wallet for the rest only, never the whole amount again', async () => {
    waitingFor();
    statuses = [progress({ stage: 'short', status: 'INCOMPLETE_DEPOSIT', deposited: '9800000' })];
    await open('https://maskwars.xyz/near');
    await until(() => button('Pay with MetaMask') !== null && /Send 0\.2 USDT more by/.test(text()));
    await act(async () => button('Pay with MetaMask')!.click());
    await until(() => /Sent from MetaMask\./.test(text()));
    expect(wallet.sent).toHaveLength(1);
    expect(wallet.sent[0]!.data).toBe(`0xa9059cbb000000000000000000000000${DEPOSIT.slice(2)}${(200_000).toString(16).padStart(64, '0')}`);
  });

  it('offers no wallet payment and no number while 1Click has not said how much came', async () => {
    waitingFor();
    statuses = [progress({ stage: 'short', status: 'INCOMPLETE_DEPOSIT', deposited: null })];
    await open('https://maskwars.xyz/near');
    await until(() => /How much is not known yet/.test(text()));
    expect(button('Pay with MetaMask')).toBeNull();
    expect(text()).toMatch(/Part arrived/);
    expect(text()).toMatch(/Checking the amount/);
    expect(text()).not.toMatch(/\b10 USDT/);
    expect(button('Copy address')).not.toBeNull();
    expect(wallet.sent).toEqual([]);
  });
});

describe('the receiver from the person’s own NEAR wallet', () => {
  it('fills the account and counts it as theirs, even over a link’s', async () => {
    await open('https://maskwars.xyz/near?to=scam.near');
    await until(() => /From a link/.test(text()));
    await act(async () => button('Use my own NEAR wallet')!.click());
    await until(() => to()?.value === 'mine.near' && /On NEAR\. Your own wallet/.test(text()));
    expect(text()).not.toMatch(/From a link/);
  });
});
