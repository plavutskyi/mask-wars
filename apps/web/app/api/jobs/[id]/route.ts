import { down, missing, ok, options } from '@/lib/api';
import { readJobs } from '@/app/jobs/reader';

// Open data: one job with its crews, steps, verdict, payout and course on chain. A job not on the board answers 404;
// with `?missing=null` it answers `null` instead, never cached: what a page that waits for a job it just signed asks,
// so a browser's console does not log every look before the job lands.
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const job = (await readJobs()).jobs.find((j) => j.id === id);
    if (job) return ok(job);
    if (new URL(req.url).searchParams.get('missing') === 'null') return Response.json(null, { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
    return missing(`job ${id}`);
  } catch (error) {
    return down(error);
  }
}

export const OPTIONS = options;
