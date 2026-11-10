import { envelope, jobHash, originOk, type HireEvent, type HireJob } from '@maskwars/hire';
import type { Coin, QuoteView } from '@maskwars/pay';

/**
 * The page around the checkout, as the browser itself says: `ancestorOrigins` where it has it (no page can forge it),
 * else the referrer the element sends (a page can withhold it, not change it). Never the `host` a URL claims. `null`
 * when the browser does not say, or the checkout is not in a frame.
 */
export function seenPage(): string | null {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const a = window.location.ancestorOrigins?.[0];
  if (a !== undefined) return a && a !== 'null' ? originOk(a) : null;
  try {
    return document.referrer ? originOk(new URL(document.referrer).origin) : null;
  } catch {
    return null;
  }
}

/** The page as a payer reads it: its host name, `northwind.example`. */
export const pageName = (page: string): string => {
  try {
    return new URL(page).host;
  } catch {
    return page;
  }
};

/**
 * Who the checkout tells what happens: the page that framed it. Where the browser names that page, it is told and no
 * one else, whatever `host` says; elsewhere the element's `host` is used, and a wrong one only means the browser drops
 * the message, as `postMessage` delivers to the named origin alone.
 */
export function hostOf(host: string | null): string | null {
  if (typeof window === 'undefined' || window.parent === window) return null;
  return seenPage() ?? (host ? originOk(host) : null);
}

export function tell(host: string | null, event: HireEvent): void {
  if (!host) return;
  try {
    window.parent.postMessage(envelope(event), host);
  } catch {
    /* the parent went away */
  }
}

/** A deposit handed out and not yet ended, kept in this browser so a reload of the host page finds it again. */
export interface Pending {
  readonly job: HireJob;
  readonly coin: Coin;
  readonly chain: string;
  readonly usd: number;
  readonly quote: QuoteView;
}

/** What the host page named for a job: the vault, too, if it named one. The deposit for it is found by this. */
export interface Slot {
  readonly text: string;
  readonly target: string;
  readonly team: string | null;
}

/** One record per job as the page named it, so two buttons or two jobs on one site never take each other's deposit. */
const keyOf = (s: Slot) => `maskwars.hire.pending.${jobHash({ text: s.text, target: s.target, team: s.team ?? '' })}`;

/** The pending deposit for exactly this job, while its address still takes money. */
export function loadPending(slot: Slot | null): Pending | null {
  if (!slot) return null;
  try {
    const p = JSON.parse(localStorage.getItem(keyOf(slot)) ?? 'null') as Pending | null;
    if (!p || p.job.text !== slot.text || p.job.target !== slot.target || (slot.team !== null && p.job.team !== slot.team)) return null;
    if (!p.quote?.depositAddress || Date.parse(p.quote.closes) < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

export function savePending(slot: Slot, p: Pending): void {
  try {
    localStorage.setItem(keyOf(slot), JSON.stringify(p));
  } catch {
    /* storage is off in this frame: the deposit still works, it just is not found again after a reload */
  }
}

/** Forgets this job's deposit, and only this job's. */
export function clearPending(slot: Slot): void {
  try {
    localStorage.removeItem(keyOf(slot));
  } catch {
    /* nothing kept */
  }
}
