// Pick the breaker: before a round a person names the mask that breaks the vault first, or says the vault holds. Free,
// no wallet, no prize. Everything here is pure and reads only what the arena read from the chain: which round takes
// picks and until when, how a round ended, whether a pick called it, and the callers' table with their streaks.
//
// A round takes picks from the moment the schedule names it (`view.next`) until its first seal lands on chain: from
// then on the chain and the stage show which mask sealed, and in what order, and by the round's rule the earliest
// confirmed seal wins, so a later pick would read the answer, not call it. A round nobody seals takes picks until its
// sealing window closes. Before it opens on chain it is known by its scheduled time (`t.<ms>`); once open, by its race
// (`r.<contract>.<id>`). The race a scheduled time became is the first official sealed round opened near it.
import type { ArenaView, NextRace, Race, Who } from '@maskwars/arena';
import { toneOf } from './show';

/** The vault holds: nobody breaks it before the deadline. */
export const HELD = 'held';
/** A mask's account, or `HELD`. */
export type Choice = string;

/** A round may open this long before its scheduled time, and this long after it. */
export const EARLY_MS = 10 * 60_000;
export const LATE_MS = 12 * 3_600_000;

/** How many people one address may rank in one round: a household, an office, not a farm. */
export const PER_ADDRESS = 8;

export const raceKey = (r: Pick<Race, 'contract' | 'id'>): string => `r.${r.contract}.${r.id}`;
export const nextKey = (at: number): string => `t.${at}`;

const KEY = /^(r\.[a-z0-9._-]{2,64}\.[A-Za-z0-9._-]{1,64}|t\.\d{13})$/;
export const keyOk = (k: unknown): k is string => typeof k === 'string' && KEY.test(k);

/** A round people can pick on: opened by the arena's own team, with a sealing window. */
export const pickable = (r: Race): boolean => r.official && r.sealUntil !== null;

/** The round a scheduled time became: the first pickable race opened from `EARLY_MS` before it to `LATE_MS` after. */
export function raceAt(at: number, races: readonly Race[]): Race | null {
  let best: Race | null = null;
  for (const r of races) {
    if (!pickable(r) || r.openedAt === null) continue;
    if (r.openedAt < at - EARLY_MS || r.openedAt > at + LATE_MS) continue;
    if (!best || r.openedAt < best.openedAt!) best = r;
  }
  return best;
}

/**
 * A round's first seal: when the earliest mask sealed its plan, as the reading of the chain has it; null while none
 * has. A seal cannot come before its round opened: one whose time the reading does not know counts from the opening.
 */
export function firstSealOf(r: Pick<Race, 'events' | 'openedAt'>): number | null {
  let first: number | null = null;
  for (const e of r.events) if (e.kind === 'seal' && (first === null || e.at < first)) first = e.at;
  return first === null ? null : Math.max(first, r.openedAt ?? first);
}

/**
 * When picks on a round close: at its first seal, or, when no mask sealed, at the end of its sealing window. Null for
 * a round with no sealing window. A pick counts only if it was made strictly before this.
 */
export function closesAt(r: Pick<Race, 'events' | 'openedAt' | 'sealUntil'>): number | null {
  if (r.sealUntil === null) return null;
  const seal = firstSealOf(r);
  return seal === null ? r.sealUntil : Math.min(seal, r.sealUntil);
}

/** Whether a pick filed under `key` is a pick on `race`. */
export function keyIs(key: string, race: Race, races: readonly Race[]): boolean {
  if (key === raceKey(race)) return true;
  if (!key.startsWith('t.')) return false;
  return raceAt(Number(key.slice(2)), races) === race;
}

const CORNER = { ember: 0, ice: 1, violet: 2 } as const;

/**
 * The masks people pick from, in the order the stage stands them: Ember left, Ice middle, Violet right. The stage holds
 * three: a bigger field before a round, when nobody has tried yet, is its first three (as `stageCast` stands them).
 */
