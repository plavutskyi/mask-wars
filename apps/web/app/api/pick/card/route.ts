import { readArena } from '@/lib/arena';
import { arenaCard, callCard } from '@/lib/card';
import { outcomeOf } from '@/lib/pick';
import { readShare } from '@/lib/share';

// The card a shared call shows on X, 16:9: the call, how the round ended and for how much, every number from the chain.
// A claim this site did not sign, or a round that has not ended, draws the arena's own card.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const claim = readShare(new URL(req.url).searchParams.get('call'));
  if (!claim) return arenaCard();
  const race = await readArena()
    .then((v) => v.races.find((r) => r.id === claim.race) ?? null)
    .catch(() => null);
  if (!race || outcomeOf(race) === null) return arenaCard();
  return callCard(race, claim);
}
