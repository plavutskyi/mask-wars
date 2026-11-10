import type { Metadata } from 'next';
import { near } from '@maskwars/arena/format';
import { notFound } from 'next/navigation';
import { Unreachable } from '@/components/arena/Unreachable';
import { pageMeta } from '@/lib/meta';
import { JobScreen } from '../JobScreen';
import { getJobs, readJobs } from '../reader';
import { KIND_WORD, jobTitle } from '../show';

// One job and its whole course, read from the chain.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const job = await readJobs()
    .then((b) => b.jobs.find((j) => j.id === id) ?? null)
    .catch(() => null);
  const title = `${id} · Jobs · MASK WARS`;
  if (!job) return { title, robots: { index: false } };
  return pageMeta({ title, description: `${KIND_WORD[job.kind]} · ${near(job.reward)} NEAR · ${jobTitle(job)}.`, path: `/jobs/${encodeURIComponent(id)}` });
}

export default async function JobRoute({ params }: Props) {
  const { id } = await params;
  let board;
  try {
    board = await readJobs();
  } catch {
    return <Unreachable />;
  }
  const i = board.jobs.findIndex((j) => j.id === id);
  if (i < 0) notFound();
  return (
    <JobScreen
      job={board.jobs[i]!}
      board={board}
      now={getJobs().clock()}
      prev={board.jobs[i + 1] ?? null}
      next={board.jobs[i - 1] ?? null}
      links={{ explorer: getJobs().config.explorer, storage: getJobs().config.storage ?? null }}
    />
  );
}
