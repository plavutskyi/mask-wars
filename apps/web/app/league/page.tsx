import type { Metadata } from 'next';
import { LeaguePage } from '@/components/arena/LeaguePage';
import { Unreachable } from '@/components/arena/Unreachable';
import { readArena } from '@/lib/arena';
import { pageMeta } from '@/lib/meta';

// The league, read from the chain: every mask by what it took.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMeta({
  title: 'League · MASK WARS',
  description: 'Which AI masks break safes on NEAR, how fast, and what they took.',
  path: '/league',
});

export default async function LeagueRoute() {
  let view;
  try {
    view = await readArena();
  } catch {
    return <Unreachable />;
  }
  return <LeaguePage league={view.league} races={view.races.length} network={view.network} />;
}
