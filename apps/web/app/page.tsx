import type { Race } from '@maskwars/arena';
import { Stage } from '@/components/arena/Stage';
import { readArena } from '@/lib/arena';

// The home page is the race: the one running now, else the last one, read from the chain.
export const dynamic = 'force-dynamic';

export default async function Home() {
  let race: Race | null = null;
  let error = false;
  try {
    race = (await readArena()).now;
  } catch {
    error = true;
  }
  return <Stage race={race} serverNow={Date.now()} error={error} />;
}
