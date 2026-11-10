// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://maskwars.xyz/hire/embed"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proofEnvelope, type VaultProof } from '@maskwars/hire';
import { Checkout, type Given } from './Checkout';

// The checkout as a host page's frame runs it, with the site's API answered here and every call to it counted: what
// leaves the frame, and when, is the whole point of these tests.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/components/Mark', () => ({ Mark: () => null }));

const VAULT = '0x3602b546589a8fcafdce7fad64a46f91db0e4d50';
const coin = (symbol: string, assetId: string, decimals: number, price: number) => ({ chain: 'sol', symbol, assetId, decimals, price });
const catalog = () => ({
  live: true,
  fee: 0,
  near: { chain: 'near', symbol: 'NEAR', assetId: 'nep141:wrap.near', decimals: 24, price: 3.7 },
  chains: [{ id: 'sol', name: 'Solana', window: 30, coins: [coin('USDC', 'nep141:sol-usdc.omft.near', 6, 1), coin('SOL', 'nep141:sol.omft.near', 9, 160)] }],
});
const preview = {
  correlationId: 'p',
  dry: true,
  depositAddress: null,
  depositMemo: null,
  originAsset: 'x',
  destinationAsset: 'nep141:wrap.near',
  recipient: null,
  recipientType: 'INTENTS',
  refundTo: null,
  refundType: 'INTENTS',
  amountIn: '250000000',
  minAmountIn: '250000000',
  amountOut: '67330000000000000000000000',
  minAmountOut: '66650000000000000000000000',
  deadline: '2026-11-09T13:00:00Z',
  closes: '2026-11-09T13:00:00Z',
  timeEstimate: 20,
};

let calls: string[] = [];
let root: Root;
let box: HTMLElement;
let opened: string | null = null;
const popup = { closed: false, focus: () => {} };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
  calls = [];
  opened = null;
  // A frame: the page around it is someone else's.
  Object.defineProperty(window, 'top', { value: {}, configurable: true });
  Object.defineProperty(window, 'parent', { value: { postMessage: () => {} }, configurable: true });
  vi.stubGlobal('fetch', async (input: string) => {
    const path = new URL(input, 'https://maskwars.xyz').pathname;
    calls.push(path);
    if (path === '/api/hire/catalog') return Response.json(catalog());
    if (path === '/api/hire/preview') return Response.json({ quote: preview });
    return Response.json({ proof: null });
  });
  window.open = ((url: string) => {
    opened = url;
    return popup;
  }) as typeof window.open;
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});

