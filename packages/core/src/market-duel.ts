/**
 * Market Duel v1 (spec «Market Duel v1»).
 *
 * - Basket: BTC, ETH, SOL, NEAR, ZEC.
 * - Before the bell each mask seals `primary`, `backup` (≠ primary) and `call` (its guess of the rival's coin).
 * - Same primary: the low bit of the first byte of `sha256(fight_id)` names the side that takes its backup
 *   (0 the left corner, 1 the right).
 * - ROTATE: once a fight. Every minute (1:00, 2:00, 3:00, 4:00) a call HOLD or ROTATE to another coin of the basket.
 * - 5 minutes between the bells. LAST CALL opens at 2:30, closes at 3:30; backs of the last 30 s are sealed.
 *
 *   score_bp = floor((final_usdc − start_usdc) · 10000 / start_usdc) + (25 if call == the rival's effective primary)
 *
 * The bigger `score_bp` wins; equal is VOID.
 */

import type { Discipline, Judgement, Side } from "./discipline.ts";
import { CoreError } from "./errors.ts";
import { BPS, floorDiv } from "./math.ts";
import { sha256, utf8 } from "./sha256.ts";

export const BASKET = ["BTC", "ETH", "SOL", "NEAR", "ZEC"] as const;
export type Coin = (typeof BASKET)[number];
export const isCoin = (x: unknown): x is Coin => typeof x === "string" && (BASKET as readonly string[]).includes(x);

export const DUEL = {
  lengthMs: 300_000,
  /** BACK on the main book closes this long before the bell. */
  bookCloseBeforeBellMs: 30_000,
  lastCallOpenMs: 150_000,
  lastCallSealedMs: 180_000,
  lastCallCloseMs: 210_000,
  /** Minutes after the bell with a HOLD / ROTATE call. */
  decisionMinutes: [1, 2, 3, 4] as readonly number[],
  calledItBp: 25n,
} as const;

export type DuelMove = { primary: Coin; backup: Coin; call: Coin };

export type DuelAction = { kind: "HOLD" } | { kind: "ROTATE"; to: Coin };

export type DuelState = {
  fightId: string;
  moves: readonly [DuelMove, DuelMove];
  /** The coin each side enters with after the same-primary rule. */
  entry: readonly [Coin, Coin];
  /** The coin each side holds now. */
  holding: readonly [Coin, Coin];
  calledIt: readonly [boolean, boolean];
  rotated: readonly [boolean, boolean];
  /** Minutes each side has already called. */
  decided: readonly [readonly number[], readonly number[]];
};

/** USDC of each side in minimal units, at the start and after the exit swaps. */
export type DuelFinal = { startUsdc: readonly [bigint, bigint]; finalUsdc: readonly [bigint, bigint] };

/** The side that takes its backup when both seal the same primary: the low bit of `sha256(fight_id)[0]`. */
export function samePrimaryLoser(fightId: string): Side {
  return (sha256(utf8(fightId))[0]! & 1) as Side;
}

/** The coins both sides enter with. */
export function effectivePrimaries(fightId: string, moves: readonly [DuelMove, DuelMove]): [Coin, Coin] {
  const entry: [Coin, Coin] = [moves[0].primary, moves[1].primary];
  if (entry[0] === entry[1]) {
    const side = samePrimaryLoser(fightId);
    entry[side] = moves[side].backup;
  }
  return entry;
}

/** `floor((final − start) · 10000 / start)` plus 25 for CALLED IT. */
export function scoreBp(startUsdc: bigint, finalUsdc: bigint, calledIt: boolean): bigint {
  if (startUsdc <= 0n) throw new CoreError("bad_amount", "start_usdc is positive");
  if (finalUsdc < 0n) throw new CoreError("bad_amount", "final_usdc is not negative");
  return floorDiv((finalUsdc - startUsdc) * BPS, startUsdc) + (calledIt ? DUEL.calledItBp : 0n);
}

export type LastCallPhase = "before" | "open" | "sealed" | "closed";

/** Where LAST CALL is, `elapsedMs` after the bell. */
export function lastCallPhase(elapsedMs: number): LastCallPhase {
  if (elapsedMs < DUEL.lastCallOpenMs) return "before";
  if (elapsedMs < DUEL.lastCallSealedMs) return "open";
  if (elapsedMs < DUEL.lastCallCloseMs) return "sealed";
  return "closed";
}

function parseMove(raw: unknown): DuelMove {
  if (typeof raw !== "object" || raw === null) throw new CoreError("bad_move", "a move is { primary, backup, call }");
  const { primary, backup, call } = raw as Record<string, unknown>;
  if (!isCoin(primary) || !isCoin(backup) || !isCoin(call)) throw new CoreError("bad_move", "every coin is from the basket");
  if (backup === primary) throw new CoreError("bad_move", "backup differs from primary");
  return { primary, backup, call };
}

function sealFields(raw: unknown): string[] {
  const { primary, backup, call } = (raw ?? {}) as Record<string, unknown>;
  return [String(primary), String(backup), String(call)];
}

function start(fightId: string, moves: readonly [DuelMove, DuelMove]): DuelState {
  const entry = effectivePrimaries(fightId, moves);
  return {
    fightId,
    moves,
    entry,
    holding: entry,
    calledIt: [moves[0].call === entry[1], moves[1].call === entry[0]],
    rotated: [false, false],
    decided: [[], []],
  };
}

function act(state: DuelState, side: Side, action: DuelAction, elapsedMs: number): DuelState {
  const minute = Math.floor(elapsedMs / 60_000);
  if (elapsedMs < 0 || !DUEL.decisionMinutes.includes(minute)) {
    throw new CoreError("no_decision_now", "HOLD or ROTATE is called at 1:00, 2:00, 3:00 or 4:00");
  }
  if (state.decided[side].includes(minute)) throw new CoreError("already_decided", `minute ${minute} is already called`);
  const decided = pair(state.decided, side, [...state.decided[side], minute]);
  if (action.kind === "HOLD") return { ...state, decided };
  if (state.rotated[side]) throw new CoreError("rotate_used", "ROTATE is once a fight");
  if (!isCoin(action.to) || action.to === state.holding[side]) {
    throw new CoreError("bad_move", "ROTATE goes to another coin of the basket");
  }
  return { ...state, decided, holding: pair(state.holding, side, action.to), rotated: pair(state.rotated, side, true) };
}

function judge(state: DuelState, final: DuelFinal): Judgement {
  const scores = [
    scoreBp(final.startUsdc[0], final.finalUsdc[0], state.calledIt[0]),
    scoreBp(final.startUsdc[1], final.finalUsdc[1], state.calledIt[1]),
  ] as const;
  const winner: Side | null = scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1;
  return { winner, scores };
}

function pair<T>(p: readonly [T, T], side: Side, value: T): [T, T] {
  const out: [T, T] = [p[0], p[1]];
  out[side] = value;
  return out;
}

export const marketDuel: Discipline<DuelMove, DuelState, DuelAction, DuelFinal> = {
  id: "market-duel-v1",
  lengthMs: DUEL.lengthMs,
  lastCall: { openMs: DUEL.lastCallOpenMs, sealedMs: DUEL.lastCallSealedMs, closeMs: DUEL.lastCallCloseMs },
  parseMove,
  sealFields,
  start,
  act,
  judge,
};
