import type { CatalogChain, Coin, Progress, QuoteView, SignedIntent, UnsignedIntent } from '@maskwars/pay';

export type { QuoteView };

/** The page's side of /api/pay: typed answers, and failures as short codes the page words itself. */

export type Problem = 'small' | 'route' | 'closed' | 'busy' | 'bad' | 'signature' | 'offline';

export class PayError extends Error {
  readonly code: Problem;
  /** The HTTP status, 0 when the server was not reached at all. */
  readonly status: number;
  constructor(code: Problem, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Whether a failure says for sure that nothing reached 1Click: a refusal (4xx) from this site or from 1Click. A timeout,
 * an outage or a lost answer (5xx, no answer) does not: the request may have gone through.
 */
export const surelyRefused = (e: unknown): boolean => e instanceof PayError && e.status >= 400 && e.status < 500;

/** A preview that only failed for a moment (busy, offline): it does not stand in the way of the real quote. */
export const passing = (e: unknown): boolean => e instanceof PayError && (e.code === 'busy' || e.code === 'offline');

export interface CatalogView {
  readonly live: boolean;
  /** The most one top-up may bring, in dollars (limits.pay_usd_max of packages/network/mainnet.json). */
  readonly maxUsd?: number;
  readonly near: Coin;
  readonly chains: readonly (CatalogChain & { readonly window: number })[];
}

/** The coins on offer: still coming, there, or not reachable after a few tries (with a way to try again). */
export interface CatalogState {
  readonly catalog: CatalogView | null;
  readonly down: boolean;
  readonly retry: () => void;
}

export interface Held extends Coin {
  readonly units: string;
  readonly usd: number;
}

export interface VaultView {
  readonly account: string;
  readonly usd: number;
  readonly near: string;
  readonly nearPrice: number;
  readonly holdings: readonly Held[];
}

async function call<T>(path: string, init?: { body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/pay/${path}`, {
      method: init?.body === undefined ? 'GET' : 'POST',
      headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init?.signal ? { signal: init.signal } : {}),
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new PayError('offline');
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: Problem }) | null;
  if (!res.ok || !json) throw new PayError(json?.error ?? (res.status === 429 ? 'busy' : 'offline'), res.status);
  return json;
}

export const pay = {
  catalog: () => call<CatalogView>('catalog'),
  vault: (account: string) => call<VaultView>(`vault?account=${encodeURIComponent(account)}`),
  quoteIn: (b: { account: string; from: string; usd: number; dry: boolean }, signal?: AbortSignal) =>
    call<{ quote: QuoteView }>('quote', { body: { kind: 'in', ...b }, ...(signal ? { signal } : {}) }).then((r) => r.quote),
  quoteOut: (b: { account: string; from: string; to: string; recipient: string; units: string; dry: boolean }, signal?: AbortSignal) =>
    call<{ quote: QuoteView }>('quote', { body: { kind: 'out', ...b }, ...(signal ? { signal } : {}) }).then((r) => r.quote),
  status: (address: string, memo?: string | null) =>
    call<Progress>(`status?address=${encodeURIComponent(address)}${memo ? `&memo=${encodeURIComponent(memo)}` : ''}`),
  intent: (b: { depositAddress: string; signer: string; standard: 'webauthn' | 'nep413' }) => call<{ intent: UnsignedIntent }>('intent', { body: b }).then((r) => r.intent),
  submit: (signed: SignedIntent) => call<{ intentHash: string }>('submit', { body: { signed } }),
  passkey: (id: string) =>
    call<{ key: string | null }>(`passkey?id=${encodeURIComponent(id)}`)
      .then((r) => r.key)
      .catch(() => null),
  savePasskey: (id: string, key: string) => call<{ ok: true }>('passkey', { body: { id, key } }).catch(() => null),
  keyRegistered: (account: string, key: string) =>
    call<{ registered: boolean }>(`key?account=${encodeURIComponent(account)}&key=${encodeURIComponent(key)}`).then((r) => r.registered),
};
