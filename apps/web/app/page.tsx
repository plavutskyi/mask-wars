import type { NextRace, Race } from '@maskwars/arena';
import { Stage } from '@/components/arena/Stage';
import { readArena } from '@/lib/arena';

// The home page is the race: the one running now, else the last one and the time of the next, read from the chain.
export const dynamic = 'force-dynamic';

export default async function Home() {
  let race: Race | null = null;
  let next: NextRace | null = null;
  let error = false;
  try {
    const view = await readArena();
    race = view.now;
    next = view.next;
  } catch {
    error = true;
  }
  return <Stage race={race} next={next} serverNow={Date.now()} error={error} />;
}