export function inStageOrder(masks: readonly Who[]): Who[] {
  return masks
    .slice(0, 3)
    .map((who, i) => ({ who, i }))
    .sort((a, b) => CORNER[toneOf(a.who)] - CORNER[toneOf(b.who)] || a.i - b.i)
    .map((x) => x.who);
}

export interface PickWindow {
  /** Where the picks are filed. */
  readonly key: string;
  /**
   * Picks close here at the latest: the end of the round's sealing window. A round open on chain closes them sooner,
   * at its first seal: the next reading of the arena says so.
   */
  readonly closes: number;
  /** When the round opens by the schedule, while it is not open on chain yet; null once it is. */
  readonly opens: number | null;
  /** The masks to pick from, in stage order. `HELD` is always a choice too. */
  readonly masks: readonly Who[];
  /** What the round puts on the line. */
  readonly prize: string;
  /** The race on chain, once it is open. */
  readonly race: string | null;
}

/**
 * The round that takes picks now, or null. A reading too old to say what happens now (`old`) takes none: the page
 * cannot know the window is still open. A round open on chain takes picks until its first seal is in the reading, and
 * no later than the end of its sealing window; before it opens, from the moment the schedule names it, funded, and the
 * round before it has ended, until its sealing window would close.
 */
export function windowOf(view: Pick<ArenaView, 'now' | 'next' | 'races'>, now: number, old: boolean): PickWindow | null {
  if (old) return null;
  const r = view.now;
  if (r && pickable(r) && r.phase === 'sealing' && r.sealUntil !== null && now < r.sealUntil && firstSealOf(r) === null && r.masks.length) {
    return { key: raceKey(r), closes: r.sealUntil, opens: null, masks: inStageOrder(r.masks), prize: r.prize, race: r.id };
  }
  // While a round runs, or its judge is on the claim, the page is that round's: the next one takes picks after it.
  if (r && pickable(r) && outcomeOf(r) === null) return null;
  const n = view.next;
  if (n && n.funded && n.masks.length) {
    const closes = closesOf(n);
    if (now < closes && !raceAt(n.at, view.races)) return { key: nextKey(n.at), closes, opens: n.at, masks: inStageOrder(n.masks), prize: n.prize, race: null };
  }
  return null;
}

export const closesOf = (n: Pick<NextRace, 'at' | 'sealMinutes'>): number => n.at + n.sealMinutes * 60_000;

/**
 * Whether a pick sent under `key` is a pick in the window: its own key, or, for a round that has just opened on chain,
 * the scheduled time it opened for. A page that was showing the next round keeps that key until it reads again.
 */
export function keyIn(w: Pick<PickWindow, 'key' | 'race'>, key: string, view: Pick<ArenaView, 'now' | 'races'>): boolean {
  if (key === w.key) return true;
  const r = view.now;
  return r !== null && w.race === r.id && w.key === raceKey(r) && keyIs(key, r, view.races);
}

/**
 * Why no round takes picks, for a pick that came too late: the first seal of the round on the stage, by its time.
 * Null when it is not a seal that closed them: the sealing window ended, or no round is due.
 */
export function sealedShut(view: Pick<ArenaView, 'now'>): number | null {
  const r = view.now;
  return r && pickable(r) && outcomeOf(r) === null ? firstSealOf(r) : null;
}

/** Whether `choice` is one of the window's: one of its masks, or the vault holding. */
export const choiceIn = (w: Pick<PickWindow, 'masks'>, choice: unknown): choice is Choice =>
  choice === HELD || (typeof choice === 'string' && w.masks.some((m) => m.account === choice));

/**
 * How a round ended, from the chain: the mask that broke it, or `HELD`. Null while anything can still change: the
 * round runs, the judge is on the claim, or the payout is on its way.
 */
export function outcomeOf(r: Race): Choice | null {
  if (r.live || r.state === 'open' || r.state === 'judging') return null;
  if (r.phase === 'held') return HELD;
  if (r.phase === 'broken' && r.winner) return r.winner.account;
  return null;
}

