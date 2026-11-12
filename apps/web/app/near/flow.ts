import { coinText, fromUnits, type AppFee, type NearChain, type NearCoin, type NearProgress, type NearQuoteView } from '@maskwars/pay';

/** The page's side of /api/pay/near: typed answers, and failures as short codes the page words itself. */

export type NearProblem = 'small' | 'route' | 'closed' | 'busy' | 'bad' | 'account' | 'offline';

export class NearError extends Error {
  readonly code: NearProblem;
  /** The HTTP status, 0 when the server was not reached. */
  readonly status: number;
  /** The least the route takes, in dollars, when 1Click named it. */
  readonly min: number | null;
  /** Why an account was refused. */
  readonly why: string | null;
  constructor(code: NearProblem, status = 0, extra: { min?: unknown; why?: unknown } = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.min = typeof extra.min === 'number' && extra.min > 0 ? extra.min : null;
    this.why = typeof extra.why === 'string' ? extra.why : null;
  }
}

export interface NearCatalogView {
  readonly live: boolean;
  readonly maxUsd: number;
  readonly fee: AppFee | null;
  readonly near: { readonly assetId: string; readonly decimals: number; readonly price: number };
  readonly chains: readonly NearChain[];
}

export type AccountView =
  | { readonly ok: true; readonly id: string; readonly kind: 'named' | 'implicit'; readonly exists: boolean | null }
  | { readonly ok: false; readonly why: 'empty' | 'eth' | 'testnet' | 'bad' };

