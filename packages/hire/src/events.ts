/**
 * What the checkout tells the page it is embedded in. The checkout runs on maskwars.xyz in a frame; it posts these to
 * the host's origin only, and the element accepts them only from its own frame and from the checkout's origin. The host
 * gets them as DOM events on the element: `hire:deposit`, `hire:funded` and the rest, with the event in `detail`.
 */

/** Where a job's swap is, in the words of `@maskwars/pay`'s `Stage`. */
export type HireStage = "waiting" | "seen" | "moving" | "done" | "short" | "refunded" | "failed";

/** The job as the host may keep it: its id and mark, and what it says. */
export interface HireJob {
  readonly id: string;
  /** sha256 of the job's canonical JSON (`jobHash`). */
  readonly hash: string;
  readonly text: string;
  readonly target: string;
  readonly team: string;
}

export type HireEvent =
  /** The checkout is up. */
  | { readonly type: "ready" }
  /** A deposit address was handed out and read back: the payer sends `amount` `coin` on `chain` to `address`. */
  | {
      readonly type: "deposit";
      readonly job: HireJob;
      readonly chain: string;
      readonly coin: string;
      /** Decimal coin amount, as the payer sends it. */
      readonly amount: string;
      readonly address: string;
      readonly memo: string | null;
      /** Send by: after this the swap refunds. */
      readonly deadline: string;
      /** NEAR promised at least, decimal. */
      readonly near: string;
    }
  /**
   * The payer asked for a new address: this one is no longer shown and nothing more is heard of it. Anything still sent
   * to it is swapped into the team's vault all the same, or refunded there.
   */
  | { readonly type: "dropped"; readonly job: string }
  /** The swap moved on. */
  | { readonly type: "progress"; readonly job: string; readonly stage: HireStage }
  /** The NEAR landed in the team's vault, marked for the job. */
  | { readonly type: "funded"; readonly job: HireJob; readonly near: string; readonly txs: readonly string[] }
  /** The swap did not go through: the coin went back to the team's vault. */
  | { readonly type: "refunded"; readonly job: HireJob; readonly stage: "short" | "refunded" }
  /** Something broke; `code` is what support needs. */
  | { readonly type: "failed"; readonly job: HireJob; readonly code: string }
  /** The payer closed the checkout. */
  | { readonly type: "close" };

export type HireEventType = HireEvent["type"];

/** The envelope on the wire: a marker and a version, so the host can tell these apart from anything else it hears. */
export interface HireMessage {
  readonly maskwarsHire: 1;
  readonly event: HireEvent;
}

const TYPES: readonly HireEventType[] = ["ready", "deposit", "dropped", "progress", "funded", "refunded", "failed", "close"];

/** Whether a message's data is one of ours, shaped right. Everything else a window hears is ignored. */
export function hireMessage(data: unknown): HireEvent | null {
  if (!data || typeof data !== "object") return null;
  const m = data as { maskwarsHire?: unknown; event?: unknown };
  if (m.maskwarsHire !== 1 || !m.event || typeof m.event !== "object") return null;
  const e = m.event as { type?: unknown };
  return typeof e.type === "string" && (TYPES as readonly string[]).includes(e.type) ? (m.event as HireEvent) : null;
}

export function envelope(event: HireEvent): HireMessage {
  return { maskwarsHire: 1, event };
}

/** The DOM event name on the element: `hire:funded`. */
export const domEvent = (type: HireEventType): `hire:${HireEventType}` => `hire:${type}`;

/** Where the checkout lives unless the page names another (a preview, a local run). */
export const HIRE_ORIGIN = "https://maskwars.xyz";

/** The checkout's address for an element's attributes. Only the fields the checkout reads; `host` is who to tell. */
export function checkoutUrl(origin: string, a: { job?: string | null; target?: string | null; team?: string | null; usd?: string | null; near?: string | null; chain?: string | null; host: string }): string {
  const u = new URL("/hire/embed", origin);
  for (const k of ["job", "target", "team", "usd", "near", "chain"] as const) {
    const v = a[k];
    if (v) u.searchParams.set(k, v.slice(0, 400));
  }
  u.searchParams.set("host", a.host);
  return u.href;
}

/** An origin the element may load the checkout from: https anywhere, http only on this machine. `null` otherwise. */
export function originOk(text: string): string | null {
  try {
    const u = new URL(text);
    if (u.protocol === "https:" || (u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return u.origin;
  } catch {
    /* not a URL */
  }
  return null;
}
