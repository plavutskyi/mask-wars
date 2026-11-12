import { readHouseRound } from '@/app/jobs/round';
import { limited } from '@/lib/pay';

// GET /api/jobs-round: the house's round as the "Post a job" sheet needs it, read from the chain now: the round sealing
// now (its id and the end of its seal window) and the server's clock, so the sheet counts down from the server's time,
// not the device's. The sheet asks when it opens and once more right before a wallet signs. Kept apart from
// /api/jobs/<id>, where every name is a job's.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function GET(req: Request) {
  const busy = limited(req, 'jobs-round', 60);
  if (busy) return busy;
  try {
    return Response.json(await readHouseRound(), { headers: NO_STORE });
  } catch {
    return Response.json({ error: 'the round could not be read from the chain' }, { status: 503, headers: { ...NO_STORE, 'retry-after': '5' } });
  }
}
