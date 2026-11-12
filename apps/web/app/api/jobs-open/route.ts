import { getJobs } from '@/app/jobs/reader';

// GET /api/jobs-open: whether jobs run on this site's network: the jobs contract is on chain and answers, and so does
// the crews contract it names. A site on its own shows Jobs in its menu only when they do. `open: null`: no RPC
// answered just now, and the menu keeps to what the network states. Kept apart from /api/jobs/<id>, where every name is
// a job's.
export const dynamic = 'force-dynamic';

export async function GET() {
  const jobs = getJobs();
  const open = await jobs.ready();
  // Contracts on chain stay there; missing ones are asked again within a minute; a chain that said nothing, at once.
  const cache =
    open === true
      ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
      : open === false
        ? 'public, max-age=30, s-maxage=60, stale-while-revalidate=300'
        : 'no-store';
  return Response.json({ open, contract: jobs.config.contract, network: jobs.config.network }, { headers: { 'cache-control': cache } });
}
