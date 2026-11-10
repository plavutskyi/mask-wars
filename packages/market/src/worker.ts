// The pull channel: no inbound endpoint, just the agent's token. Every 30 seconds read the agent's assignments and work
// each one that is in progress. It is also the safety net behind the webhook: a missed or failed push is picked up on
// the next poll.
import { MarketError, type MarketClient } from "./client.ts";
import { type CheckFn, type Served, serveAssignment } from "./service.ts";

export interface PollDeps {
  client: MarketClient;
  check: CheckFn;
  log?: (line: string) => void;
  /**
   * A row started this recently is left alone: the webhook's 2xx stamps the start, so it is being worked there. Past
   * this, the poll takes it over. Default 60 s.
   */
  startGraceMs?: number;
  now?: () => number;
}

export type PollReport = Record<Served | "failed", number>;

/** One poll: every in-progress assignment, one after another. One failure does not stop the others. */
export async function pollOnce(deps: PollDeps, busy: Set<string> = new Set()): Promise<PollReport> {
  const report: PollReport = { submitted: 0, declined: 0, skipped: 0, failed: 0 };
  const { assignments } = await deps.client.assignments({ status: "in_progress", limit: 100 });
  const now = (deps.now ?? Date.now)();
  const grace = deps.startGraceMs ?? 60_000;
  for (const item of assignments) {
    const id = item.assignment.assignmentId;
    if (busy.has(id)) continue;
    const started = item.assignment.startedAt ? Date.parse(item.assignment.startedAt) : Number.NaN;
    if (now - started < grace && !item.assignment.submittedAt) {
      report.skipped++;
      continue;
    }
    busy.add(id);
    try {
      report[await serveAssignment(item, deps)]++;
    } catch (error) {
      report.failed++;
      deps.log?.(`failed  ${id}: ${error instanceof Error ? error.message : String(error)}; next poll tries again`);
    } finally {
      busy.delete(id);
    }
  }
  return report;
}

export interface WorkerOptions extends PollDeps {
  /** Default 30 s; the marketplace asks for 30–60 s. */
  intervalMs?: number;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Polls until the signal aborts. A failed poll waits and tries again, longer each time up to five minutes. A 401 ends
 * the loop: the token was revoked or mistyped, and waiting does not bring it back.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const interval = options.intervalMs ?? 30_000;
  const busy = new Set<string>();
  let backoff = interval;
  while (!options.signal?.aborted) {
    try {
      const r = await pollOnce(options, busy);
      if (r.submitted + r.declined + r.failed > 0) {
        options.log?.(`poll    ${r.submitted} delivered, ${r.declined} declined, ${r.failed} failed`);
      }
      backoff = interval;
    } catch (error) {
      if (error instanceof MarketError && error.status === 401) throw error;
      options.log?.(`poll    failed: ${error instanceof Error ? error.message : String(error)}`);
      backoff = Math.min(backoff * 2, 300_000);
    }
    await sleep(backoff, options.signal);
  }
}
