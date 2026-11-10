// What a race is called on screen. A person reads a name, never an id or an account: those wait behind «i».

import type { Race, RaceEvent, Who } from '@maskwars/arena';
import { raceNo } from '@maskwars/arena/format';
import { shortAccount, targetName } from '../../lib/show';

/** A season round by its id: `s1-0002-7c41e9` is round 2 of season 1. */
export function roundOf(id: string): { season: number; round: number } | null {
  const m = /^s(\d+)-(\d+)-[0-9a-z]+$/.exec(id);
  return m ? { season: Number(m[1]), round: Number(m[2]) } : null;
}

/** `Round 2` for a season's round, `Race 0003` for a race the team opened by hand. */
export function raceName(id: string): string {
  const r = roundOf(id);
  return r ? `Round ${r.round}` : `Race ${raceNo(id)}`;
}

/** The same with its season in front, where there is a line to spare: `Season 1 · Round 2`. */
export function raceTitle(id: string): string {
  const r = roundOf(id);
  return r ? `Season ${r.season} · Round ${r.round}` : `Race ${raceNo(id)}`;
}

/**
 * The line under the sum on the stage: the round for a season's safe, SAFE-0001 for the arena's own safe, the target's
 * name for a training target. Another team's safe has no name of ours: its account, short enough for the door.
 */
export function stageName(race: Pick<Race, 'id' | 'kind' | 'target'>): { text: string; account: boolean } {
  if (roundOf(race.id)) return { text: raceName(race.id), account: false };
  const name = targetName(race);
  return name === race.target && race.kind === 'safe' ? { text: shortAccount(name, 26), account: true } : { text: name, account: false };
}

/** What one mask has done in the race so far, from its moves on chain: how close it is, and the word for it. */
export function standing(who: Who, events: readonly RaceEvent[]): { heat: number; text: string } {
  const mine = events.filter((e) => e.who?.account === who.account);
  if (mine.some((e) => e.kind === 'drain' && !e.early)) return { heat: 1, text: 'Drained it' };
  if (mine.some((e) => e.kind === 'claim' && e.verdict === 'waiting')) return { heat: 0.9, text: 'Claiming' };
  if (mine.some((e) => e.kind === 'reveal' && e.ok)) return { heat: 0.8, text: 'Plan shown' };
  const tries = mine.filter((e) => e.kind === 'move' || e.kind === 'drain').length;
  if (tries) return { heat: 0.6, text: `${tries} ${tries === 1 ? 'try' : 'tries'}` };
  const seal = mine.find((e) => e.kind === 'seal');
  if (seal) return { heat: 0.35, text: `Sealed #${(seal.seq ?? 0) + 1}` };
  return { heat: 0.1, text: 'In the race' };
}
