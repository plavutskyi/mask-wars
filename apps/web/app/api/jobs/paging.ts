// One page of the jobs board for the open API: the board's own totals, and a bounded slice of its jobs.
import type { JobBoard } from '@maskwars/arena/jobs';

export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 50;

export interface JobsPage extends JobBoard {
  /** Which jobs of the board this answer holds, and where the next page starts; `next` is `null` on the last page. */
  readonly page: { readonly offset: number; readonly limit: number; readonly shown: number; readonly of: number; readonly next: number | null };
}

function whole(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null || !/^\d{1,9}$/.test(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

/**
 * The board with `limit` of its jobs from `offset`, in the board's own order (open jobs first, by reward). A query the
 * API cannot read falls back to the first page: the answer is never the whole list.
 */
export function pageOf(board: JobBoard, offset: string | null, limit: string | null): JobsPage {
  const size = whole(limit, PAGE_DEFAULT, 1, PAGE_MAX);
  const from = whole(offset, 0, 0, board.jobs.length);
  const jobs = board.jobs.slice(from, from + size);
  const next = from + jobs.length < board.jobs.length ? from + jobs.length : null;
  return { ...board, jobs, page: { offset: from, limit: size, shown: jobs.length, of: board.jobs.length, next } };
}
