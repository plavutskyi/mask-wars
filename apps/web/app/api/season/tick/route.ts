import { fromCron, tick, tickNeeds } from '@/lib/season';

// The daily round's clock (lib/season): Vercel Cron calls this on the minutes in vercel.json, and the tick starts the
// Season workflow on GitHub when the slot has no run that holds. Only Vercel's own call, with CRON_SECRET, gets in.
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
  const result = await tick();
  console.log(`season tick: ${JSON.stringify(result)}`);
  return Response.json(result, { status: result.kind === 'failed' ? 502 : 200, headers: HEADERS });
}
