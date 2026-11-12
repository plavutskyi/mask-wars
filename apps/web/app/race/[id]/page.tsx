import { duration, near } from '@maskwars/arena/format';
import { raceThought } from '@maskwars/arena/minds';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { raceName, raceTitle } from '@/components/arena/names';
import { RacePage } from '@/components/arena/RacePage';
import { Unreachable } from '@/components/arena/Unreachable';
import { asOf, pickNow, readArena } from '@/lib/arena';
import { CALL_SIZE } from '@/lib/card';
import { pageMeta, tag } from '@/lib/meta';
import { briefOf, choiceName, HELD, outcomeOf, pickable, pickOn, verdictOf, windowOf } from '@/lib/pick';
import { entriesOf, PICKS_COOKIE } from '@/lib/picks';
import { mindsOf } from '@/lib/minds';
import { readShare } from '@/lib/share';

// One race and its whole course, read from the chain.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ call?: string | string[] }> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { id } = await params;
  const { call } = await searchParams;
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
        : `${near(race.prize)} NEAR on the line. AI masks race to break the vault.`;
  const meta = pageMeta({ title, description, path: `/race/${id}` });
  // A shared call: the card says who was called and how it ended, the claim signed by this site, the end from the chain.
  const claim = readShare(typeof call === 'string' ? call : null);
  const outcome = outcomeOf(race);
  if (!claim || claim.race !== race.id || outcome === null) return meta;
  const right = verdictOf(claim.choice, outcome) === 'right';
  const said = claim.choice === HELD ? 'the vault holds' : choiceName(claim.choice, race.masks);
  const head = right ? `Called it: ${said} · ${raceName(race.id)} · MASK WARS` : `Picked ${said} · ${raceName(race.id)} · MASK WARS`;
  const card = { url: `/api/pick/card?call=${encodeURIComponent(call as string)}&v=${tag(description)}`, ...CALL_SIZE, alt: description, type: 'image/png' };
  return {
    ...meta,
    title: head,
    openGraph: { ...meta.openGraph, title: head, images: [card] },
    twitter: { card: 'summary_large_image', title: head, description, images: [{ url: card.url, alt: card.alt }] },
  };
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
  const race = view.races[i]!;
  const jar = await cookies();
  const old = asOf(view);
  const mine = pickable(race) ? pickOn(entriesOf(jar.get(PICKS_COOKIE)?.value), race, view.races) : null;
  const records = await mindsOf([race]);
  return (
    <RacePage
      race={race}
      prev={view.races[i + 1] ?? null}
      next={view.races[i - 1] ?? null}
      asOf={old}
      thought={raceThought(race, records.get(race.id))}
      call={mine ? { round: briefOf(race), mine, open: windowOf(view, pickNow(), old !== null)?.race === race.id } : null}
    />
  );
}
