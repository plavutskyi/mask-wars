import type { StatusResponse, SwapStatus, TxRef } from "./oneclick.ts";

/**
 * A swap as a person follows it. 1Click's seven statuses fold into what the screen says:
 *
 *   waiting   PENDING_DEPOSIT     nothing has arrived at the deposit address yet
 *   seen      KNOWN_DEPOSIT_TX    the transfer is on its way, the network is confirming it
 *   moving    PROCESSING          the swap is running
 *   done      SUCCESS             delivered
 *   short     INCOMPLETE_DEPOSIT  less than the minimum arrived; it is refunded
 *   refunded  REFUNDED            the swap did not go through; the coin went back to the refund address
 *   failed    FAILED              something broke; the correlation id is what support needs
 */
export type Stage = "waiting" | "seen" | "moving" | "done" | "short" | "refunded" | "failed";

const STAGE: Record<SwapStatus, Stage> = {
  PENDING_DEPOSIT: "waiting",
  KNOWN_DEPOSIT_TX: "seen",
  PROCESSING: "moving",
  SUCCESS: "done",
  INCOMPLETE_DEPOSIT: "short",
  REFUNDED: "refunded",
  FAILED: "failed",
};

/** A stage no swap leaves. INCOMPLETE_DEPOSIT is final for the swap; its refund follows on its own. */
export function final(stage: Stage): boolean {
  return stage === "done" || stage === "short" || stage === "refunded" || stage === "failed";
}

export interface Progress {
  readonly stage: Stage;
  readonly status: SwapStatus;
  readonly correlationId: string;
  readonly updatedAt: string;
  /** Units of the coin that arrived, once known. */
  readonly deposited: string | null;
  /** Units delivered, once the swap is done. */
  readonly amountOut: string | null;
  /** Units refunded and why, when the swap did not go through. */
  readonly refunded: string | null;
  readonly refundReason: string | null;
  /** The transfer's own transactions, where the person can watch them. */
  readonly txs: readonly TxRef[];
}

export function progressOf(r: StatusResponse): Progress {
  const stage = STAGE[r.status];
  if (!stage) throw new Error(`unknown status ${String(r.status)}`);
  const d = r.swapDetails ?? {};
  return {
    stage,
    status: r.status,
    correlationId: r.correlationId,
    updatedAt: r.updatedAt,
    deposited: d.depositedAmount ?? d.amountIn ?? null,
    amountOut: stage === "done" ? (d.amountOut ?? null) : null,
    refunded: d.refundedAmount && d.refundedAmount !== "0" ? d.refundedAmount : null,
    refundReason: d.refundReason ?? null,
    txs: [...(d.destinationChainTxHashes ?? []), ...(d.originChainTxHashes ?? [])].filter((t) => t && t.hash && /^https:\/\//.test(t.explorerUrl)),
  };
}

/** How long to wait before asking again: quick while a transfer is landing, calmer while nothing has arrived. */
export function pollDelay(stage: Stage, attempt: number): number {
  if (stage === "waiting") return Math.min(10_000, 3_000 + attempt * 500);
  return 2_500;
}
