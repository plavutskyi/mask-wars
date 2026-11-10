import {
  checkQuote,
  depositUnits,
  topUpRequest,
  usdOf,
  vaultAccountOk,
  type Coin,
  type QuoteCheck,
  type QuoteRequest,
  type QuoteResponse,
  type QuoteView,
} from "@maskwars/pay";
import type { Job } from "./job.ts";

/**
 * Where a job's money goes, and the one place that says so. The payer sends a coin from any network to a 1Click deposit
 * address; 1Click swaps it to NEAR and credits the team's own account in NEAR Intents, the same vault `/wallet` opens.
 * A swap that cannot go through comes back to that vault too. The request is the vault top-up of `@maskwars/pay`,
 * byte for byte: the team's vault is the receiver and the refund address, so no one else's account is ever in it.
 *
 * Today the money is the team's own NEAR in its vault, with the job's note (its id and hash, kept with the deposit
 * address) beside it. When the job contract lands, this is the one function that changes its receiver to the job
 * itself, and `checkHire` below reads that receiver back the same way.
 *
 * `fee`: the site's cut through 1Click's `appFees`, in basis points to one NEAR Intents account; none unless the owner
 * sets `HIRE_FEE_BPS` and `HIRE_FEE_ACCOUNT`.
 */
export function hireRequest(o: { job: Pick<Job, "team">; from: Coin; usd: number; dry: boolean; fee?: HireFee | null; now?: Date }): {
  request: HireQuoteRequest;
  units: bigint;
} {
  if (o.from.chain === "near") throw new Error("a job is paid from another network");
  const units = depositUnits(o.usd, o.from);
  if (units <= 0n) throw new Error("amount too small");
  const request = topUpRequest({ account: o.job.team, from: o.from, amount: units, dry: o.dry, ...(o.now ? { now: o.now } : {}) });
  return { request: o.fee ? { ...request, appFees: [{ recipient: o.fee.account, fee: o.fee.bps }] } : request, units };
}

/** The site's cut of a hire, as 1Click's `appFees` takes it. */
export interface HireFee {
  readonly bps: number;
  readonly account: string;
}

/** A top-up request, with the site's cut when there is one. */
export type HireQuoteRequest = QuoteRequest & { readonly appFees?: readonly { readonly recipient: string; readonly fee: number }[] };

/** The most the cut may be: 3%. Above it the read-back's floor for what lands would no longer hold. */
export const FEE_MAX_BPS = 300;

/** The cut from the owner's settings: whole basis points from 1 to 300 and a mainnet account, or none at all. */
export function feeOf(bps: string | undefined, account: string | undefined): HireFee | null {
  const n = bps && /^\d{1,3}$/.test(bps.trim()) ? Number(bps.trim()) : 0;
  const a = (account ?? "").trim().toLowerCase();
  return n >= 1 && n <= FEE_MAX_BPS && vaultAccountOk(a) ? { bps: n, account: a } : null;
}

/** Whether 1Click took the request with exactly this cut, to this account, and no other. */
export function feeHeld(q: QuoteResponse, fee: HireFee | null): boolean {
  const got = (q.quoteRequest as HireQuoteRequest).appFees ?? [];
  if (!fee) return got.length === 0;
  return got.length === 1 && got[0]!.recipient === fee.account && got[0]!.fee === fee.bps;
}

/** How far the coin a payer is asked to send may sit from the dollars they agreed to: rounding, and prices a minute apart. */
export const SEND_DRIFT = 0.05;
/** The least the NEAR promised may be worth against those dollars: 1Click's fee, 1% slippage, and prices a minute apart. */
export const LAND_FLOOR = 0.9;

/**
 * Reads a quote back before its deposit address is shown: on the server before the address leaves it, and again in the
 * checkout. It holds the quote to what the payer agreed to, so a bug on our side or a 1Click answer that is not what was
 * asked never reaches a payer: everything `checkQuote` checks for a vault top-up (this coin in, NEAR out, the team's
 * vault as receiver and refund address, a minimum that honors 1% and has not slid from the preview), a deposit floor
 * no higher than the amount shown, and the two amounts against the dollars agreed: what to send, and what lands.
 */
export function checkHire(v: QuoteView, o: { job: Job; from: Coin; near: Coin; usd: number; seen?: string | null }): QuoteCheck {
  const base = checkQuote(v, {
    account: o.job.team,
    from: o.from.assetId,
    to: o.near.assetId,
    recipient: o.job.team,
    recipientType: "INTENTS",
    seen: o.seen ?? null,
  });
  if (!base.ok) return base;
  if (!v.depositAddress) return { ok: false, why: "no deposit address" };
  if (!/^\d{1,40}$/.test(v.amountIn) || !/^\d{1,40}$/.test(v.minAmountIn) || !/^\d{1,40}$/.test(v.minAmountOut))
    return { ok: false, why: "amounts are not units" };
  // The payer sends exactly the amount shown; a floor above it would refund them for sending what they were told.
  if (BigInt(v.minAmountIn) > BigInt(v.amountIn)) return { ok: false, why: `needs at least ${v.minAmountIn}, shows ${v.amountIn}` };
  const send = usdOf(v.amountIn, o.from.decimals, o.from.price);
  if (Math.abs(send - o.usd) > o.usd * SEND_DRIFT) return { ok: false, why: `asks for ${send.toFixed(2)} dollars, not ${o.usd}` };
  const lands = usdOf(v.minAmountOut, o.near.decimals, o.near.price);
  if (lands < o.usd * LAND_FLOOR) return { ok: false, why: "the price moved", moved: true };
  return { ok: true };
}