/** The latest pickable round whose outcome is final. */
export function lastDecided(races: readonly Race[]): Race | null {
  let best: Race | null = null;
  for (const r of races) {
    if (!pickable(r) || outcomeOf(r) === null) continue;
    if (!best || (r.openedAt ?? 0) > (best.openedAt ?? 0)) best = r;
  }
  return best;
}

// ---- A person's own picks, as their device keeps them -------------------------------------------------------------

/** One pick: where it was filed, what it named, when. */
export interface Entry {
  readonly key: string;
  readonly choice: Choice;
  readonly at: number;
}

/** Entries kept on the device: the latest few rounds. */
export const KEEP = 8;

/**
 * A person's pick on `race`: the last one they filed under any of its keys strictly before its picks closed
 * (`closesAt`). One the server took in the moments between a seal landing and its next reading is not their pick: the
 * round's record does not count it either.
 */
export function pickOn(entries: readonly Entry[], race: Race, races: readonly Race[]): Entry | null {
  const closes = closesAt(race);
  let best: Entry | null = null;
  for (const e of entries) {
    if (closes !== null && e.at >= closes) continue;
    if (keyIs(e.key, race, races) && (!best || e.at > best.at)) best = e;
  }
  return best;
}

/** A person's pick filed under one key. */
export const pickIn = (entries: readonly Entry[], key: string): Entry | null =>
  entries.reduce<Entry | null>((best, e) => (e.key === key && (!best || e.at > best.at) ? e : best), null);

/**
 * A person's pick in an open window. For a round open on chain it is their pick on that round, the one they made on
 * its scheduled time before it opened included: a round that goes from the schedule to the chain keeps its picks.
 */
export function pickInWindow(entries: readonly Entry[], w: Pick<PickWindow, 'key' | 'race'>, view: Pick<ArenaView, 'now' | 'races'>): Entry | null {
  const r = view.now;
  return r !== null && w.race === r.id && w.key === raceKey(r) ? pickOn(entries, r, view.races) : pickIn(entries, w.key);
}

/** The entries with one more pick: the new one first, the oldest dropped. */
export function withPick(entries: readonly Entry[], e: Entry): Entry[] {
  return [e, ...entries.filter((x) => x.key !== e.key)].sort((a, b) => b.at - a.at).slice(0, KEEP);
}

// ---- The record: every pick of a round, then the table ---------------------------------------------------------------

/** One stored pick, as its path in the store says it. */
export interface Filed {
  /** The person: `d<id>` a device, `a<account>` a vault. */
  readonly who: string;
  readonly choice: Choice;
  /** A short tag of the address it came from: no address is kept. */
  readonly from: string;
  readonly at: number;
}

const WHO = /^(d[A-Za-z0-9_-]{16,32}|a[a-z0-9._-]{2,64})$/;
export const whoOk = (w: unknown): w is string => typeof w === 'string' && WHO.test(w);
const CHOICE = /^(held|[a-z0-9._-]{2,64})$/;

/** `<who>~<choice>~<from>~<at>`: a pick is a name in the store, and a listing of a round is all its picks. */
export const fileName = (f: Filed): string => `${f.who}~${f.choice}~${f.from}~${f.at}`;

export function parseFile(name: string): Filed | null {
  const [who, choice, from, at, ...rest] = name.split('~');
  if (rest.length || !whoOk(who) || !choice || !CHOICE.test(choice) || !from || !/^[0-9a-f]{8}$/.test(from) || !at || !/^\d{13}$/.test(at)) return null;
  return { who, choice, from, at: Number(at) };
}

/** A round's picks, settled once its outcome is final. Never rewritten. */
export interface Tally {
  readonly v: 1;
  readonly key: string;
  readonly race: string;
  /** When the round opened: the order of rounds. */
  readonly at: number;
  readonly outcome: Choice;
  /** [who, choice, ranked]: ranked 0 for picks past an address's share of the round. */
  readonly picks: readonly (readonly [string, Choice, 0 | 1])[];
}

