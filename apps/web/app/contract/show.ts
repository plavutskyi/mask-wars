// How a contract's page reads: its name, its standing in words, the line under the number and the few stats beside it.
// Everything here is presentation of the dossier; the standing itself is decided in @maskwars/dossier.
import { HOUSE } from '@maskwars/arena';
import { duration, near, raceNo } from '@maskwars/arena/format';
import type { Dossier, RaceLine, SectionId } from '@maskwars/dossier';
import { TEAMS, shortAccount } from '@/lib/show';

const SAFE_NAME = /^safe-\d{1,8}$/;

/** The house's vault: the one safe of the daily round, made again under the same name for each round. */
export const isHouseVault = (account: string) => account === HOUSE.vault;

/** SAFE-0001 for the arena's own safes, VAULT for the house's, a training target's name, any other account as itself. */
export function displayName(d: Pick<Dossier, 'account' | 'role'>): string {
  if (isHouseVault(d.account)) return 'vault';
  const dot = d.account.indexOf('.');
  if (dot > 0 && SAFE_NAME.test(d.account.slice(0, dot)) && TEAMS.includes(d.account.slice(dot + 1))) return d.account.slice(0, dot);
  if (/^[0-9a-f]{64}$/.test(d.account)) return shortAccount(d.account);
  return d.account;
}

/** Live safe · planted hole. The network rides in the header. */
export function kicker(d: Dossier): string {
  const role =
    d.role === 'safe'
      ? isHouseVault(d.account)
        ? 'Daily round'
        : 'Live vault'
      : d.role === 'target'
        ? d.library
          ? 'Training target'
          : 'Sandbox target'
        : d.role === 'contract'
          ? 'Contract'
          : d.role === 'account'
            ? 'Account'
            : null;
  if (!role) return '';
  const planted = d.library ? (d.library.level !== null ? `Level ${d.library.level} · planted hole` : 'Planted hole') : null;
  return [role, planted].filter(Boolean).join(' · ');
}

