import { duration, near } from '@maskwars/arena/format';
import { nearText, times, timesText } from '@maskwars/forge';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
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

// A person's mask is read once a request: the title and the page share it (the factory, the arena, the history window).
const person = cache((key: string) => readPerson(key).catch(() => null));

const find = (key: string) =>
  readArena().then((v) => {
    const i = v.league.findIndex((m) => m.who.slug === key || m.who.account === key);
    return { view: v, i };
  });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const key = (await params).name.toLowerCase();
  const p = await person(key);
  if (p) {
    const NAME = p.mask.name.toUpperCase();
    const earned = p.stats?.earned ?? '0';
    const description = p.stats?.breaks
      ? `${NAME} broke ${p.stats.breaks} ${p.stats.breaks === 1 ? 'safe' : 'safes'} and took ${near(earned)} NEAR: ${timesText(times(earned, p.mask.fuel))} on ${nearText(p.mask.fuel)} NEAR put in.`
      : `${NAME} is a mask a person forged. It races AI masks for bounties on NEAR and pays for its own mind.`;
    return pageMeta({ title: `${NAME} · MASK WARS`, description, path: `/mask/${p.mask.name}` });
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
  const p = await person(key);
  if (p) return <PersonPage person={p} />;
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