async function call<T>(path: string, init?: { body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/pay/near${path}`, {
      method: init?.body === undefined ? 'GET' : 'POST',
      headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init?.signal ? { signal: init.signal } : {}),
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NearError('offline');
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: NearProblem; min?: unknown; why?: unknown }) | null;
  if (!res.ok || !json) throw new NearError(json?.error ?? (res.status === 429 ? 'busy' : 'offline'), res.status, json ?? {});
  return json;
}

export const nearApi = {
  catalog: () => call<NearCatalogView>(''),
  quote: (b: { from: string; usd: number; recipient?: string; dry: boolean }, signal?: AbortSignal) =>
    call<{ quote: NearQuoteView }>('/quote', { body: b, ...(signal ? { signal } : {}) }).then((r) => r.quote),
  account: (id: string, signal?: AbortSignal) => call<AccountView>(`/account?id=${encodeURIComponent(id)}`, signal ? { signal } : undefined),
  status: (address: string, memo?: string | null) =>
    call<NearProgress>(`/status?address=${encodeURIComponent(address)}${memo ? `&memo=${encodeURIComponent(memo)}` : ''}`),
};

// ---- What this browser remembers ----

/** A swap whose deposit address is out: the page comes back to it after a reload until it ends. Nothing secret. */
export interface PendingNear {
  readonly recipient: string;
  readonly chain: { readonly id: string; readonly name: string };
  readonly coin: NearCoin;
  readonly usd: number;
  readonly quote: NearQuoteView;
  /** Sent from a wallet in this browser: which one and the transaction, so a reload never offers to pay twice. */
  readonly paid?: { readonly by: string; readonly tx: string; readonly link: string | null };
}

const PENDING = 'maskwars:near';
const LAST = 'maskwars:near:last';

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
export function loadPending(now = Date.now()): PendingNear | null {
  const p = read<PendingNear>(PENDING);
  if (!p?.quote?.depositAddress || typeof p.recipient !== 'string') return null;
  if (Date.parse(p.quote.closes) < now) {
    write(PENDING, null);
    return null;
  }
  return p;
}

export const savePending = (p: PendingNear | null) => write(PENDING, p);

/** The last coin and account used here, to start from next time. */
export interface LastPick {
  readonly from?: string;
  readonly to?: string;
}

export const loadLast = (): LastPick => read<LastPick>(LAST) ?? {};
export const saveLast = (p: LastPick) => write(LAST, { ...loadLast(), ...p });

/**
 * Who the page starts with as the receiver. The account this browser used before, or nothing, wins over one a link
 * names (`?to=`): a link is somebody else's word, and both the NEAR and any refund would go to it. A receiver taken from
 * a link is marked, and the page asks the person to confirm it before it gives a deposit address.
 */
export function startReceiver(o: { saved?: string | null | undefined; link?: string | null | undefined }): { text: string; fromLink: boolean } {
  const saved = (o.saved ?? '').trim();
  if (saved) return { text: saved.slice(0, 64), fromLink: false };
  const link = (o.link ?? '').trim();
  return link ? { text: link.slice(0, 64), fromLink: true } : { text: '', fromLink: false };
}

// ---- Words ----

export const PROBLEM: Record<NearProblem | 'wrong', string> = {
  small: 'Too small for this route. Try a bigger amount.',
  route: 'This route is paused right now. Pick another network.',
  closed: 'Deposits open soon. Prices are live.',
  busy: 'Too busy right now. Try again in a minute.',
  offline: 'Cannot reach the network right now. Try again in a minute.',
  bad: 'That did not work. Try again.',
  account: 'Check the NEAR account.',
  wrong: 'That quote did not read right. Nothing to send.',
};

/** The line for a failed price or quote, with the route's own least amount when 1Click named it. */
export function problemText(e: unknown, chainName: string, maxUsd: number): string {
  if (!(e instanceof NearError)) return PROBLEM.bad;
  if (e.code === 'small' && e.min !== null) {
    const min = dollarsText(e.min);
    return e.min > maxUsd ? `${chainName} takes ${min} or more right now. Pick another network.` : `${chainName} takes ${min} or more right now.`;
  }
  if (e.code === 'route') return `${chainName} is paused right now. Pick another network.`;
  if (e.code === 'account') return accountText(e.why === 'missing' ? { ok: true, id: '', kind: 'named', exists: false } : { ok: false, why: (e.why as 'bad') ?? 'bad' });
  return PROBLEM[e.code] ?? PROBLEM.bad;
}

/** What the line under the account says, and whether it is wrong. */
/** Whoever holds the receiving account holds a refund too: the page asks for the person's own wallet. */
export const OWN = 'Your own NEAR wallet, not an exchange deposit address.';

export function accountText(a: AccountView | null): string {
  if (!a) return OWN;
  if (!a.ok) {
    switch (a.why) {
      case 'empty':
        return OWN;
      case 'eth':
        return 'That is an Ethereum address. Paste a NEAR account.';
      case 'testnet':
        return 'That is a testnet account. This NEAR is real: use a mainnet one.';
      default:
        return 'That is not a NEAR account.';
    }
  }
  if (a.kind === 'implicit') return a.exists === false ? 'New account: the NEAR opens it. Your own wallet only.' : 'On NEAR. Your own wallet, not an exchange.';
  return a.exists ? 'On NEAR. Your own wallet, not an exchange.' : 'No such account on NEAR.';
}

export const accountBad = (a: AccountView | null) => !!a && ((!a.ok && a.why !== 'empty') || (a.ok && a.kind === 'named' && a.exists === false));
export const accountReady = (a: AccountView | null) => !!a && a.ok && (a.kind === 'implicit' || a.exists === true);

/** `$25`, `$12.50`, `$100`. */
export function dollarsText(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString('en-US')}` : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `~25 s`, `~2 min`, `~14 min`. */
export function etaText(seconds: number): string {
  if (!(seconds > 0)) return '~1 min';
  if (seconds < 90) return `~${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  return `~${Math.round(seconds / 60)} min`;
}

/** `0.25%`, `0.2%`, `0.33%`. */
export function percentText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** The fees inside a quote's price: ours, and NEAR Intents' own (everything else the quote names). */
export function feeSplit(fees: readonly AppFee[], ours: string | null): { ours: number; intents: number } {
  let o = 0;
  let i = 0;
  for (const f of fees) {
    if (ours !== null && f.recipient === ours) o += f.fee;
    else i += f.fee;
  }
  return { ours: o, intents: i };
}

/** NEAR as a person reads it: `6.73`, `0.2691`. */
export const nearText = (units: string | bigint, decimals = 24) => coinText(units, decimals);

/** `21:40` in the person's own clock. */
export const clockText = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * A deposit that came in short: how much is there, how much more to send and by when, or, past the deadline, where it
 * goes. 1Click swaps the whole once the rest arrives; after the deadline it refunds what came to the receiver inside
 * NEAR Intents.
 */
export function shortText(o: { pending: PendingNear; deposited: string | null; now: number; clock?: (iso: string) => string }): string {
  const { pending: p } = o;
  const sym = p.coin.symbol;
  const clock = o.clock ?? clockText;
  const got = unitsOf(o.deposited);
  const gotText = got !== null ? `${fromUnits(got, p.coin.decimals)} ${sym}` : `Part of the ${sym}`;
  if (Date.parse(p.quote.deadline) <= o.now) return `Time is up. ${gotText} goes to ${p.recipient} inside NEAR Intents.`;
  const rest = shortRest(p, o.deposited);
  // 1Click has not said how much came: no number to send, or the whole amount would go a second time.
  if (rest === null) {
    return `${gotText} arrived, less than the swap needs. How much is not known yet: wait a moment before sending more. After ${clock(p.quote.deadline)} what came goes to ${p.recipient} inside NEAR Intents.`;
  }
  return `${gotText} arrived, less than the swap needs. Send ${fromUnits(rest, p.coin.decimals)} ${sym} more by ${clock(p.quote.deadline)}, or it goes to ${p.recipient} inside NEAR Intents.`;
}

const unitsOf = (t: string | null) => (t && /^\d{1,40}$/.test(t) ? BigInt(t) : null);

/**
 * What is left to send after a short deposit: up to the amount quoted, so one more transfer of exactly this clears the
 * minimum with room to spare. `null` when 1Click has not said how much came.
 */
export function shortRest(p: { readonly quote: Pick<NearQuoteView, 'amountIn' | 'minAmountIn'> }, deposited: string | null): bigint | null {
  const got = unitsOf(deposited);
  if (got === null) return null;
  const toAmount = BigInt(p.quote.amountIn) - got;
  const toMin = BigInt(p.quote.minAmountIn) - got;
  return toAmount > 0n ? toAmount : toMin > 0n ? toMin : null;
}

/** `0xfd08…cbb9`, `TR7NHq…jLj6t`: a contract short enough for one line. */
export function shortId(a: string): string {
  return a.length <= 16 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** 29:41, 1:59:12. */
export function mmss(ms: number): string {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Coins for the picker: everything that matches the search, by coin first, then network. Empty search: `top`. */
export function searchCoins(
  chains: readonly NearChain[],
  text: string,
  chainId: string | null,
  popular: readonly (readonly [string, string])[] = POPULAR,
): { chain: NearChain; coin: NearCoin }[] {
  const q = text.trim().toLowerCase();
  const all = chains.flatMap((chain) => chain.coins.map((coin) => ({ chain, coin })));
  if (chainId) return all.filter((x) => x.chain.id === chainId && (!q || matches(x, q)));
  if (!q) return popular.flatMap(([c, s]) => all.filter((x) => x.chain.id === c && x.coin.symbol === s));
  // Every word has to fit: `usdt tron` is USDT on Tron, not every USDT and everything on Tron.
  const words = q.split(/\s+/);
  const hits = all.filter((x) => words.every((w) => matches(x, w)));
  const sym = (x: { coin: NearCoin }) => x.coin.symbol.toLowerCase();
  const named = (x: { coin: NearCoin }) => sym(x) === q || x.coin.name?.toLowerCase() === q || (x.coin.aka ?? []).some((w) => w.toLowerCase() === q);
  // A network's own coin by its name first (`bitcoin` is Bitcoin before any wrapped one), then the symbol or another
  // name exactly, then a symbol that starts so; the rest in the list's own order.
  const rank = (x: { coin: NearCoin }) => (named(x) ? (x.coin.native ? 0 : 1) : sym(x).startsWith(q) ? 2 : 3);
  // A network asked for by its name (`tron`) shows as its own tab does, in the list's order: what people hold there first.
  const oneNetwork = hits.length > 0 && hits.every((x) => x.chain.id === hits[0]!.chain.id) && !hits.some((x) => sym(x) === q);
  return oneNetwork ? hits : hits.sort((a, b) => rank(a) - rank(b));
}

/** What people call a token on its network: `usdt trc20`, `erc-20`. Only for tokens, never the network's own coin. */
const STANDARD: Readonly<Record<string, string>> = { eth: 'erc20', tron: 'trc20', bsc: 'bep20', sol: 'spl' };

/** Whether a word of `text` starts with `q`: `tether` finds Tether USD, `eth` does not find Tether. */
const wordStarts = (text: string | undefined, q: string) => !!text && text.toLowerCase().split(/[\s·.()-]+/).some((w) => w.startsWith(q));

/** A symbol anywhere (`btc` finds cbBTC), a name, note, other name or network by the start of a word, a contract whole. */
function matches(x: { chain: NearChain; coin: NearCoin }, q: string): boolean {
  const c = x.coin;
  return (
    c.symbol.toLowerCase().includes(q) ||
    [c.name, c.note, ...(c.aka ?? [])].some((w) => wordStarts(w, q) || w?.toLowerCase() === q) ||
    wordStarts(x.chain.name, q) ||
    x.chain.id === q ||
    (!c.native && c.contract !== null && STANDARD[x.chain.id] === q.replace(/-/g, '')) ||
    (c.contract !== null && q.length >= 6 && c.contract.toLowerCase() === q)
  );
}

/**
 * A coin's dollar price for the picker, never in scientific notation: `$73,471`, `$3.52`, `$0.0378`, `$0.00000433`.
 * Three significant digits under a dime, so a meme coin still reads as a number.
 */
export function priceText(price: number): string {
  if (!(price > 0) || !Number.isFinite(price)) return '';
  if (price >= 1000) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (price >= 0.1) return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (price < 1e-12) return '<$0.000000000001';
  return `$${price.toLocaleString('en-US', { maximumSignificantDigits: 3, maximumFractionDigits: 20 })}`;
}

/** Where people's money usually sits, first in the picker: USDC where people hold it, then USDT, then the networks' own coins. */
export const POPULAR: readonly (readonly [string, string])[] = [
  ['arb', 'USDC'],
  ['sol', 'USDC'],
  ['base', 'USDC'],
  ['eth', 'USDC'],
  ['arb', 'USDT'],
  ['tron', 'USDT'],
  ['eth', 'USDT'],
  ['bsc', 'USDT'],
  ['pol', 'USDT'],
  ['ton', 'USDT'],
  ['eth', 'ETH'],
  ['sol', 'SOL'],
  ['btc', 'BTC'],
  ['base', 'ETH'],
];

/** The coin a first visit starts from: USDC on Arbitrum, cheap to send and quick to land. */
export const START: readonly [string, string] = ['arb', 'USDC'];
