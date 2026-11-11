/**
 * The numbers of a round as the clip shows them: read from the round's record, written the way the site writes them.
 * Pure. The clip draws no number that is not here.
 *
 * The site shows what the winner took in all: what it drained from the vault and what the contract paid on top, cut
 * to the arena's digits and never rounded up (`near` of `@maskwars/arena`): 0.54 + 0.21186 reads `0.751`. The clip's
 * counter runs from the drain to exactly that.
 */

import { near } from "@maskwars/arena/format";
import { addNear, nearShort, toYocto } from "../race/near.ts";
import type { RaceRecord } from "../race/record.ts";

export type BreakNumbers = {
  /** The winner's name, as its mask is called: `ORACLE`. */
  winner: string;
  /** NEAR out of the vault: `0.54`. */
  drained: string;
  /** NEAR the contract paid on top, as the record holds it: `0.21186`. */
  paid: string;
  /** Both, as the site shows the round's sum: `0.751`. */
  total: string;
  /** The same three in yoctoNEAR, for the counter. */
  yocto: { drained: bigint; paid: bigint; total: bigint };
  /** `NEAR MAINNET · 10 NOV`: the network and the day of the drain, UTC. No LIVE: this is a recording. */
  stamp: string;
};

export function breakNumbers(r: RaceRecord): BreakNumbers {
  const drained = toYocto(r.drain.amount);
  const paid = toYocto(r.payout.amount);
  const total = toYocto(addNear(r.drain.amount, r.payout.amount));
  const day = new Date(r.drain.at).toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" }).split(" ");
  return {
    winner: r.winner,
    drained: near(drained),
    paid: nearShort(r.payout.amount),
    total: near(total),
    yocto: { drained, paid, total },
    stamp: `NEAR ${r.network === "mainnet" ? "MAINNET" : "TESTNET"} · ${day[1]} ${day[0]!.toUpperCase()}`,
  };
}

/** How many decimals the arena shows for a sum of this size (`near`): the counter keeps that many while it runs. */
function decimalsOf(text: string): number {
  return text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
}

/**
 * The counter between the drain and the total at `k` in 0…1. It never shows more than the round holds, keeps its
 * width while it runs (`0.600`, not `0.6`), and at 1 it is the total exactly as the site writes it.
 */
export function countTo(n: BreakNumbers, k: number): string {
  if (k >= 1) return n.total;
  if (k <= 0) return n.drained;
  const places = Math.max(decimalsOf(n.total), decimalsOf(n.drained));
  const scale = 1_000_000n;
  const at = n.yocto.drained + (n.yocto.paid * BigInt(Math.floor(k * Number(scale)))) / scale;
  // Cut, never rounded: the arena's own rule.
  const unit = 10n ** BigInt(24 - places);
  const digits = (at / unit).toString().padStart(places + 1, "0");
  return places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
}
