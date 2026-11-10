/**
 * Fight: the state machine of the spec, one for every discipline.
 *
 *   OPEN → CLOSED → SEALED → LIVE → RESULT → PAID
 *                                         ↘ VOID (from any state before PAID)
 *
 * | state  | what happens                                    | leaves on                          |
 * | OPEN   | BACK on the main book                           | `closeMainBook`, 30 s before bell  |
 * | CLOSED | book closed, solvency checked, masks think      | both seals                         |
 * | SEALED | seals stored                                    | `ring` at the bell                 |
 * | LIVE   | reveal, play, LAST CALL, exit                   | `finish` / `expireReveals`         |
 * | RESULT | the winner is fixed, settlements computed       | `markPaid`                         |
 * | PAID   | all payouts made                                | —                                  |
 * | VOID   | every back gets exactly its stake, no rake      | —                                  |
 *
 * A step not allowed from the current state throws `IllegalTransitionError`. Time is always the `now` the caller
 * passes in (milliseconds); the core has no clock. Every function returns a new fight.
 */

import type { BackInput, Book, Settlement } from "./book.ts";
import { addBack, closeBook, openBook, pot, settle, voidBook } from "./book.ts";
import type { Discipline, Judgement, Side } from "./discipline.ts";
import { other } from "./discipline.ts";
import { CoreError, IllegalTransitionError } from "./errors.ts";
import { assertFightId, assertMaskId, assertSalt32 } from "./ids.ts";
import { fightSeal, sealMatches } from "./seal.ts";

export const FIGHT_STATES = ["OPEN", "CLOSED", "SEALED", "LIVE", "RESULT", "PAID", "VOID"] as const;
export type FightState = (typeof FIGHT_STATES)[number];

/** The allowed transitions, exactly as the spec draws them. */
export const TRANSITIONS: Readonly<Record<FightState, readonly FightState[]>> = {
  OPEN: ["CLOSED", "VOID"],
  CLOSED: ["SEALED", "VOID"],
  SEALED: ["LIVE", "VOID"],
  LIVE: ["RESULT", "VOID"],
  RESULT: ["PAID", "VOID"],
  PAID: [],
  VOID: [],
};

export const canTransition = (from: FightState, to: FightState): boolean => TRANSITIONS[from].includes(to);

/** The main book closes this long before the bell (spec: OPEN leaves 30 s before the bell). */
export const BOOK_CLOSE_BEFORE_BELL_MS = 30_000;

export type FightVoidReason =
  | "insolvent"
  | "missing_seal"
  | "no_reveal"
  | "tie"
  | "operator"
  | (string & {});

export type FightResult = {
  winner: Side;
  how: "score" | "forfeit";
  /** Present when the fight was judged on the score. */
  judgement: Judgement | null;
};

export type Fight<Move = unknown, Play = unknown> = {
  readonly id: string;
  readonly discipline: string;
  /** Left corner, right corner. */
  readonly corners: readonly [string, string];
  readonly bellAt: number;
  readonly closeAt: number;
  /** After the bell, the time both sides have to reveal. */
  readonly revealDeadline: number;
  readonly state: FightState;
  readonly main: Book;
  readonly lastCall: Book | null;
  /** Every op_id taken on any book of this fight: one op_id counts once. */
  readonly opIds: readonly string[];
  readonly seals: readonly [string | null, string | null];
  /** `revealed` holds a valid move; `forfeit` a seal that matched over a move the discipline refuses. */
  readonly reveals: readonly [Reveal<Move> | null, Reveal<Move> | null];
  readonly play: Play | null;
  readonly result: FightResult | null;
  readonly voidReason: FightVoidReason | null;
  readonly settlements: readonly Settlement[] | null;
};

export type Reveal<Move> = { kind: "revealed"; move: Move } | { kind: "forfeit"; reason: string };

