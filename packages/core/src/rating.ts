/**
 * Rating: Elo kept apart for every discipline, Call% (how often a mask reads its rival), the Model Index (the same
 * Elo, kept for every model under the masks) and weight classes by the NEAR in a mask's vault.
 *
 *   expected   E = 1 / (1 + 10^((opponent − rating) / 400))
 *   update     rating += K · (score − E);  K = 48 for the first 10 fights, then 32
 *   info       info += (ln 10 / 400)² · E · (1 − E)
 *   interval   rating ± 1.96 / √(1 / 350² + info)
 *
 * A VOID fight moves no rating. Pure: no store, no clock, no network.
 */

import { CoreError } from "./errors.ts";

export const ELO = {
  start: 1_200,
  k: 32,
  provisionalK: 48,
  provisionalGames: 10,
  priorSd: 350,
  z: 1.96,
  floor: 100,
  ceiling: 3_900,
} as const;

const SLOPE = Math.LN10 / 400;

/** One rating row: one subject (a mask or a model) in one discipline. */
export type RatingRecord = {
  subject: string;
  discipline: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  info: number;
};

export const emptyRating = (subject: string, discipline: string): RatingRecord => ({
  subject,
  discipline,
  rating: ELO.start,
  games: 0,
  wins: 0,
  losses: 0,
  info: 0,
});

export const expectedScore = (rating: number, opponent: number): number => 1 / (1 + 10 ** ((opponent - rating) / 400));

/** One decided fight: 1 a win, 0 a loss. Returns the row after it. */
export function applyResult(row: RatingRecord, opponent: number, score: 0 | 1): RatingRecord {
  if (score !== 0 && score !== 1) throw new RangeError("a fight scores 1 or 0; a tie is VOID and is not rated");
  if (!Number.isFinite(opponent)) throw new RangeError("the opponent's rating is a number");
  const expected = expectedScore(row.rating, opponent);
  const k = row.games < ELO.provisionalGames ? ELO.provisionalK : ELO.k;
  return {
    ...row,
    rating: Math.min(ELO.ceiling, Math.max(ELO.floor, row.rating + k * (score - expected))),
    games: row.games + 1,
    wins: row.wins + score,
    losses: row.losses + (1 - score),
    info: row.info + SLOPE * SLOPE * expected * (1 - expected),
  };
}

/** Both rows after one fight, read against each other's rating before it. */
export function rateFight(winner: RatingRecord, loser: RatingRecord): [RatingRecord, RatingRecord] {
  if (winner.discipline !== loser.discipline) throw new CoreError("bad_id", "a fight is rated inside one discipline");
  return [applyResult(winner, loser.rating, 1), applyResult(loser, winner.rating, 0)];
}

export function interval(row: Pick<RatingRecord, "rating" | "info">): { sd: number; low: number; high: number } {
  const sd = 1 / Math.sqrt(1 / (ELO.priorSd * ELO.priorSd) + Math.max(0, row.info));
  return { sd, low: row.rating - ELO.z * sd, high: row.rating + ELO.z * sd };
}

export type RatingView = {
  subject: string;
  discipline: string;
  rating: number;
  low: number;
  high: number;
  games: number;
  wins: number;
  losses: number;
  provisional: boolean;
};

export function ratingView(row: RatingRecord): RatingView {
  const { low, high } = interval(row);
  return {
    subject: row.subject,
    discipline: row.discipline,
    rating: Math.round(row.rating),
    low: Math.round(low),
    high: Math.round(high),
    games: row.games,
    wins: row.wins,
    losses: row.losses,
    provisional: row.games < ELO.provisionalGames,
  };
}

/** CALLED IT: how many calls a mask made and how many hit the rival's coin. */
export type CallRecord = { calls: number; hits: number };

export const emptyCalls = (): CallRecord => ({ calls: 0, hits: 0 });

export const recordCall = (row: CallRecord, hit: boolean): CallRecord => ({ calls: row.calls + 1, hits: row.hits + (hit ? 1 : 0) });

/** Call% in basis points rounded down (`2000` is 20.00 %); `null` before the first call. Chance alone is 2000. */
export const callPercentBp = (row: CallRecord): number | null => (row.calls === 0 ? null : Math.floor((row.hits * 10_000) / row.calls));

export type ModelIndexEntry = RatingView & { rank: number };

/**
 * The Model Index of one discipline: model rows (subject = model id) by rating, highest first; equal ratings by more
 * games, then by name. Provisional rows are ranked too and flagged.
 */
export function modelIndex(rows: readonly RatingRecord[], discipline: string): ModelIndexEntry[] {
  return rows
    .filter((r) => r.discipline === discipline)
    .map(ratingView)
    .sort((a, b) => b.rating - a.rating || b.games - a.games || a.subject.localeCompare(b.subject))
    .map((view, i) => ({ ...view, rank: i + 1 }));
}

/** A weight class: its name and the least NEAR (yocto) a vault holds to be in it. */
export type WeightClass = { name: string; minYocto: bigint };

export const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * The class of a vault: the heaviest class whose floor it reaches, or `null` below the lightest. The bounds are the
 * league's call and are passed in (the spec does not fix them yet).
 */
export function weightClassOf(vaultYocto: bigint, classes: readonly WeightClass[]): string | null {
  if (vaultYocto < 0n) throw new CoreError("bad_amount", "a vault does not hold less than zero");
  let best: WeightClass | null = null;
  for (const c of classes) if (vaultYocto >= c.minYocto && (best === null || c.minYocto > best.minYocto)) best = c;
  return best?.name ?? null;
}
