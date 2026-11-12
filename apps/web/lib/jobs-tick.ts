// The masks' clock on the jobs market. A job a person posts on /jobs works for 20 to 40 minutes and reveals for 30,
// and GitHub starts the Jobs workflow's own quarter-hour schedule late on a quiet repository, by hours or not at all
// (lib/season.ts). So the site keeps this time too: Vercel Cron calls GET /api/jobs-tick on the minutes in vercel.json,
// the tick reads the board as every page does, with no key, and asks GitHub to run Jobs now (workflow_dispatch with
// `tick`, the schedule's own run: it waits for JOBS_LIVE and for nobody's yes) when the arena's masks have something to
// move now: a drain on one of our rounds that takes masks, a step of theirs to reveal, a round that ended under a job
// of theirs, a verdict to pay. It starts nothing while a Jobs run waits in the queue already: that run reads the board
// afresh when it starts. Same secrets as the daily round's clock: CRON_SECRET and SEASON_DISPATCH_TOKEN.
import { OVER, outsideRules, outsideTermsBar, type Job, type JobBoard } from '@maskwars/arena/jobs';
import { NET, bountyContracts, teams, type Network } from '@maskwars/network';
import { SEASON_REPO } from './season';

type Env = Record<string, string | undefined>;

export const JOBS_WORKFLOW = 'jobs.yml';
/** A mask seals no step this close to the end of a work window (packages/race/src/work.ts, `STEP_MARGIN_MS`). */
const STEP_MARGIN_MS = 2 * 60_000;
const API = 'https://api.github.com';
/** A run that has not started yet: GitHub's own words for a run in the queue. */
const WAITING = new Set(['queued', 'waiting', 'pending', 'requested']);

export type JobsTick =
  /** A run was asked for: the masks have something to move now and no run waits for it. */
  | { kind: 'started'; why: string }
  /** A Jobs run waits in the queue already: it reads the board when it starts. */
  | { kind: 'on'; why: string; run: string }
  /** Nothing for the masks to move now. */
  | { kind: 'waiting'; why: string }
  /** GitHub did not answer as it should; the next tick tries again. */
  | { kind: 'failed'; why: string };

/** The arena's masks seated on a job now: those that left are not. */
const ourSeats = (job: Job, masks: readonly string[]) => job.entrants.flatMap((e) => e.members.filter((m) => !m.left && masks.includes(m.mask.account)).map((m) => m.mask.account));

/**
 * What the arena's masks can move now on this board, in a few words, or null. The same phases the masks' own plan
 * reads (packages/race/src/work.ts), coarsely: a run starts and its pass decides exactly. A job from outside that its
 * own terms keep from them (`outsideTermsBar`, the bar the plan itself reads: the reward, the bond, the windows)
 * starts nothing, however many of those anyone posts.
 */
export function jobsDue(board: JobBoard, now: number, net: Pick<Network, 'admin' | 'season' | 'house' | 'bounty' | 'older_bounty' | 'masks' | 'limits' | 'round'> = NET): string | null {
  if (!board.deployed || board.stale) return null;
  const masks = Object.values(net.masks);
  const ours = teams(net as Network);
  const bounties = bountyContracts(net as Network);
  const rules = outsideRules(net);
  for (const job of board.jobs) {
    if (OVER.has(job.phase)) continue;
    const seated = ourSeats(job, masks);
    if (job.phase === 'enlisting' && job.kind === 'drain' && job.judge.by === 'round') {
      const onOurRound = bounties.includes(job.judge.bounty) && job.judge.state === 'open';
      const fits = ours.includes(job.client) || outsideTermsBar(job, rules) === null;
      const open = now < job.workUntil - STEP_MARGIN_MS;
      // A mask of ours on it with no step yet seals it; a job none of ours is on yet may take them.
      const unsealed = seated.some((m) => !job.steps.some((s) => s.mask.account === m));
      if (open && onOurRound && ((job.room && fits && seated.length === 0) || unsealed)) return `${job.id} takes masks until ${new Date(job.workUntil).toISOString().slice(11, 16)} UTC`;
      continue;
    }
    if (seated.length === 0) continue;
    if (job.phase === 'revealing' && job.steps.some((s) => masks.includes(s.mask.account) && !s.revealed)) return `the masks reveal their steps on ${job.id}`;
    if (job.phase === 'waiting') {
      const strike = job.steps.some((s) => s.role === 'striker' && s.revealed && s.copyOf === null);
      const over = job.judge.by === 'round' && ['drained', 'paid', 'refunded'].includes(job.judge.state ?? '');
      if (!strike || now >= job.judgeUntil || over) return `${job.id} waits for its judge`;
    }
    if (job.phase === 'decided' && job.verdict && (job.verdict.final || (job.verdict.appealUntil !== null && now >= job.verdict.appealUntil))) return `${job.id} is decided: it pays`;
  }
  return null;
}

export interface JobsTickOptions {
  /** The board as the site reads it now. */
  board: () => Promise<JobBoard>;
  env?: Env;
  fetch?: typeof fetch;
  now?: () => number;
  net?: Parameters<typeof jobsDue>[2];
  /** How long one call to GitHub may take. Default 10 s. */
  timeoutMs?: number;
}

interface Run {
  html_url: string;
  status: string;
}

/** One tick: reads the board, and starts Jobs when the masks can move something and no run of it waits already. */
export async function jobsTick(options: JobsTickOptions): Promise<JobsTick> {
  const env = options.env ?? process.env;
  const get = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let board: JobBoard;
  try {
    board = await options.board();
  } catch (e) {
    return { kind: 'failed', why: `the board could not be read: ${(e as Error).message}` };
  }
  const due = jobsDue(board, board.readAt || (options.now ?? Date.now)(), options.net);
  if (!due) return { kind: 'waiting', why: board.deployed ? 'nothing for the masks to move now' : 'the jobs contract is not on chain' };
  const repo = (env.SEASON_REPO ?? '').trim() || SEASON_REPO;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${(env.SEASON_DISPATCH_TOKEN ?? '').trim()}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'maskwars-jobs-tick',
  };
  const base = `${API}/repos/${repo}/actions/workflows/${JOBS_WORKFLOW}`;
  try {
    const res = await get(`${base}/runs?per_page=20`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { kind: 'failed', why: `GitHub answered ${res.status} to the list of runs` };
    const body = (await res.json()) as { workflow_runs?: Run[] };
    const queued = (body.workflow_runs ?? []).find((r) => WAITING.has(r.status));
    if (queued) return { kind: 'on', why: due, run: queued.html_url };
  } catch (e) {
    return { kind: 'failed', why: `GitHub did not answer the list of runs: ${(e as Error).message}` };
  }
  try {
    const res = await get(`${base}/dispatches`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { tick: 'true' } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 204 && res.status !== 200) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      return { kind: 'failed', why: `GitHub answered ${res.status} to the start${text ? `: ${text}` : ''}` };
    }
  } catch (e) {
    return { kind: 'failed', why: `GitHub did not answer the start: ${(e as Error).message}` };
  }
  return { kind: 'started', why: due };
}
