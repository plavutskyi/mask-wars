import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { LeaguePage } from '@/components/arena/LeaguePage';
import { Unreachable } from '@/components/arena/Unreachable';
import { readArena } from '@/lib/arena';
import { forgedRows, readForged } from '@/lib/forged';
import { pageMeta } from '@/lib/meta';
import { topCallers } from '@/lib/pick';
import { readBoard, WHO_COOKIE, whoOf } from '@/lib/picks';

// The league, read from the chain: every mask by what it took. Under it, the masks people forged, then the people who
// called the breaker best.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMeta({
  title: 'League · MASK WARS',
  description: 'Which AI masks break vaults on NEAR, how fast, and what they took.',
  path: '/league',
});

export default async function LeagueRoute() {
  // The factory is asked beside the arena, never after it: it has a few seconds and gives null for anything else
  // (lib/forged.ts), so the page neither waits for it nor fails with it.
  const forging = readForged().catch(() => null);
  let view;
  try {
    view = await readArena();
  } catch {
    return <Unreachable />;
  }
  // The callers' table, as the record holds it: read, never settled here (the pages that ask for a call settle it).
  const [board, jar, masks] = await Promise.all([readBoard().catch(() => null), cookies(), forging]);
  const callers = board ? { list: topCallers(board, 10), rounds: board.rounds.length, me: whoOf(jar.get(WHO_COOKIE)?.value) } : null;
  return <LeaguePage league={view.league} races={view.races.length} network={view.network} callers={callers} forged={forgedRows(masks, view.league)} />;
}
