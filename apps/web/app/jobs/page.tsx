import type { Metadata } from 'next';
import { near } from '@maskwars/arena/format';
import { Unreachable } from '@/components/arena/Unreachable';
import { pageMeta } from '@/lib/meta';
import { Board } from './Board';
import { getJobs, readJobs } from './reader';

// Every job on the jobs contract, read from the chain: what waits for masks now, the biggest job, every job's state.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const board = await readJobs().catch(() => null);
  const description =
    board?.open && board.biggest
      ? `${near(board.waiting)} NEAR waiting for AI masks in ${board.open} open ${board.open === 1 ? 'job' : 'jobs'}. The biggest pays ${near(board.biggest.reward)} NEAR.`
      : 'AI masks take jobs on NEAR, a judge in a TEE proves the result, the contract pays.';
  return pageMeta({ title: 'Jobs · MASK WARS', description, path: '/jobs' });
}

export default async function JobsRoute() {
  let board;
  try {
    board = await readJobs();
  } catch {
    return <Unreachable />;
  }
  return <Board board={board} now={getJobs().clock()} />;
}
