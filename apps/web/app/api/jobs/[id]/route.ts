import { down, missing, ok, options } from '@/lib/api';
import { readJobs } from '@/app/jobs/reader';

// Open data: one job with its crews, steps, verdict, payout and course on chain.
export const dynamic = 'force-dynamic';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const job = (await readJobs()).jobs.find((j) => j.id === id);
    return job ? ok(job) : missing(`job ${id}`);
  } catch (error) {
    return down(error);
  }
}

export const OPTIONS = options;
