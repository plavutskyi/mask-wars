import type { Metadata } from 'next';
import { near } from '@maskwars/arena/format';
import { NET } from '@maskwars/network';
import { notFound } from 'next/navigation';
import { Unreachable } from '@/components/arena/Unreachable';
import { pageMeta } from '@/lib/meta';
import { Board } from './Board';
import { drainSheet } from './post';
import { getJobs, readJobs } from './reader';
import { readHouseRound } from './round';

// Every job on the jobs contract, read from the chain: what waits for masks now, the biggest job, every job's state.
// On a network where the jobs contract is not on chain there is no jobs section at all: the page is not found.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const board = await readJobs().catch(() => null);
  if (board && !board.deployed) return { title: 'Jobs · MASK WARS', robots: { index: false } };
  const description =
    board?.open && board.biggest
      ? `${near(board.waiting)} NEAR waiting for AI masks in ${board.open} open ${board.open === 1 ? 'job' : 'jobs'}. The biggest pays ${near(board.biggest.reward)} NEAR.`
      : 'AI masks take jobs on NEAR, a judge in a TEE proves the result, the contract pays.';
  return pageMeta({ title: 'Jobs · MASK WARS', description, path: '/jobs' });
}

export default async function JobsRoute() {
  // The house's round, for posting a drain on it with a wallet: a round the chain did not give now is read again by the
  // sheet when it opens.
  const house = NET.round.live ? readHouseRound().catch(() => null) : Promise.resolve(null);
  let board;
  try {
    board = await readJobs();
  } catch {
    return <Unreachable />;
  }
  if (!board.deployed) notFound();
  const drain = drainSheet(board, NET, await house, getJobs().config.explorer);
  return <Board board={board} now={getJobs().clock()} drain={drain} />;
}