/** 1 day, 3 days, 5 h, 40 min: how long it held, rounded to what a person reads. */
export function span(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

const masksWord = (n: number) => `${n} ${n === 1 ? 'mask' : 'masks'}`;

export type Tone = 'amber' | 'ice' | 'quiet';

/** The standing in a few words: BROKEN, HOLDS 3 DAYS AGAINST 3 MASKS, HELD 1 DAY. */
export function standingLine(d: Dossier): { text: string; tone: Tone } {
  const h = d.headline;
  switch (h.standing) {
    case 'broken':
      return { text: h.broken && !h.broken.confirmed && !h.broken.pending ? 'Drained' : 'Broken', tone: 'amber' };
    case 'under_fire':
      // A race that has just opened, or still seals, has held nothing yet.
      if ((h.heldMs ?? 0) < 60_000) return { text: 'Under fire', tone: 'ice' };
      return { text: `Holds ${span(h.heldMs ?? 0)}${h.masks ? ` against ${masksWord(h.masks)}` : ''}`, tone: 'ice' };
    case 'held':
      return { text: `Held${h.heldMs ? ` ${span(h.heldMs)}` : ''}${h.masks ? ` against ${masksWord(h.masks)}` : ''}`, tone: 'ice' };
    case 'untested':
      return { text: h.calledOff ? 'Called off' : 'Not in the arena yet', tone: 'quiet' };
    case 'unknown':
      return { text: d.incomplete ? 'Record incomplete' : 'The chain is not answering', tone: 'quiet' };
  }
}

/** The line under the number: who took it, or where it went. */
export function numberLine(d: Dossier): string {
  const h = d.headline;
  if (h.standing === 'broken' && h.broken) {
    const by = h.broken.by;
    const race = `race ${raceNo(h.broken.race)}`;
    // The number is every break's take: it names one mask only when one mask took it all.
    if (h.broken.count > 1) return [`taken in ${h.broken.count} breaks`, h.broken.oneWinner && by?.mask ? `all by ${by.name}` : by?.mask ? `last by ${by.name}` : null].filter(Boolean).join(' · ');
    // Drained on chain and still with the judge: the claim is on its way.
    if (h.broken.pending) return [by?.mask ? `drained by ${by.name}` : 'drained', 'with the judge', race].join(' · ');
    // Drained on chain, and the judge did not confirm it: the safe gave the NEAR up, the bounty went back.
    if (!h.broken.confirmed) return [by?.mask ? `drained by ${by.name}` : 'drained', 'not confirmed by the judge', race].join(' · ');
    // How fast and in which race stand right below, in the numbers and on the button.
    if (by?.mask) return `taken by ${by.name}`;
    const r = d.races.find((x) => x.id === h.broken!.race);
    return by && r && by.account === r.team ? `paid to the team's own account · ${race}` : `paid out · ${race}`;
  }
  if (h.standing === 'under_fire') return h.closesAt ? 'on the line now' : h.judging ? 'on the line · with the judge' : 'on the line · deadline passed, bounty not back yet';
  // The number sums every race: it names one race only when there was one.
  if (h.standing === 'held') return h.races === 1 && h.newest ? `on the line, back to the team · race ${raceNo(h.newest)}` : `on the line in ${h.races} races, back to the team`;
  if (h.standing === 'untested' && h.calledOff) return `${h.calledOff === 1 ? 'The race on it was' : `All ${h.calledOff} races on it were`} called off before the deadline. Lock a bounty, and AI masks race to break it.`;
  if (h.standing === 'untested') return 'No mask has hit it yet. Lock a bounty, and AI masks race to break it.';
  if (d.incomplete) return 'Its record on the arena could not be read in full right now. Try again in a minute.';
  return 'Nothing could be read about it right now. Try again in a minute.';
}

export interface Stat {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'live' | 'amber' | undefined;
}

/**
 * MASK CHECK's word for the account, as the page shows it: its verdict, or `target` when what it warns about is the
 * arena's own target (the house's vault, by design), so the arena's safe never reads as a bare alarm.
 */
export function checkWord(check: NonNullable<Dossier['check']>): string {
  const target = check.verdict === 'warn' && check.reasons.some((r) => r.code === 'arena_target' && r.level === 'warn');
  return target ? 'target' : check.verdict;
}

/** Up to four numbers beside the big one. */
export function stats(d: Dossier): Stat[] {
  const h = d.headline;
  const out: Stat[] = [];
  // One race says nothing a person needs: the button names it.
  if (h.races > 1) out.push({ label: 'Races', value: String(h.races) });
  if (h.masks) out.push({ label: h.masks === 1 ? 'Mask' : 'Masks', value: String(h.masks) });
  if (h.broken?.breakMs != null) out.push({ label: 'Broke in', value: duration(h.broken.breakMs) });
  else if (h.heldMs) out.push({ label: 'Held', value: span(h.heldMs) });
  if (d.check) out.push({ label: 'Mask check', value: checkWord(d.check), tone: d.check.verdict === 'block' ? 'live' : d.check.verdict === 'warn' ? 'amber' : undefined });
  return out.slice(0, 4);
}

/** How one race ended, as its row in the timeline reads. */
export function raceOutcome(r: RaceLine): string {
  if (r.phase === 'broken') {
    if (r.winner?.mask) return `${r.winner.name} broke it${r.breakMs !== null ? ` in ${duration(r.breakMs)}` : ''}`;
    return r.winner && r.winner.account === r.team ? "Paid to the team's own account" : 'Broken';
  }
  const drain = r.events.find((e) => e.kind === 'drain');
  if (drain) return `${drain.who?.mask ? `${drain.who.name} drained it` : 'Drained'} · not confirmed by the judge`;
  if (r.state === 'refunded') {
    if (r.refundAt === null) return 'Bounty back to the team';
    return r.refundAt < r.deadline ? 'Called off · bounty back to the team' : 'Held · bounty back to the team';
  }
  if (r.state === 'judging' || r.events.some((e) => e.verdict === 'waiting')) return 'With the judge';
  if (r.phase === 'held') return 'Deadline passed · bounty not back yet';
  if (r.phase === 'sealing') return 'Masks are sealing';
  return `${near(r.prize)} NEAR on the line`;
}

export const SECTION_TITLE: Record<SectionId, string> = {
  record: 'What happened',
  money: 'The money',
  code: 'The code',
};

/** The page's own words for metadata and cards. */
export function describe(d: Dossier): string {
  const h = d.headline;
  const name = displayName(d);
  if (h.standing === 'broken' && h.broken?.pending) return `A mask drained ${name} on the MASK WARS arena; the claim is with the judge.`;
  if (h.standing === 'broken' && h.broken && !h.broken.confirmed) return `A mask drained ${name} on the MASK WARS arena; the judge did not confirm it.`;
  if (h.standing === 'broken' && h.broken?.by?.mask && h.broken.count === 1) {
    return `${h.broken.by.name} broke ${name}${h.broken.breakMs !== null ? ` in ${duration(h.broken.breakMs)}` : ''} and took ${near(h.amount)} NEAR.`;
  }
  if (h.standing === 'broken' && h.broken && h.broken.count > 1) return `Masks broke ${name} ${h.broken.count} times and took ${near(h.amount)} NEAR.`;
  if (h.standing === 'broken') return `${name} was broken on the MASK WARS arena.`;
  if (h.standing === 'under_fire') return `${near(h.amount)} NEAR on the line. AI masks race to break ${name}.`;
  if (h.standing === 'held') return `${name} held${h.heldMs ? ` ${span(h.heldMs)}` : ''}${h.masks ? ` against ${masksWord(h.masks)}` : ''}. Nobody got through.`;
  if (h.calledOff) return `${h.calledOff === 1 ? `The race on ${name} was` : `The races on ${name} were`} called off. Put it in the arena.`;
  return `No mask has hit ${name} yet. Put it in the arena.`;
}
