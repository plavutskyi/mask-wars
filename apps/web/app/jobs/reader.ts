// The one jobs reader of this server: the board, every job page, the jobs API and the agents' job tools at /mcp read
// the chain through it, so one reading serves them all for a few seconds. The jobs and crews contracts are the ones
// packages/network names for MASKWARS_NETWORK. JOBS_FIXTURE answers instead of the network, for local screenshots and
// checks with no RPC: a recorded answer file (`packages/arena/scripts/jobs-record.ts`), or `undeployed` / `deployed`
// for a board with no job (`emptyJobs`). A production deployment never reads it.
import { resolve } from 'node:path';
import { Jobs, RULES, jobsConfigFromEnv } from '@maskwars/arena/jobs';
import { emptyJobs, readRecording, replayJobs } from '@maskwars/arena/jobs/fixture';

let jobs: Jobs | null = null;

export function getJobs(): Jobs {
  if (jobs) return jobs;
  const fixture = process.env.VERCEL_ENV === 'production' ? undefined : process.env.JOBS_FIXTURE;
  if (fixture === 'undeployed' || fixture === 'deployed') {
    jobs = emptyJobs(fixture, jobsConfigFromEnv(process.env));
  } else if (fixture) {
    // Development only: the path is the developer's, so the build must not trace it.
    jobs = replayJobs(readRecording(resolve(/* turbopackIgnore: true */ process.cwd(), fixture)));
  } else {
    jobs = new Jobs({ config: jobsConfigFromEnv(process.env) });
  }
  return jobs;
}

/**
 * The newest jobs, read from the chain. When the chain does not answer, the last good reading comes back marked
 * `stale`: the pages show it with the time it was read at, and without LIVE.
 */
export async function readJobs() {
  return getJobs().board();
}

/** A day more than the longest any job lives by the contract's own windows: as far back as a job may still run. */
const LOOKBACK_MS = (RULES.maxJobHours + 24) * 3_600_000;

/**
 * The board with the drains its newest jobs pushed off it (`Jobs.older`), as the masks' own pass reads it
 * (packages/race/src/work.ts, `wholeBoard`). The masks' clock reads this one: a job the masks sit on starts their run
 * however many newer jobs anyone opened since. When the older jobs cannot be read, the board alone.
 */
export async function readEveryJob() {
  const reader = getJobs();
  const board = await reader.board();
  if (!board.deployed || board.stale || board.total <= board.jobs.length) return board;
  const on = new Set(board.jobs.map((j) => j.id));
  const older = (await reader.older(board, board.readAt - LOOKBACK_MS).catch(() => [])).filter((j) => !on.has(j.id));
  return older.length ? { ...board, jobs: [...board.jobs, ...older] } : board;
}
