import {
  addressKindOf,
  coinText,
  depositUnits,
  fromUnits,
  STABLE,
  toUnits,
  usdOf,
  type AddressWhy,
  type AppFee,
  type NearCoin,
  type Refund,
  type SwapChain,
  type SwapProgress,
  type SwapQuoteView,
} from '@maskwars/pay';
import { clockText, dollarsText, shortRest } from '../near/flow';

/** The page's side of /api/pay/swap: typed answers, and failures as short codes the page words itself. */

export type SwapProblem = 'small' | 'route' | 'closed' | 'busy' | 'bad' | 'account' | 'refund' | 'limit' | 'offline';

export class SwapError extends Error {
  readonly code: SwapProblem;
  /** The HTTP status, 0 when the server was not reached. */
  readonly status: number;
  /** The least the route takes, or the most a swap may bring, in dollars, when the server named it. */
  readonly min: number | null;
  readonly max: number | null;
  /** Why an address was refused, and which network it looks like. */
  readonly why: AddressWhy | 'missing' | null;
  readonly other: string | null;
  constructor(code: SwapProblem, status = 0, extra: { min?: unknown; max?: unknown; why?: unknown; other?: unknown } = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.min = typeof extra.min === 'number' && extra.min > 0 ? extra.min : null;
    this.max = typeof extra.max === 'number' && extra.max > 0 ? extra.max : null;
    this.why = typeof extra.why === 'string' ? (extra.why as AddressWhy) : null;
    this.other = typeof extra.other === 'string' ? extra.other : null;
  }
}

export interface SwapCatalogView {
  readonly live: boolean;
  readonly maxUsd: number;
  readonly fee: AppFee | null;
  readonly near: { readonly assetId: string; readonly decimals: number; readonly price: number };
  readonly chains: readonly SwapChain[];
}

