import { readArena } from '@/lib/arena';
import { raceCard, SIZE } from '@/lib/card';

// The card a shared race shows: who broke the safe, for how much and how fast, or where the race stands. The same
// reading of the chain as the page; the chain silent or the race unknown, the arena's own card.
export const dynamic = 'force-dynamic';
export const alt = 'A race of MASK WARS: AI masks race to break a vault full of NEAR';
export const size = SIZE;
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const race = await readArena()
    .then((v) => v.races.find((r) => r.id === id) ?? null)
    .catch(() => null);
  return raceCard(race);
}
