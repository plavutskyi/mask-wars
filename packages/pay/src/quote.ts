import { chainOf } from "./chains.ts";
import { NEAR_ASSET, type Coin } from "./catalog.ts";
import type { DepositType, QuoteRequest, QuoteResponse, RecipientType } from "./oneclick.ts";

/** Shown in NEAR Intents' own data as where the swap came from. */
export const REFERRAL = "maskwars";
/** 1% either way on the price before a swap gives up and refunds. */
export const SLIPPAGE_BPS = 100;
/** A cash-out spends from the vault at once: the quote only has to live while the person signs. */
export const CASH_OUT_MINUTES = 15;

/**
 * How long 1Click waits for market makers to bid: none for a preview, which answers in half a second instead of three
 * (measured live), and three seconds for the quote that is kept, so it gets the best price.
 */
const waitMs = (dry: boolean) => (dry ? 0 : 3000);

const later = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

/**
 * Top up a vault from another network: the person sends `amount` units of `from` to the deposit address, 1Click swaps
 * it to NEAR and credits the vault's own NEAR Intents account. If the swap cannot go through, the coin comes back to the
 * same vault, so nobody has to type a refund address. FLEX_INPUT: a transfer a little off the exact amount (an exchange
 * taking its fee) still goes through as long as it is at least `minAmountIn`.
 */
export function topUpRequest(o: { account: string; from: Coin; amount: bigint; dry: boolean; now?: Date }): QuoteRequest {
  const chain = o.from.chain === "near" ? null : chainOf(o.from.chain);
  if (!chain) throw new Error(`no top-up from ${o.from.chain}`);
  if (o.amount <= 0n) throw new Error("amount must be positive");
  return {
    dry: o.dry,
    swapType: "FLEX_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: o.from.assetId,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: NEAR_ASSET,
    amount: o.amount.toString(),
    refundTo: o.account,
    refundType: "INTENTS",
    recipient: o.account,
    recipientType: "INTENTS",
    deadline: later(o.now ?? new Date(), chain.window),
    referral: REFERRAL,
    quoteWaitingTimeMs: waitMs(o.dry),
  };
}

/**
 * Cash out of a vault: `amount` units of `from` (a coin the vault holds) leave its NEAR Intents account and arrive as
 * `to` at `recipient` on `to`'s network. Anything that cannot be delivered comes back to the vault.
 */
export function cashOutRequest(o: { account: string; from: Coin; to: Coin; recipient: string; amount: bigint; dry: boolean; now?: Date }): QuoteRequest {
  if (o.to.chain === "near") throw new Error("no cash-out to NEAR Intents itself");
  if (o.amount <= 0n) throw new Error("amount must be positive");
  return {
    dry: o.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: o.from.assetId,
    depositType: "INTENTS",
    destinationAsset: o.to.assetId,
    amount: o.amount.toString(),
    refundTo: o.account,
    refundType: "INTENTS",
    recipient: o.recipient.trim(),
    recipientType: "DESTINATION_CHAIN",
    deadline: later(o.now ?? new Date(), CASH_OUT_MINUTES),
    referral: REFERRAL,
    quoteWaitingTimeMs: waitMs(o.dry),
  };
}

/** Whether a 1Click refusal means the amount is below what the route moves. */
export function tooSmall(message: string): boolean {
  return /too low|too small|at least|minimum|below/i.test(message);
}

/**
 * What the page gets of a quote: the amounts and times it shows, and the terms it checks against what the person typed
 * (who receives, which coin, where a refund goes). A preview served to several people names no one: `recipient` and
 * `refundTo` are `null` there.
 */
export interface QuoteView {
  readonly correlationId: string;
  readonly dry: boolean;
  readonly depositAddress: string | null;
  readonly depositMemo: string | null;
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly recipient: string | null;
  readonly recipientType: RecipientType;
  readonly refundTo: string | null;
  readonly refundType: DepositType;
  readonly amountIn: string;
  readonly minAmountIn: string;
  readonly amountOut: string;
  /** The least that arrives, or the swap refunds: what the person is promised. */
  readonly minAmountOut: string;
  /** Send by / sign by: the swap waits this long, then refunds. A cash-out's intent is dated no later than this. */
  readonly deadline: string;
  /** The deposit address stops: 1Click keeps it three days past `deadline`. */
  readonly closes: string;
  readonly timeEstimate: number;
}