async function call<T>(path: string, init?: { body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/pay/swap${path}`, {
      method: init?.body === undefined ? 'GET' : 'POST',
      headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init?.signal ? { signal: init.signal } : {}),
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new SwapError('offline');
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: SwapProblem }) | null;
  if (!res.ok || !json) throw new SwapError(json?.error ?? (res.status === 429 ? 'busy' : 'offline'), res.status, (json ?? {}) as Record<string, unknown>);
  return json;
}

export interface QuoteAsk {
  readonly from: string;
  readonly to: string;
  /** Units of the coin paid in. */
  readonly amount: string;
  readonly dry: boolean;
  readonly recipient?: string;
  /** The paying wallet's address: a refund goes back to it. */
  readonly payer?: string;
  /** A refund address on the paying network (or a NEAR account where the page reads no address of it). */
  readonly refund?: string;
}

export const swapApi = {
  catalog: () => call<SwapCatalogView>(''),
  quote: (b: QuoteAsk, signal?: AbortSignal) => call<{ quote: SwapQuoteView }>('/quote', { body: b, ...(signal ? { signal } : {}) }).then((r) => r.quote),
  status: (address: string, memo?: string | null) =>
    call<SwapProgress>(`/status?address=${encodeURIComponent(address)}${memo ? `&memo=${encodeURIComponent(memo)}` : ''}`),
  near: (o: { asset: string; deposit: string; payer: string }) =>
    call<{ depositStorage: string; payerStorage: string; balance: string; near: string }>(
      `/near?asset=${encodeURIComponent(o.asset)}&deposit=${encodeURIComponent(o.deposit)}&payer=${encodeURIComponent(o.payer)}`,
    ),
};

/** Tells 1Click the transaction a wallet in this browser sent, so the swap starts as soon as it is confirmed. */
export function tellSwapDeposit(o: { address: string; txHash: string; memo?: string | null; nearSender?: string }): void {
  void fetch('/api/pay/swap/deposit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: o.address, txHash: o.txHash, ...(o.memo ? { memo: o.memo } : {}), ...(o.nearSender ? { nearSender: o.nearSender } : {}) }),
  }).catch(() => {});
}

// ---- What this browser remembers ----

export interface Side {
  readonly chain: { readonly id: string; readonly name: string };
  readonly coin: NearCoin;
}

/** How the swap is paid: a wallet in this browser (its name and address), or the deposit address. */
export type Payment = { readonly by: 'wallet'; readonly wallet: string; readonly walletId: string; readonly address: string } | { readonly by: 'address' };

/** A swap whose deposit address is out: the page comes back to it after a reload until it ends. Nothing secret. */
export interface PendingSwap {
  readonly from: Side;
  readonly to: Side;
  readonly recipient: string;
  readonly refund: Refund;
  readonly payment: Payment;
  readonly quote: SwapQuoteView;
  /** Sent from a wallet in this browser: which one and the transaction, so a reload never offers to pay twice. */
  readonly paid?: { readonly by: string; readonly tx: string; readonly link: string | null };
}

const PENDING = 'maskwars:swap';
const LAST = 'maskwars:swap:last';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the page works, it just forgets on reload */
  }
}

/** The swap still open, if its deposit address has not been closed for three days already. */
export function loadPendingSwap(now = Date.now()): PendingSwap | null {
  const p = read<PendingSwap>(PENDING);
  if (!p?.quote?.depositAddress || typeof p.recipient !== 'string' || !p.from?.coin || !p.to?.coin || !p.refund) return null;
  if (Date.parse(p.quote.closes) < now) {
    write(PENDING, null);
    return null;
  }
  return p;
}

export const savePendingSwap = (p: PendingSwap | null) => write(PENDING, p);

/** Forgets the swap at `address`, and only it: a swap another tab opened since stays remembered. */
export function clearPendingSwap(address: string | null): void {
  const p = read<PendingSwap>(PENDING);
  if (!p || !address || p.quote?.depositAddress === address) write(PENDING, null);
}

/** The last pair, amount and addresses used here, to start from next time. */
export interface LastSwap {
  readonly from?: string;
  readonly to?: string;
  readonly usd?: number;
  /** The last receiver, by the network it is on. */
  readonly receivers?: Readonly<Record<string, string>>;
}

export const loadLastSwap = (): LastSwap => read<LastSwap>(LAST) ?? {};
export const saveLastSwap = (p: LastSwap) => {
  const last = loadLastSwap();
  write(LAST, { ...last, ...p, receivers: { ...(last.receivers ?? {}), ...(p.receivers ?? {}) } });
};

// ---- Amounts ----

/** What a person typed as an amount of `coin`, in its units: `null` for anything that is not one. */
export function amountUnits(text: string, coin: Pick<NearCoin, 'decimals'>): bigint | null {
  const u = toUnits(text, coin.decimals);
  return u !== null && u > 0n ? u : null;
}

/** `usd` dollars of `coin`, as a person would type it: exactly the dollars for a stablecoin, four significant digits else. */
export function amountText(usd: number, coin: Pick<NearCoin, 'symbol' | 'price' | 'decimals'>): string {
  // A stablecoin is typed in whole cents: $24.97943 of NEAR becomes 24.98 USDT, not 24.97943.
  const u = depositUnits(STABLE.has(coin.symbol) ? Math.round(usd * 100) / 100 : usd, coin);
  return u > 0n ? fromUnits(u, coin.decimals) : '';
}

export const usdText = (units: bigint | string, coin: Pick<NearCoin, 'decimals' | 'price'>) => dollarsText(Math.floor(usdOf(units, coin.decimals, coin.price) * 100) / 100);

/**
 * The big number: what arrives, never more than it is, short enough for one line on a phone. A meme coin's billions read
 * `3.68B`, millions `12.40M`, tens of thousands whole (`36,835`); anything smaller as `coinText`.
 */
export function heroAmount(units: string | bigint, decimals: number): string {
  const v = Number(fromUnits(units, decimals, 6));
  if (v >= 1e9) return `${(Math.floor(v / 1e7) / 100).toFixed(2)}B`;
  if (v >= 1e6) return `${(Math.floor(v / 1e4) / 100).toFixed(2)}M`;
  if (v >= 1e4) return Math.floor(v).toLocaleString('en-US');
  return coinText(units, decimals);
}

/** `1 USDT ≈ 0.007 SOL`: the rate a quote gives, in the coin out per one coin in. */
export function rateText(q: Pick<SwapQuoteView, 'amountIn' | 'amountOut'>, from: NearCoin, to: NearCoin): string {
  const inn = Number(fromUnits(q.amountIn, from.decimals, 12));
  const out = Number(fromUnits(q.amountOut, to.decimals, 12));
  if (!(inn > 0) || !(out > 0)) return '';
  const r = out / inn;
  const digits = r >= 1000 ? 0 : r >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(r)));
  return `1 ${from.symbol} ≈ ${Number(r.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })} ${to.symbol}`;
}

// ---- Words ----

export const SWAP_PROBLEM: Record<SwapProblem | 'wrong', string> = {
  small: 'Too small for this route. Try a bigger amount.',
  route: 'This route is paused right now. Pick another coin or network.',
  closed: 'Deposits open soon. Prices are live.',
  busy: 'Too busy right now. Try again in a minute.',
  offline: 'Cannot reach the network right now. Try again in a minute.',
  bad: 'That did not work. Try again.',
  account: 'Check the address that receives.',
  refund: 'Check the refund address.',
  limit: 'Too big for now.',
  wrong: 'That quote did not read right. Nothing to send.',
};

/** The line for a failed price or quote, with the route's own least amount when 1Click named it. */
export function swapProblemText(e: unknown, chainName: string, maxUsd: number): string {
  if (!(e instanceof SwapError)) return SWAP_PROBLEM.bad;
  if (e.code === 'small' && e.min !== null) {
    const min = dollarsText(e.min);
    return e.min > maxUsd ? `${chainName} takes ${min} or more right now. Pick another network.` : `This route takes ${min} or more right now.`;
  }
  if (e.code === 'limit') return `Up to ${dollarsText(e.max ?? maxUsd)} a swap while Swap is new.`;
  return SWAP_PROBLEM[e.code] ?? SWAP_PROBLEM.bad;
}

/** What an address on `chain` is, for the line under its field when nothing is typed yet. */
export function addressHint(chain: Pick<SwapChain, 'id' | 'name'>, role: 'to' | 'refund'): string {
  const kind = addressKindOf(chain.id);
  if (role === 'refund' && !kind) return 'Your NEAR account. A refund waits for it inside NEAR Intents.';
  if (kind === 'near') return role === 'to' ? 'Your own NEAR wallet, not an exchange deposit address.' : 'Your own NEAR account.';
  return role === 'to' ? `Your ${chain.name} address.` : `Your own ${chain.name} address, not an exchange.`;
}

/** Why an address was refused, in a line a person acts on. */
export function addressText(why: AddressWhy | 'missing', chain: Pick<SwapChain, 'id' | 'name'>, other?: string | null, role: 'to' | 'refund' = 'to'): string {
  const net = role === 'refund' && !addressKindOf(chain.id) ? 'NEAR' : addressKindOf(chain.id) === 'evm' ? chain.name : addressKindOf(chain.id) === 'near' ? 'NEAR' : chain.name;
  switch (why) {
    case 'other':
      return `That is ${other ?? 'another network’s'} address. This needs one on ${net}.`;
    case 'checksum':
      return 'One character is off. Copy the address again.';
    case 'token-account':
      return 'That is a token account, not a wallet. Paste the wallet address.';
    case 'zero':
      return 'That address burns coins. Paste your own.';
    case 'testnet':
      return 'That is a testnet address. This swap is real.';
    case 'missing':
      return 'No such account on NEAR.';
    case 'empty':
      return addressHint(chain, role);
    default:
      return `That is not an address on ${net}.`;
  }
}

/** `0x7a2f…9c1d`: an address short enough for one line. */
export function shortAddress(a: string): string {
  return a.length <= 18 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Where a refund goes, in plain words, naming the account or address: never "you" for an account that may not be. */
export function refundText(r: Refund, from: Pick<SwapChain, 'name'>, payer?: string | null): string {
  if (r.type === 'INTENTS') return `${r.to} inside NEAR Intents`;
  if (payer) return `the paying wallet, ${shortAddress(r.to)} on ${from.name}`;
  return `${shortAddress(r.to)} on ${from.name}`;
}

/**
 * A deposit that came in short: how much is there and how much more to send by when; or, while 1Click has not said how
 * much came, no number at all (else the whole amount could go a second time); past the deadline, where it goes back.
 */
export function swapShortText(o: { pending: Pick<PendingSwap, 'from' | 'quote' | 'refund' | 'payment'>; deposited: string | null; now: number; clock?: (iso: string) => string }): string {
  const p = o.pending;
  const sym = p.from.coin.symbol;
  const clock = o.clock ?? clockText;
  const back = refundText(p.refund, p.from.chain, p.payment.by === 'wallet' ? p.payment.address : null);
  const got = o.deposited && /^\d{1,40}$/.test(o.deposited) ? `${fromUnits(o.deposited, p.from.coin.decimals)} ${sym}` : `Part of the ${sym}`;
  if (Date.parse(p.quote.deadline) <= o.now) return `Time is up. ${got} goes back to ${back}.`;
  const rest = shortRest(p, o.deposited);
  if (rest === null) {
    return `${got} arrived, less than the swap needs. How much is not known yet: wait a moment before sending more. After ${clock(p.quote.deadline)} what came goes back to ${back}.`;
  }
  return `${got} arrived, less than the swap needs. Send ${fromUnits(rest, p.from.coin.decimals)} ${sym} more by ${clock(p.quote.deadline)}, or what came goes back to ${back}.`;
}

/** Where people's money usually sits, first in the "You pay" picker: blue chips only. */
export const POPULAR_FROM: readonly (readonly [string, string])[] = [
  ['arb', 'USDT'],
  ['tron', 'USDT'],
  ['eth', 'USDT'],
  ['sol', 'USDC'],
  ['base', 'USDC'],
  ['near', 'NEAR'],
  ['eth', 'ETH'],
  ['btc', 'BTC'],
  ['sol', 'SOL'],
  ['bsc', 'USDT'],
  ['eth', 'USDC'],
  ['arb', 'USDC'],
  ['near', 'USDT'],
  ['base', 'ETH'],
];

/** What people swap into, first in the "You receive" picker: NEAR up front, then blue chips only. */
export const POPULAR_TO: readonly (readonly [string, string])[] = [
  ['near', 'NEAR'],
  ['sol', 'SOL'],
  ['eth', 'ETH'],
  ['btc', 'BTC'],
  ['near', 'USDC'],
  ['near', 'USDT'],
  ['tron', 'USDT'],
  ['arb', 'USDT'],
  ['sol', 'USDC'],
  ['base', 'USDC'],
  ['eth', 'USDC'],
  ['bsc', 'BNB'],
  ['base', 'ETH'],
  ['arb', 'ETH'],
];

/** The pair a first visit starts from: USDT on Arbitrum (cheap to send, quick to land) into SOL on Solana. */
export const START_FROM: readonly [string, string] = ['arb', 'USDT'];
export const START_TO: readonly [string, string] = ['sol', 'SOL'];