/**
 * The picks of a round as they stand at its close: each person's last pick made strictly before the round's first seal
 * (`closesAt`: the end of the sealing window when nobody sealed), and no more than `PER_ADDRESS` people ranked from one
 * address (the first to pick). A pick made after that moment is not counted, whenever the store took it.
 */
export function tallyOf(race: Race, filed: readonly Filed[], aliases: ReadonlyMap<string, string> = new Map()): Tally | null {
  const outcome = outcomeOf(race);
  const closes = closesAt(race);
  if (outcome === null || closes === null || race.sealUntil === null) return null;
  const last = new Map<string, Filed>();
  for (const f of filed) {
    if (f.at >= closes) continue;
    const who = aliases.get(f.who) ?? f.who;
    const had = last.get(who);
    if (!had || f.at > had.at) last.set(who, { ...f, who });
  }
  const first = [...last.values()].sort((a, b) => a.at - b.at || (a.who < b.who ? -1 : 1));
  const seen = new Map<string, number>();
  const picks = first.map((f): readonly [string, Choice, 0 | 1] => {
    const n = (seen.get(f.from) ?? 0) + 1;
    seen.set(f.from, n);
    return [f.who, f.choice, n <= PER_ADDRESS ? 1 : 0];
  });
  return { v: 1, key: raceKey(race), race: race.id, at: race.openedAt ?? race.sealUntil, outcome, picks };
}

/** One person on the table. */
export interface Caller {
  readonly who: string;
  /** Rounds they picked, and called right. */
  readonly calls: number;
  readonly right: number;
  /** Rounds called right in a row, up to the last settled round; and the longest run. */
  readonly streak: number;
  readonly best: number;
  /** Their pick on the last settled round, if they made one. */
  readonly last: { readonly race: string; readonly choice: Choice; readonly right: boolean } | null;
}

export interface Board {
  readonly v: 1;
  /** The settled rounds, oldest first. */
  readonly rounds: readonly { readonly key: string; readonly race: string; readonly outcome: Choice; readonly picks: number }[];
  readonly callers: Readonly<Record<string, Caller>>;
}

export const EMPTY_BOARD: Board = { v: 1, rounds: [], callers: {} };

/**
 * The table from every settled round, oldest first. A streak is rounds called right in a row: a miss, or a round with
 * no pick, starts it over. A person's device picks follow them to their vault (`aliases`).
 */
export function boardOf(tallies: readonly Tally[], aliases: ReadonlyMap<string, string> = new Map()): Board {
  const order = [...tallies].sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  const callers = new Map<string, { calls: number; right: number; streak: number; best: number; last: Caller['last'] }>();
  const rounds: Board['rounds'][number][] = [];
  for (const t of order) {
    const here = new Map<string, Choice>();
    for (const [w, choice, ranked] of t.picks) {
      if (!ranked) continue;
      const who = aliases.get(w) ?? w;
      here.set(who, choice);
    }
    for (const [who, c] of callers) if (!here.has(who)) callers.set(who, { ...c, streak: 0, last: null });
    for (const [who, choice] of here) {
      const c = callers.get(who) ?? { calls: 0, right: 0, streak: 0, best: 0, last: null };
      const right = choice === t.outcome;
      const streak = right ? c.streak + 1 : 0;
      callers.set(who, { calls: c.calls + 1, right: c.right + (right ? 1 : 0), streak, best: Math.max(c.best, streak), last: { race: t.race, choice, right } });
    }
    rounds.push({ key: t.key, race: t.race, outcome: t.outcome, picks: here.size });
  }
  return { v: 1, rounds, callers: Object.fromEntries([...callers].map(([who, c]) => [who, { who, ...c }])) };
}

/** The best callers: most rounds called right, then the longest run, then the run going now, then fewest picks. */
export function topCallers(board: Board, n = 10): Caller[] {
  return Object.values(board.callers)
    .filter((c) => c.right > 0)
    .sort((a, b) => b.right - a.right || b.best - a.best || b.streak - a.streak || a.calls - b.calls || (a.who < b.who ? -1 : 1))
    .slice(0, n);
}

