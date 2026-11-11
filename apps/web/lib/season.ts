// The clock the daily round keeps. GitHub starts the Season workflow's own cron late on a quiet repository, by hours
// or not at all: on the first day of the season the 18:04 and 19:04 starts never came and the 21:04 one came at 22:54.
// So the site keeps the time instead: Vercel Cron calls GET /api/season/tick on the minutes in vercel.json, and the
// tick asks GitHub to run Season now (workflow_dispatch with `tick`). A tick's run is the schedule's run: the house's
// step, which reads the chain first and repeats nothing, then the race.
//
// The tick starts nothing while the slot already has its run: one queued, running or green since the slot began. A run
// that went red is started again by the next tick, so a failed read of the RPC or of GitHub costs minutes, not the day.
//
// Closed until the owner sets, in Vercel:
// - CRON_SECRET: Vercel sends it with each cron call, and the tick refuses any call without it;
// - SEASON_DISPATCH_TOKEN: a fine-grained GitHub token for the public repository with Actions read and write. It can
//   start and read that repository's workflow runs and nothing else; it holds no NEAR key, and the run signs with the
//   house's key from its own environment there.
// - SEASON_REPO: another repository, for a test only.
import { timingSafeEqual } from 'node:crypto';
import { type HouseRound, NET, slotAt } from '@maskwars/network';

type Env = Record<string, string | undefined>;

/** The public repository, where Season runs and holds the house's key. */
export const SEASON_REPO = 'plavutskyi/mask-wars';
export const SEASON_WORKFLOW = 'season.yml';
/** Vercel sends CRON_SECRET as is; one shorter than this is refused as a secret anyone could guess. */
export const MIN_CRON_SECRET = 16;

const API = 'https://api.github.com';
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** What is still missing before the tick can start a run, by variable; empty when nothing is. */
export function tickNeeds(env: Env = process.env): string[] {
  const needs: string[] = [];
  const secret = (env.CRON_SECRET ?? '').trim();
  if (!secret) needs.push('CRON_SECRET: not set');
  else if (secret.length < MIN_CRON_SECRET) needs.push(`CRON_SECRET: shorter than ${MIN_CRON_SECRET} characters`);
  if (!(env.SEASON_DISPATCH_TOKEN ?? '').trim()) needs.push('SEASON_DISPATCH_TOKEN: not set');
  const repo = (env.SEASON_REPO ?? '').trim();
  if (repo && !REPO.test(repo)) needs.push('SEASON_REPO: not owner/name');
  return needs;
}

/** Whether the call carries `Authorization: Bearer <CRON_SECRET>`, as Vercel Cron sends it. Compared in constant time. */
export function fromCron(req: Request, env: Env = process.env): boolean {
  const secret = (env.CRON_SECRET ?? '').trim();
  if (secret.length < MIN_CRON_SECRET) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export type Tick =
  /** A run was asked for: the slot had none, or its runs all went red. */
  | { kind: 'started'; slot: string; why: string }
  /** The slot's run is queued, running or done green: nothing to start. */
  | { kind: 'on'; slot: string; run: string }
  /** Nothing is due: the round is not live on this network, or no slot has come. */
  | { kind: 'waiting'; why: string }
  /** GitHub did not answer as it should; the next tick tries again. */
  | { kind: 'failed'; why: string };

export interface TickOptions {
  env?: Env;
  fetch?: typeof fetch;
  now?: () => number;
  round?: Pick<HouseRound, 'live' | 'first_minute' | 'every_minutes'>;
  /** How long one call to GitHub may take. Default 10 s. */
  timeoutMs?: number;
}

interface Run {
  html_url: string;
  status: string;
  conclusion: string | null;
  created_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** One tick of the clock: reads the slot's runs on GitHub and starts Season when the slot has none that holds. */
export async function tick(options: TickOptions = {}): Promise<Tick> {
  const env = options.env ?? process.env;
  const get = options.fetch ?? fetch;
  const round = options.round ?? NET.round;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!round.live) return { kind: 'waiting', why: 'the round is not live on this network' };
  const slotMs = slotAt(round, (options.now ?? Date.now)());
  if (slotMs === null) return { kind: 'waiting', why: 'no slot has come yet' };
  const slot = iso(slotMs);
  const repo = (env.SEASON_REPO ?? '').trim() || SEASON_REPO;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${(env.SEASON_DISPATCH_TOKEN ?? '').trim()}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'maskwars-season-tick',
  };
  const base = `${API}/repos/${repo}/actions/workflows/${SEASON_WORKFLOW}`;

  let runs: Run[];
  try {
    const query = new URLSearchParams({ per_page: '20', created: `>=${slot}` });
    const res = await get(`${base}/runs?${query}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { kind: 'failed', why: `GitHub answered ${res.status} to the list of runs` };
    const body = (await res.json()) as { workflow_runs?: Run[] };
    runs = (body.workflow_runs ?? []).filter((r) => Date.parse(r.created_at) >= slotMs);
  } catch (e) {
    return { kind: 'failed', why: `GitHub did not answer the list of runs: ${(e as Error).message}` };
  }
  const holds = runs.find((r) => r.status !== 'completed' || r.conclusion === 'success');
  if (holds) return { kind: 'on', slot, run: holds.html_url };

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
  const last = runs[0];
  return { kind: 'started', slot, why: last ? `the slot's last run ended ${last.conclusion ?? last.status}` : 'the slot had no run yet' };
}
