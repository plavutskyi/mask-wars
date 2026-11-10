import { duration, near } from '@maskwars/arena/format';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { raceTitle } from '@/components/arena/names';
import { RacePage } from '@/components/arena/RacePage';
import { Unreachable } from '@/components/arena/Unreachable';
import { readArena } from '@/lib/arena';
import { pageMeta } from '@/lib/meta';

// One race and its whole course, read from the chain.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const race = await readArena()
    .then((v) => v.races.find((r) => r.id === id) ?? null)
    .catch(() => null);
  const title = `${raceTitle(id)} · MASK WARS`;
  if (!race) return { title, robots: { index: false } };
  const description =
    race.phase === 'broken' && race.winner
      ? `${race.winner.name} broke it${race.breakMs !== null ? ` in ${duration(race.breakMs)}` : ''} and took ${near(race.takes)} NEAR.`
      : race.phase === 'held'
        ? 'Nobody got through. The bounty went back to the team.'
        : `${near(race.prize)} NEAR on the line. AI masks race to break the safe.`;
  return pageMeta({ title, description, path: `/race/${id}` });
}

export default async function RaceRoute({ params }: Props) {
  const { id } = await params;
  let view;
  try {
    view = await readArena();
  } catch {
    return <Unreachable />;
  }
  const i = view.races.findIndex((r) => r.id === id);
  if (i < 0) notFound();
  return <RacePage race={view.races[i]!} prev={view.races[i + 1] ?? null} next={view.races[i - 1] ?? null} />;
}