export type FightParams = {
  id: string;
  corners: readonly [string, string];
  bellAt: number;
  /** How long after the bell both sides may reveal. */
  revealWindowMs: number;
  rakeBps?: number;
};

const ensure = (fight: Fight<any, any>, action: string, ...states: FightState[]): void => {
  if (!states.includes(fight.state)) throw new IllegalTransitionError(fight.state, action);
};

type Patch = { -readonly [K in keyof Fight<any, any>]?: Fight<any, any>[K] };

const move = <F extends Fight<any, any>>(fight: F, to: FightState, patch: Patch, action: string): F => {
  if (!canTransition(fight.state, to)) throw new IllegalTransitionError(fight.state, action);
  return { ...fight, ...patch, state: to };
};

export function createFight<Move, Play>(discipline: Discipline<Move, Play, any, any>, params: FightParams): Fight<Move, Play> {
  assertFightId(params.id);
  params.corners.forEach(assertMaskId);
  if (params.corners[0] === params.corners[1]) throw new CoreError("bad_id", "a mask does not fight itself");
  if (!Number.isFinite(params.bellAt) || !(params.revealWindowMs > 0)) throw new CoreError("bad_amount", "bad times");
  const bookParams = params.rakeBps === undefined ? {} : { rakeBps: params.rakeBps };
  return {
    id: params.id,
    discipline: discipline.id,
    corners: [params.corners[0], params.corners[1]],
    bellAt: params.bellAt,
    closeAt: params.bellAt - BOOK_CLOSE_BEFORE_BELL_MS,
    revealDeadline: params.bellAt + params.revealWindowMs,
    state: "OPEN",
    main: openBook({ id: `${params.id}/main`, kind: "main", outcomes: 2, ...bookParams }),
    lastCall: null,
    opIds: [],
    seals: [null, null],
    reveals: [null, null],
    play: null,
    result: null,
    voidReason: null,
    settlements: null,
  };
}

export const sideOf = (fight: Fight<any, any>, maskId: string): Side => {
  const i = fight.corners.indexOf(maskId);
  if (i < 0) throw new CoreError("unknown_mask", `${maskId} is not in ${fight.id}`);
  return i as Side;
};

function takeBack<F extends Fight<any, any>>(fight: F, which: "main" | "lastCall", book: Book, input: BackInput): F {
  const next = addBack(book, input);
  if (next === book) return fight; // the same op_id replayed
  if (fight.opIds.includes(input.opId)) throw new CoreError("duplicate_op_id", `op_id ${input.opId} is already counted`);
  return { ...fight, [which]: next, opIds: [...fight.opIds, input.opId] };
}

/** BACK on the main book: OPEN only, and only before `closeAt`. */
export function backMain<F extends Fight<any, any>>(fight: F, input: BackInput, now: number): F {
  ensure(fight, "back_main", "OPEN");
  if (now >= fight.closeAt) throw new CoreError("too_late", "the main book closes 30 s before the bell");
  return takeBack(fight, "main", fight.main, { ...input, sealed: false });
}

/** BACK on LAST CALL: LIVE, inside the window. A back of the sealed part is flagged `sealed`. */
export function backLastCall<F extends Fight<any, any>>(
  discipline: Discipline<any, any, any, any>,
  fight: F,
  input: BackInput,
  now: number,
): F {
  ensure(fight, "back_last_call", "LIVE");
  const window = discipline.lastCall;
  if (!window || !fight.lastCall) throw new CoreError("book_closed", `${discipline.id} has no LAST CALL`);
  const elapsed = now - fight.bellAt;
  if (elapsed < window.openMs) throw new CoreError("too_early", "LAST CALL is not open yet");
  if (elapsed >= window.closeMs) throw new CoreError("too_late", "LAST CALL is closed");
  return takeBack(fight, "lastCall", fight.lastCall, { ...input, sealed: elapsed >= window.sealedMs });
}

