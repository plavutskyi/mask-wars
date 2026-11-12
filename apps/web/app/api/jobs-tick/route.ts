import { readEveryJob } from '@/app/jobs/reader';
import { jobsTick } from '@/lib/jobs-tick';
import { fromCron, tickNeeds } from '@/lib/season';

// The masks' clock on the jobs market (lib/jobs-tick): Vercel Cron calls this on the minutes in vercel.json, and the
// tick starts the Jobs workflow on GitHub when the board shows the arena's masks something to move now and no run of
// it waits already. Only Vercel's own call, with CRON_SECRET, gets in; the same secrets as /api/season/tick.
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const HEADERS = { 'cache-control': 'no-store' };

export async function GET(req: Request) {
  const needs = tickNeeds();
  if (needs.some((need) => need.startsWith('CRON_SECRET'))) {
    return Response.json({ open: false, needs: needs.map((need) => need.split(':')[0]) }, { status: 503, headers: HEADERS });
  }
  if (!fromCron(req)) return Response.json({ error: 'not the site clock' }, { status: 401, headers: HEADERS });
  if (needs.length > 0) return Response.json({ open: false, needs: needs.map((need) => need.split(':')[0]) }, { status: 503, headers: HEADERS });
  // Every job the masks may still be on, not the newest sixty alone: nothing anyone opens keeps their run from starting.
  const result = await jobsTick({ board: readEveryJob });
  console.log(`jobs tick: ${JSON.stringify(result)}`);
  return Response.json(result, { status: result.kind === 'failed' ? 502 : 200, headers: HEADERS });
}
