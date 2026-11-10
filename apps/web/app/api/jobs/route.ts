import { down, ok, options } from '@/lib/api';
import { readJobs } from '@/app/jobs/reader';
import { pageOf } from './paging';

// Open data: the newest jobs on the jobs contract, read from the chain, a page at a time: `?limit=` (1 to 50, 20 by
// default) and `?offset=`. Amounts in yoctoNEAR, times in ms by the chain's clock. Any site or agent may read it.
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  try {
    return ok(pageOf(await readJobs(), query.get('offset'), query.get('limit')));
  } catch (error) {
    return down(error);
  }
}

export const OPTIONS = options;
