import type { CatalogChain, Coin, Progress, QuoteView } from '@maskwars/pay';
import type { HireJob, Job, VaultProof } from '@maskwars/hire';

/**
 * The checkout's side of the site's API: same origin as the frame, so the money routes answer it and no one else.
 * Every call names the page that framed the checkout (`x-hire-page`, as the browser told it), so the server can hold
 * each page to its own budget.
 */

export type Problem = 'small' | 'route' | 'closed' | 'busy' | 'bad' | 'offline' | 'proof' | 'vault';

export class HireError extends Error {
  readonly code: Problem;
  readonly status: number;
  constructor(code: Problem, status = 0) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** A preview that only failed for a moment: it does not stand in the way of the real quote. */
export const passing = (e: unknown): boolean => e instanceof HireError && (e.code === 'busy' || e.code === 'offline');

export interface CatalogView {
  /** Deposit addresses are open (HIRE_LIVE). */
  readonly live: boolean;
  /** The site's cut, in basis points: 0 unless the owner set one. */
  readonly fee: number;
  /** The most one hire may pay, in dollars (limits.hire_usd_max of packages/network/mainnet.json). */
  readonly max?: number;
  readonly near: Coin;
  readonly chains: readonly (CatalogChain & { readonly window: number })[];
}

let page: string | null = null;
/** The page around the checkout, once the checkout has asked the browser. */
export const setPage = (p: string | null) => {
  page = p;
};

async function call<T>(path: string, init?: { body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = page ? { 'x-hire-page': page } : {};
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  try {
    res = await fetch(`/api/${path}`, {
      method: init?.body === undefined ? 'GET' : 'POST',
      headers,
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init?.signal ? { signal: init.signal } : {}),
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new HireError('offline');
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: Problem }) | null;
  if (!res.ok || !json) throw new HireError(json?.error ?? (res.status === 429 ? 'busy' : 'offline'), res.status);
  return json;
}

export const api = {
  catalog: () => call<CatalogView>('hire/catalog'),
  /** A shared preview: the same price for everyone pricing this coin and these dollars, naming no one. */
  preview: (b: { team: string; from: string; usd: number }, signal?: AbortSignal) =>
    call<{ quote: QuoteView }>('hire/preview', { body: b, ...(signal ? { signal } : {}) }).then((r) => r.quote),
  /** The deposit address for this job, with its ticket: only with the payer's proof, and only while HIRE_LIVE is on. */
  hire: (b: { job: Job; from: string; usd: number; proof: VaultProof }) => call<{ quote: QuoteView; job: HireJob }>('hire/quote', { body: b }),
  /** A proof the vault window left here because the page cut it off from this frame. Taken once. */
  relay: (relay: string) => call<{ proof: VaultProof | null; vault?: string }>(`hire/proof?relay=${relay}`),
  status: (address: string, memo?: string | null) =>
    call<Progress>(`pay/status?address=${encodeURIComponent(address)}${memo ? `&memo=${encodeURIComponent(memo)}` : ''}`),
};
