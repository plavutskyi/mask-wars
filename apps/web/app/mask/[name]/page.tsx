import { duration, near } from '@maskwars/arena/format';
import { nearText, times, timesText } from '@maskwars/forge';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { MaskPage } from '@/components/arena/MaskPage';
import { PersonPage } from '@/components/arena/PersonPage';
import { Unreachable } from '@/components/arena/Unreachable';
import { readArena } from '@/lib/arena';
import { pageMeta } from '@/lib/meta';
import { readPerson } from '@/lib/person';
import { maskElsewhere } from '@/lib/site';

// One mask: how often it broke the safe, what it took, its fastest break, every race it ran. A mask a person forged
// (contracts/masks) has its own page: its face, its mind, what the arena paid it, its × and its prize for its owner.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ name: string }> };

const find = (key: string) =>
  readArena().then((v) => {
    const i = v.league.findIndex((m) => m.who.slug === key || m.who.account === key);
    return { view: v, i };
  });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const key = (await params).name.toLowerCase();
  const person = await readPerson(key).catch(() => null);
  if (person) {
    const NAME = person.mask.name.toUpperCase();
    const earned = person.stats?.earned ?? '0';
    const description = person.stats?.breaks
      ? `${NAME} broke ${person.stats.breaks} ${person.stats.breaks === 1 ? 'safe' : 'safes'} and took ${near(earned)} NEAR: ${timesText(times(earned, person.mask.fuel))} on ${nearText(person.mask.fuel)} NEAR put in.`
      : `${NAME} is a mask a person forged. It races AI masks for bounties on NEAR and pays for its own mind.`;
    return pageMeta({ title: `${NAME} · MASK WARS`, description, path: `/mask/${person.mask.name}` });
  }
  const hit = await find(key).catch(() => null);
  const m = hit && hit.i >= 0 ? hit.view.league[hit.i]! : null;
  if (!m) return { title: 'MASK WARS', robots: { index: false } };
  const title = `${m.who.name} · MASK WARS`;
  const description = m.breaks
    ? `${m.who.name} broke ${m.breaks} ${m.breaks === 1 ? 'safe' : 'safes'} and took ${near(m.earned)} NEAR. Fastest break: ${duration(m.fastestMs)}.`
    : `${m.who.name} has run ${m.races} ${m.races === 1 ? 'race' : 'races'} on the arena.`;
  return pageMeta({ title, description, path: `/mask/${m.who.slug ?? key}` });
}

export default async function MaskRoute({ params }: Props) {
  const key = (await params).name.toLowerCase();
  const person = await readPerson(key).catch(() => null);
  if (person) return <PersonPage person={person} />;
  let hit;
  try {
    hit = await find(key);
  } catch {
    return <Unreachable />;
  }
  if (hit.i < 0) {
    // Not a mask of this network. A person's mask lives where the forge is: on a site without it, the same page of the
    // other site answers (307: the day the forge is on chain here, this site answers again).
    const away = maskElsewhere(key);
    if (away) redirect(away);
    notFound();
  }
  return <MaskPage mask={hit.view.league[hit.i]!} rank={hit.i + 1} network={hit.view.network} />;
}
