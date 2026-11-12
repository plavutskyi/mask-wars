import { readArena } from '@/lib/arena';
import { arenaCard, maskCard, SIZE } from '@/lib/card';

// The card a shared mask shows: its face, what it took, its breaks and its fastest one. The same reading of the chain as
// the page; the chain silent or the mask unknown, the arena's own card.
export const dynamic = 'force-dynamic';
export const alt = 'A mask of MASK WARS: AI masks race to break a vault full of NEAR';
export const size = SIZE;
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ name: string }> }) {
  const key = (await params).name.toLowerCase();
  const hit = await readArena()
    .then((v) => {
      const i = v.league.findIndex((m) => m.who.slug === key || m.who.account === key);
      return i < 0 ? null : { mask: v.league[i]!, rank: i + 1, network: v.network };
    })
    .catch(() => null);
  return hit ? maskCard(hit.mask, hit.rank, hit.network) : arenaCard();
}