/** Whether the board already holds this round. */
export const settledOn = (board: Board, race: Pick<Race, 'contract' | 'id'>): boolean => board.rounds.some((r) => r.key === raceKey(race));

/** How a caller is shown: a vault by its account, a device by a short tag of its id. */
export function callerName(who: string): string {
  if (who.startsWith('a')) {
    const account = who.slice(1);
    return account.length > 18 ? `${account.slice(0, 8)}…${account.slice(-6)}` : account;
  }
  let h = 5381;
  for (let i = 0; i < who.length; i++) h = (Math.imul(h, 33) ^ who.charCodeAt(i)) >>> 0;
  return `Guest ${h.toString(36).toUpperCase().padStart(4, '0').slice(-4)}`;
}

// ---- What a person sees ---------------------------------------------------------------------------------------------

/** A person's call on a settled round. */
export type Verdict = 'right' | 'wrong';

export const verdictOf = (choice: Choice, outcome: Choice): Verdict => (choice === outcome ? 'right' : 'wrong');

/** The name a choice goes by: the mask's, or the vault holding. */
export function choiceName(choice: Choice, masks: readonly Who[]): string {
  if (choice === HELD) return 'Vault holds';
  return masks.find((m) => m.account === choice)?.name ?? choice;
}

/** The line a vault's passkey signs to pick as the vault: what it is for, the site, and when. Good for ten minutes. */
export function linkPayload(site: string, at: number): string {
  return JSON.stringify({ maskwars: 'pick-as-vault', site, at });
}

// ---- The block on a page --------------------------------------------------------------------------------------------

/** A round as the block tells it: its name and masks, and how it ended once that is final. */
export interface RoundBrief {
  readonly id: string;
  readonly masks: readonly Who[];
  readonly outcome: Choice | null;
  readonly winner: Who | null;
  readonly breakMs: number | null;
  readonly takes: string | null;
  /** The judge is on the claim, or the payout is on its way: a mask broke it, and the chain has not said the last word. */
  readonly judging: boolean;
  /** The masks still seal their plans: the round has not started to play. */
  readonly sealing: boolean;
}

export const briefOf = (r: Race): RoundBrief => ({
  id: r.id,
  masks: inStageOrder(r.masks),
  outcome: outcomeOf(r),
  winner: r.winner,
  breakMs: r.breakMs,
  takes: r.takes,
  judging: r.phase === 'broken' && outcomeOf(r) === null,
  sealing: r.phase === 'sealing',
});

/** Everything the block needs, from one reading of the arena and the person's own picks. */
export interface PickView {
  /** The round that takes picks now, and the person's pick in it. */
  readonly window: PickWindow | null;
  readonly mine: Entry | null;
  /** A pickable round whose picks closed, at its first seal or with its sealing window, and that has not ended. */
  readonly running: RoundBrief | null;
  readonly runningMine: Entry | null;
  /** The last pickable round that ended, and the person's pick on it. */
  readonly last: RoundBrief | null;
  readonly lastMine: Entry | null;
  /** The reading is too old to say what happens now. */
  readonly old: boolean;
}

export function pickView(view: Pick<ArenaView, 'now' | 'next' | 'races'>, entries: readonly Entry[], now: number, old: boolean): PickView {
  const window = windowOf(view, now, old);
  const r = view.now;
  const running = r && pickable(r) && outcomeOf(r) === null && window?.race !== r.id ? r : null;
  const last = lastDecided(view.races);
  return {
    window,
    mine: window ? pickInWindow(entries, window, view) : null,
    running: running ? briefOf(running) : null,
    runningMine: running ? pickOn(entries, running, view.races) : null,
    last: last ? briefOf(last) : null,
    lastMine: last ? pickOn(entries, last, view.races) : null,
    old,
  };
}
