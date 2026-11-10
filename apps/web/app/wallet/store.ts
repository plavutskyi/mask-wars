import type { Coin } from '@maskwars/pay';
import type { Held, QuoteView } from './api';

/** What this browser remembers: whose vault is open, the vault passkeys it has seen, a top-up still waiting for its
 * transfer and a cash-out not settled yet. Nothing secret: public keys, credential ids, account names, quotes. */

export type Who =
  | { readonly kind: 'passkey'; readonly id: string; readonly key: string; readonly account: string }
  | { readonly kind: 'near'; readonly account: string };

export interface PendingTopUp {
  readonly account: string;
  readonly coin: Coin;
  readonly chain: string;
  readonly usd: number;
  readonly quote: QuoteView;
}

/** A cash-out as the person set it up: what leaves the vault, where it goes, what the preview showed. */
export interface CashOutDraft {
  readonly from: Held;
  readonly chain: { readonly id: string; readonly name: string };
  readonly coin: Coin;
  readonly recipient: string;
  readonly units: string;
  readonly seen: string | null;
}

/**
 * A signed cash-out that has not settled. `sent`: 1Click took it. `unsure`: sending it failed on the way, so it may still
 * go through until `until` (its intent's deadline and a margin); no new cash-out starts before it settles.
 */
export interface PendingCashOut extends CashOutDraft {
  readonly account: string;
  readonly deal: QuoteView;
  readonly sent: 'sent' | 'unsure';
  readonly until: number;
}

const WHO = 'maskwars:vault';
const PENDING = 'maskwars:topup';
const OUT = 'maskwars:cashout';
const KNOWN = 'maskwars:passkeys';

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

export function loadWho(): Who | null {
  const w = read<Who>(WHO);
  if (!w || typeof w.account !== 'string') return null;
  if (w.kind === 'passkey' && typeof w.id === 'string' && typeof w.key === 'string') return w;
  if (w.kind === 'near') return w;
  return null;
}

export const saveWho = (w: Who | null) => write(WHO, w);

/** A top-up still worth waiting for: this vault's, and its address has not been closed for more than an hour. */
export function loadPending(account: string): PendingTopUp | null {
  const p = read<PendingTopUp>(PENDING);
  if (!p || p.account !== account || !p.quote?.depositAddress) return null;
  if (Date.parse(p.quote.deadline) + 3600_000 < Date.now()) {
    write(PENDING, null);
    return null;
  }
  return p;
}

export const savePending = (p: PendingTopUp | null) => write(PENDING, p);

/** A cash-out of this vault still settling. Kept a day past its deadline at most: by then it has settled for sure. */
export function loadPendingOut(account: string): PendingCashOut | null {
  const p = read<PendingCashOut>(OUT);
  if (!p || p.account !== account || !p.deal?.depositAddress || typeof p.until !== 'number' || !p.from?.assetId) return null;
  if (p.until + 86_400_000 < Date.now()) {
    write(OUT, null);
    return null;
  }
  return p;
}

export const savePendingOut = (p: PendingCashOut | null) => write(OUT, p);

/** Vault passkeys this browser has made or opened: never offered a second vault on the same authenticator. */
export function loadKnown(): string[] {
  const k = read<unknown>(KNOWN);
  return Array.isArray(k) ? k.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{16,342}$/.test(x)).slice(0, 16) : [];
}

export function rememberKnown(id: string): void {
  write(KNOWN, [id, ...loadKnown().filter((x) => x !== id)].slice(0, 16));
}
