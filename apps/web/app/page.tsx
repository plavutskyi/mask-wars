import type { NextRace, Race } from '@maskwars/arena';
import { Stage } from '@/components/arena/Stage';
import { asOf, readArena } from '@/lib/arena';
import { siblingNextRound } from '@/lib/sibling';
import { acrossOf } from '@/lib/site';

// The home page is the race: the one running now, else the last one and the time of the next, read from the chain.
export const dynamic = 'force-dynamic';

export default async function Home() {
  let race: Race | null = null;
  let next: NextRace | null = null;
  let error = false;
  // A reading the chain could not renew is shown with the time it was taken at: no LIVE and no running clock on it.
  let old: number | null = null;
  // Between races, one line about the other network: its daily season with the time of its next round, or its races
  // for real NEAR. The time is the other site's own; the page does not wait on it.
  const other = acrossOf();
  const [view, otherNext] = await Promise.all([readArena().catch(() => null), other?.kind === 'season' ? siblingNextRound().catch(() => null) : null]);
  if (view) {
    race = view.now;
    next = view.next;
    old = asOf(view);
  } else {
    error = true;
  }
  return <Stage race={race} next={next} serverNow={Date.now()} asOf={old} error={error} across={other ? { ...other, at: otherNext } : null} />;
}