/**
 * OPEN → CLOSED at `closeAt`. `available` is what the contract holds for this fight (`mt_balance_of + in_flight_out`);
 * if it is below what the book owes (`T`), the fight is VOID.
 */
export function closeMainBook<F extends Fight<any, any>>(fight: F, now: number, available: bigint): F {
  ensure(fight, "close_book", "OPEN");
  if (now < fight.closeAt) throw new CoreError("too_early", "the main book closes 30 s before the bell");
  const main = closeBook(fight.main);
  if (available < pot(main)) return voidFight({ ...fight, main }, "insolvent");
  return move(fight, "CLOSED", { main }, "close_book");
}

/** A seal of one corner: CLOSED only, before the bell. The second seal moves the fight to SEALED. */
export function submitSeal<F extends Fight<any, any>>(fight: F, side: Side, seal: string, now: number): F {
  ensure(fight, "seal", "CLOSED");
  if (now >= fight.bellAt) throw new CoreError("too_late", "seals are in before the bell");
  if (!/^[0-9a-f]{64}$/.test(seal)) throw new CoreError("bad_move", "a seal is a sha256 in lower-case hex");
  if (fight.seals[side] !== null) throw new CoreError("already_sealed", `side ${side} has sealed`);
  const seals: [string | null, string | null] = [fight.seals[0], fight.seals[1]];
  seals[side] = seal;
  return seals[0] !== null && seals[1] !== null ? move(fight, "SEALED", { seals }, "seal") : { ...fight, seals };
}

/** The bell. SEALED → LIVE, LAST CALL book opens. A fight still waiting for a seal at the bell is VOID. */
export function ring<F extends Fight<any, any>>(discipline: Discipline<any, any, any, any>, fight: F, now: number): F {
  ensure(fight, "ring", "CLOSED", "SEALED");
  if (now < fight.bellAt) throw new CoreError("too_early", "the bell is at bellAt");
  if (fight.state === "CLOSED") return voidFight(fight, "missing_seal");
  const lastCall = discipline.lastCall
    ? openBook({ id: `${fight.id}/last_call`, kind: "last_call", outcomes: 2, rakeBps: fight.main.rakeBps })
    : null;
  return move(fight, "LIVE", { lastCall }, "ring");
}

/**
 * One corner reveals its move and salt. A reveal that does not match its seal is refused (the corner may still reveal
 * correctly before the deadline). A matching seal over a move the discipline refuses (a coin outside the basket,
 * backup = primary) forfeits that corner. When both have revealed, the play starts.
 */
export function reveal<Move, Play>(
  discipline: Discipline<Move, Play, any, any>,
  fight: Fight<Move, Play>,
  side: Side,
  raw: unknown,
  salt32: string,
  now: number,
): Fight<Move, Play> {
  ensure(fight, "reveal", "LIVE");
  if (now > fight.revealDeadline) throw new CoreError("too_late", "the reveal deadline has passed");
  if (fight.reveals[side] !== null) throw new CoreError("already_revealed", `side ${side} has revealed`);
  assertSalt32(salt32);
  const seal = fight.seals[side];
  if (seal === null) throw new CoreError("not_sealed", `side ${side} has no seal`);
  const fields = discipline.sealFields(raw);
  if (!sealMatches(seal, fightSeal(fight.id, fight.corners[side], fields, salt32))) {
    throw new CoreError("seal_mismatch", "the reveal does not match the seal");
  }
  let entry: Reveal<Move>;
  try {
    entry = { kind: "revealed", move: discipline.parseMove(raw) };
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    entry = { kind: "forfeit", reason: error.message };
  }
  const reveals: [Reveal<Move> | null, Reveal<Move> | null] = [fight.reveals[0], fight.reveals[1]];
  reveals[side] = entry;
  const next = { ...fight, reveals };
  const [a, b] = reveals;
  if (!a || !b) return next;
  if (a.kind === "forfeit" && b.kind === "forfeit") return voidFight(next, "no_reveal");
  if (a.kind === "forfeit") return forfeit(next, 1);
  if (b.kind === "forfeit") return forfeit(next, 0);
  return { ...next, play: discipline.start(fight.id, [a.move, b.move]) };
}

