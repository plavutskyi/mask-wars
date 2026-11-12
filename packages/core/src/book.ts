/**
 * Book: one parimutuel pool over outcomes `0..n-1` (packages/core/README.md, "Book"). A fight has `main` and `last_call` (2 outcomes
 * each); the season pool WHO'S UNDER is a 6-outcome book bound to a mask, not to a fight.
 *
 *   T = all stakes, W = stakes on the winner
 *   VOID if W == 0 or W == T
 *   rake = min(floor(T * rake_bps / 10000), T - W)
 *   D = T - rake
 *   payout = floor(D * stake / W)          — per back (per op_id)
 *   dust = D - Σ payouts                   — goes to the rake
 *
 * Since rake ≤ T − W, D ≥ W and every winning back gets at least its stake.
 *
 * Immutable: every function returns a new book. Pure: no clock, no network.
 */

import { CoreError } from "./errors.ts";
import { assertOpId } from "./ids.ts";
import { BPS, minBig } from "./math.ts";

export const DEFAULT_RAKE_BPS = 500;
/** Of `T`, credited to the winning mask out of the rake (spec: 100 b.p.). */
export const MASK_SHARE_BPS = 100;

export type BookKind = "main" | "last_call" | "season";

export type Back = {
  opId: string;
  account: string;
  outcome: number;
  /** Minimal units of USDC (6 decimals). */
  amount: bigint;
  /** The league's own seed back: an ordinary back, flagged in events. */
  seed: boolean;
  /** LAST CALL: a back taken in the last 30 s. It counts in full, but the screen leaves it out until the bell. */
  sealed: boolean;
};

export type Book = {
  readonly id: string;
  readonly kind: BookKind;
  readonly outcomes: number;
  /** Snapshot when the book opened. */
  readonly rakeBps: number;
  readonly open: boolean;
  readonly backs: readonly Back[];
};

export type BackInput = Omit<Back, "seed" | "sealed"> & Partial<Pick<Back, "seed" | "sealed">>;

export function openBook(params: { id: string; kind: BookKind; outcomes: number; rakeBps?: number }): Book {
  const rakeBps = params.rakeBps ?? DEFAULT_RAKE_BPS;
  if (!Number.isInteger(params.outcomes) || params.outcomes < 2) throw new CoreError("bad_outcome", "a book has at least 2 outcomes");
  if (!Number.isInteger(rakeBps) || rakeBps < 0 || rakeBps > 10_000) throw new CoreError("bad_amount", "rake_bps is 0..10000");
  return { id: params.id, kind: params.kind, outcomes: params.outcomes, rakeBps, open: true, backs: [] };
}

/**
 * Takes one back. A repeated `op_id` with the same content changes nothing (a replayed batch gives the same sums); with
 * other content it is refused.
 */
export function addBack(book: Book, input: BackInput): Book {
  assertOpId(input.opId);
  const back: Back = { ...input, seed: input.seed ?? false, sealed: input.sealed ?? false };
  const known = book.backs.find((b) => b.opId === back.opId);
  if (known) {
    if (sameBack(known, back)) return book;
    throw new CoreError("duplicate_op_id", `op_id ${back.opId} is already counted with other content`);
  }
  if (!book.open) throw new CoreError("book_closed", `book ${book.id} is closed`);
  if (!Number.isInteger(back.outcome) || back.outcome < 0 || back.outcome >= book.outcomes) {
    throw new CoreError("bad_outcome", `outcome ${back.outcome} is outside 0..${book.outcomes - 1}`);
  }
  if (typeof back.amount !== "bigint" || back.amount <= 0n) throw new CoreError("bad_amount", "a stake is a positive integer");
  return { ...book, backs: [...book.backs, back] };
}

const sameBack = (a: Back, b: Back): boolean =>
  a.account === b.account && a.outcome === b.outcome && a.amount === b.amount && a.seed === b.seed && a.sealed === b.sealed;

export const closeBook = (book: Book): Book => (book.open ? { ...book, open: false } : book);

/** Stakes per outcome. `includeSealed: false` leaves out the backs the screen does not show yet. */
export function totals(book: Book, includeSealed = true): bigint[] {
  const sums = Array.from({ length: book.outcomes }, () => 0n);
  for (const back of book.backs) if (includeSealed || !back.sealed) sums[back.outcome]! += back.amount;
  return sums;
}

export const pot = (book: Book): bigint => totals(book).reduce((a, b) => a + b, 0n);

export type Payout = { opId: string; account: string; amount: bigint };

export type Settlement =
  | {
      kind: "paid";
      bookId: string;
      winner: number;
      T: bigint;
      W: bigint;
      /** The capped rake before dust. */
      rake: bigint;
      D: bigint;
      payouts: Payout[];
      dust: bigint;
      /** rake + dust: everything the house keeps. */
      house: bigint;
      /** Credited to the winning mask, part of `house`. */
      maskShare: bigint;
    }
  | { kind: "void"; bookId: string; reason: VoidReason; T: bigint; refunds: Payout[] };

export type VoidReason = "no_winner_backs" | "one_sided" | "empty" | "fight_void";

/** The rake of a book if `winner` wins (the cap needs the winner's side). */
export function rakeFor(T: bigint, W: bigint, rakeBps: number): bigint {
  return minBig((T * BigInt(rakeBps)) / BPS, T - W);
}

/** Pays the book out on `winner`, or voids it when W == 0 or W == T. */
export function settle(book: Book, winner: number): Settlement {
  if (!Number.isInteger(winner) || winner < 0 || winner >= book.outcomes) {
    throw new CoreError("bad_outcome", `winner ${winner} is outside 0..${book.outcomes - 1}`);
  }
  const sums = totals(book);
  const T = sums.reduce((a, b) => a + b, 0n);
  const W = sums[winner]!;
  if (T === 0n) return voidBook(book, "empty");
  if (W === 0n) return voidBook(book, "no_winner_backs");
  if (W === T) return voidBook(book, "one_sided");

  const rake = rakeFor(T, W, book.rakeBps);
  const D = T - rake;
  const payouts: Payout[] = [];
  let paid = 0n;
  for (const back of book.backs) {
    if (back.outcome !== winner) continue;
    const amount = (D * back.amount) / W;
    payouts.push({ opId: back.opId, account: back.account, amount });
    paid += amount;
  }
  const dust = D - paid;
  const house = rake + dust;
  const maskShare = minBig((T * BigInt(MASK_SHARE_BPS)) / BPS, house);
  return { kind: "paid", bookId: book.id, winner, T, W, rake, D, payouts, dust, house, maskShare };
}

/** Every back gets exactly its stake, no rake. */
export function voidBook(book: Book, reason: VoidReason): Settlement {
  const refunds = book.backs.map((b) => ({ opId: b.opId, account: b.account, amount: b.amount }));
  return { kind: "void", bookId: book.id, reason, T: pot(book), refunds };
}

/**
 * Multipliers for the screen: `D / W_side` at the current sums, in hundredths rounded down (`250` is ×2.50); `null`
 * for a side nobody backed. `includeSealed: false` for LAST CALL before the bell.
 */
export function multipliers(book: Book, includeSealed = true): (number | null)[] {
  const sums = totals(book, includeSealed);
  const T = sums.reduce((a, b) => a + b, 0n);
  return sums.map((W) => {
    if (W === 0n) return null;
    const D = T - rakeFor(T, W, book.rakeBps);
    return Number((D * 100n) / W);
  });
}