export function quoteView(q: QuoteResponse): QuoteView {
  const x = q.quote;
  const r = q.quoteRequest;
  return {
    correlationId: q.correlationId,
    dry: r.dry,
    depositAddress: x.depositAddress ?? null,
    depositMemo: x.depositMemo ?? null,
    originAsset: r.originAsset,
    destinationAsset: r.destinationAsset,
    recipient: r.recipient,
    recipientType: r.recipientType,
    refundTo: r.refundTo,
    refundType: r.refundType,
    amountIn: x.amountIn,
    minAmountIn: x.minAmountIn,
    amountOut: x.amountOut,
    minAmountOut: x.minAmountOut,
    deadline: r.deadline,
    closes: x.deadline ?? r.deadline,
    timeEstimate: x.timeEstimate,
  };
}

/** A preview for anyone with the same coins and amount: the same prices, nobody's addresses. */
export function previewView(v: QuoteView): QuoteView {
  return { ...v, recipient: null, refundTo: null, depositAddress: null, depositMemo: null };
}

/** What the person agreed to, for reading a quote back before it is used. */
export interface QuoteTerms {
  /** The vault: every refund goes back to it. */
  readonly account: string;
  readonly from: string;
  readonly to: string;
  /** Where the money arrives: the vault itself for a top-up, the typed address for a cash-out. */
  readonly recipient: string;
  readonly recipientType: RecipientType;
  /** The exact units leaving the vault (a cash-out). */
  readonly amountIn?: string;
  /** What the preview showed arriving; the promise may not fall more than `MAX_DRIFT_BPS` below it. */
  readonly seen?: string | null;
}

/** How far the guaranteed amount may sit below the preview the person saw: 1% slippage plus 2% of price movement. */
export const MAX_DRIFT_BPS = 300;

export type QuoteCheck = { readonly ok: true } | { readonly ok: false; readonly why: string; readonly moved?: true };

/**
 * Reads a quote back against what the person typed, before its deposit address is shown or its intent is signed:
 * the coin in and out, the receiver, refunds to the vault, the exact amount out of the vault, and a promised minimum
 * that honors the 1% slippage and has not slid away from the preview. `moved` marks the one failure a fresh look fixes.
 */
export function checkQuote(v: QuoteView, e: QuoteTerms): QuoteCheck {
  const no = (why: string): QuoteCheck => ({ ok: false, why });
  if (v.dry) return no("a preview, not a quote");
  if (v.originAsset !== e.from) return no(`coin in is ${v.originAsset}`);
  if (v.destinationAsset !== e.to) return no(`coin out is ${v.destinationAsset}`);
  if (v.recipient !== e.recipient.trim()) return no(`receiver is ${String(v.recipient)}`);
  if (v.recipientType !== e.recipientType) return no(`receiver type is ${v.recipientType}`);
  if (v.refundTo !== e.account || v.refundType !== "INTENTS") return no(`refund goes to ${String(v.refundTo)}`);
  if (e.amountIn !== undefined && v.amountIn !== e.amountIn) return no(`amount in is ${v.amountIn}`);
  const units = (t: string) => (/^\d{1,40}$/.test(t) ? BigInt(t) : null);
  const out = units(v.amountOut);
  const min = units(v.minAmountOut);
  if (out === null || min === null || out <= 0n || min <= 0n || min > out) return no(`amounts out are ${v.amountOut} and ${v.minAmountOut}`);
  if (min * 10_000n < out * BigInt(10_000 - SLIPPAGE_BPS) - 10_000n) return no(`the minimum ${v.minAmountOut} gives more than 1% away`);
  const seen = e.seen ? units(e.seen) : null;
  if (seen !== null && seen > 0n && min * 10_000n < seen * BigInt(10_000 - MAX_DRIFT_BPS)) return { ok: false, why: "the price moved", moved: true };
  return { ok: true };
}