/**
 * After the reveal deadline with a reveal missing: the corner that revealed wins by forfeit; if neither did, VOID.
 */
export function expireReveals<F extends Fight<any, any>>(fight: F, now: number): F {
  ensure(fight, "expire_reveals", "LIVE");
  if (now <= fight.revealDeadline) throw new CoreError("too_early", "the reveal deadline has not passed");
  const ok = fight.reveals.map((r) => r?.kind === "revealed");
  if (ok[0] && ok[1]) throw new IllegalTransitionError(fight.state, "expire_reveals");
  if (ok[0]) return forfeit(fight, 0);
  if (ok[1]) return forfeit(fight, 1);
  return voidFight(fight, "no_reveal");
}

/** One action of one corner during the play (Market Duel: HOLD or ROTATE). */
export function act<Move, Play, Action>(
  discipline: Discipline<Move, Play, Action, any>,
  fight: Fight<Move, Play>,
  side: Side,
  action: Action,
  now: number,
): Fight<Move, Play> {
  ensure(fight, "act", "LIVE");
  if (fight.play === null) throw new CoreError("too_early", "the play starts when both have revealed");
  return { ...fight, play: discipline.act(fight.play, side, action, now - fight.bellAt) };
}

/** The closing bell: LIVE → RESULT on the score, or VOID on a tie. */
export function finish<Move, Play, Final>(
  discipline: Discipline<Move, Play, any, Final>,
  fight: Fight<Move, Play>,
  final: Final,
  now: number,
): Fight<Move, Play> {
  ensure(fight, "finish", "LIVE");
  if (fight.play === null) throw new CoreError("too_early", "the play has not started");
  if (now < fight.bellAt + discipline.lengthMs) throw new CoreError("too_early", "the closing bell has not rung");
  const judgement = discipline.judge(fight.play, final);
  if (judgement.winner === null) return voidFight(fight, "tie");
  return toResult(fight, { winner: judgement.winner, how: "score", judgement });
}

const forfeit = <F extends Fight<any, any>>(fight: F, winner: Side): F =>
  toResult(fight, { winner, how: "forfeit", judgement: null });

function toResult<F extends Fight<any, any>>(fight: F, result: FightResult): F {
  const { main, lastCall } = closedBooks(fight);
  const settlements = [main, ...(lastCall ? [lastCall] : [])].map((book) => settle(book, result.winner));
  return move(fight, "RESULT", { result, settlements, main, lastCall }, "result");
}

/** RESULT → PAID once every payout is made. */
export function markPaid<F extends Fight<any, any>>(fight: F): F {
  ensure(fight, "mark_paid", "RESULT");
  return move(fight, "PAID", {}, "mark_paid");
}

/** VOID from any state before PAID: every book refunds every back in full, no rake. */
export function voidFight<F extends Fight<any, any>>(fight: F, reason: FightVoidReason): F {
  if (!canTransition(fight.state, "VOID")) throw new IllegalTransitionError(fight.state, "void");
  const { main, lastCall } = closedBooks(fight);
  const settlements = [main, ...(lastCall ? [lastCall] : [])].map((book) => voidBook(book, "fight_void"));
  return move(fight, "VOID", { voidReason: reason, settlements, result: null, main, lastCall }, "void");
}

function closedBooks(fight: Fight<any, any>): { main: Book; lastCall: Book | null } {
  return { main: closeBook(fight.main), lastCall: fight.lastCall ? closeBook(fight.lastCall) : null };
}

/** The winner's corner as a book outcome, and the loser's: for screens and events. */
export const loserOf = (result: FightResult): Side => other(result.winner);