afterEach(() => {
  act(() => root.unmount());
  box.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const given: Given = {
  text: 'Break our lending vault before mainnet',
  target: 'vault.northwind-lend.testnet',
  team: VAULT,
  amount: { usd: 250 },
  chain: 'sol',
};
const later = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const button = (name: string) => [...box.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const touch = () =>
  act(() => {
    const e = new Event('pointerdown');
    // What a person's finger is and a page's script never is.
    Object.defineProperty(e, 'isTrusted', { value: true });
    window.dispatchEvent(e);
  });
const click = (name: string) => act(() => button(name)!.click());

/** The vault window's answer, as it arrives from the window this checkout opened. */
function proved() {
  const relay = new URLSearchParams(opened!.split('#')[1]).get('r')!;
  const proof = {
    kind: 'passkey',
    ask: { text: given.text!, target: given.target!, page: null, at: new Date().toISOString().slice(0, 19) + 'Z' },
  } as VaultProof;
  return act(() =>
    window.dispatchEvent(new MessageEvent('message', { data: proofEnvelope(relay, proof, VAULT), origin: 'https://maskwars.xyz', source: popup as never })),
  );
}

describe('the checkout in its frame', () => {
  // The finding: opened by any page, unseen, it priced at 1Click and asked NEAR's RPC on its own, and again every minute.
  it('asks nothing of the site’s API until someone touches it: a page that opens it a thousand times spends nothing', async () => {
    act(() => root.render(<Checkout given={given} host="https://northwind.example" />));
    await later(5_000);
    expect(box.textContent).toContain('Show it is yours.');
    expect(calls).toEqual([]);
    // A page's own script cannot touch the frame: an event it could make is not a touch.
    act(() => void window.dispatchEvent(new Event('pointerdown')));
    await later(2_000);
    expect(calls).toEqual([]);
    await touch();
    await later(500);
    expect(calls).toEqual(['/api/hire/catalog']);
  });

  it('prices once for a coin and amount, again only when one of them changes, and never on a clock', async () => {
    act(() => root.render(<Checkout given={given} host="https://northwind.example" />));
    await later(100);
    await touch();
    await click('Open your vault');
    expect(opened).toMatch(/^\/hire\/prove#r=[0-9a-f]{64}&/);
    await proved();
    await later(100);
    // The page named the network: the payer goes straight to the coin.
    expect(box.textContent).toContain('USDC on Solana.');
    await click('Next');
    await later(1_000);
    expect(calls.filter((c) => c === '/api/hire/preview')).toHaveLength(1);
    expect(box.textContent).toContain('≈ 67.33 NEAR lands in');
    // Three minutes on the amount: no new price, no new coin list.
    await later(180_000);
    expect(calls.filter((c) => c === '/api/hire/preview')).toHaveLength(1);
    expect(calls.filter((c) => c === '/api/hire/catalog')).toHaveLength(1);
    await click('$500');
    await later(1_000);
    expect(calls.filter((c) => c === '/api/hire/preview')).toHaveLength(2);
  });

  it('takes the vault window’s answer only from the window it opened, on this site, for its own relay', async () => {
    act(() => root.render(<Checkout given={given} host="https://northwind.example" />));
    await touch();
    await click('Open your vault');
    const relay = new URLSearchParams(opened!.split('#')[1]).get('r')!;
    const proof = { kind: 'passkey', ask: { text: given.text!, target: given.target!, page: null, at: '2026-11-09T12:00:00Z' } } as VaultProof;
    const send = (o: { origin?: string; source?: unknown; relay?: string }) =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: proofEnvelope(o.relay ?? relay, proof, VAULT),
            origin: o.origin ?? 'https://maskwars.xyz',
            source: (o.source ?? popup) as never,
          }),
        ),
      );
    // The host page, another site, another relay: all ignored.
    await send({ source: window.parent });
    await send({ origin: 'https://northwind.example' });
    await send({ relay: 'f'.repeat(64) });
    await later(100);
    expect(box.textContent).toContain('Waiting for your vault');
  });

  it('refuses the window’s answer for a vault other than the one the page named', async () => {
    act(() => root.render(<Checkout given={{ ...given, team: 'northwind-lend.near' }} host="https://northwind.example" />));
    await touch();
    await click('Open your vault');
    await proved();
    expect(box.textContent).toContain('This job pays into northwind-lend.near’s.');
    expect(box.textContent).not.toContain('USDC on Solana.');
  });

  it('names whose words the job is, and says plainly the money is not paid to MASK WARS', async () => {
    Object.defineProperty(document, 'referrer', { value: 'https://northwind.example/launch', configurable: true });
    act(() => root.render(<Checkout given={given} host="https://evil.example" />));
    await later(100);
    // The page as the browser names it, not as the URL claims.
    expect(box.textContent).toContain('Bynorthwind.example');
    expect(box.textContent).toContain('0x3602b5…0e4d50’s vault, not\u00a0MASK\u00a0WARS');
  });
});

describe('the checkout on its own', () => {
  it('draws nothing and leaves for /hire: a link cannot dress it up as maskwars.xyz asking for money', async () => {
    Object.defineProperty(window, 'top', { value: window, configurable: true });
    const replace = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, replace, origin: 'https://maskwars.xyz' }, configurable: true });
    act(() => root.render(<Checkout given={{ ...given, team: 'attacker.near', amount: { usd: 500 } }} host={null} />));
    await later(100);
    expect(replace).toHaveBeenCalledWith('/hire');
    expect(box.textContent).toBe('');
    expect(calls).toEqual([]);
  });
});
