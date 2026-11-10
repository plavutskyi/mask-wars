// How the arena reads on screen: names, art, colours and dates. Everything here is presentation of chain data.
import type { Race, RaceEvent, Who } from '@maskwars/arena';
import { NET, teams } from '@maskwars/network';

const ART = new Set(['nova', 'onyx', 'oracle', 'ronin', 'volt', 'wraith']);

/** The mask's art under /public/art, or null for a mask the arena has no art for. */
export function artOf(who: Who | null | undefined): string | null {
  return who?.slug && ART.has(who.slug) ? `/art/${who.slug}.webp` : null;
}

export type Tone = 'ember' | 'ice' | 'violet';

/** A mask's colour follows its eyes: warm eyes Ember, cold eyes Ice, NOVA Violet (BRANDBOOK §3, §5). */
export function toneOf(who: Who | null | undefined): Tone {
  switch (who?.slug) {
    case 'nova':
      return 'violet';
    case 'onyx':
    case 'oracle':
    case 'ronin':
      return 'ember';
    default:
      return 'ice';
  }
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** 6 NOV, in UTC like everything on the chain. */
export function day(ms: number | null | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** 2026-11-06 18:34:44 UTC */
export function utc(ms: number | null | undefined): string {
  if (!ms) return '–';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * The arena's own teams: the account that opens its races and its season treasury. Only these can make an account
 * under their own name, so only their `safe-0001.<team>` is the arena's SAFE-0001.
 */
export const TEAMS: readonly string[] = teams(NET);

const SAFE_NAME = /^safe-\d{1,8}$/;

/**
 * The safe as the screen names it: the arena's own `safe-0001.tinygif8324.testnet` → SAFE-0001. Any other safe keeps its
 * whole account, so another team's `safe-0001.someone.testnet` never reads as the arena's. A training target keeps its name.
 */
export function targetName(race: Pick<Race, 'kind' | 'target'>): string {
  if (race.kind !== 'safe') return race.target.toUpperCase();
  const dot = race.target.indexOf('.');
  const first = race.target.slice(0, dot);
  return dot > 0 && SAFE_NAME.test(first) && TEAMS.includes(race.target.slice(dot + 1)) ? first.toUpperCase() : race.target;
}

/** A NEAR account rather than a name: it has a dot, or it is a 64-hex implicit account. */
export function isAccount(text: string): boolean {
  return text.includes('.') || /^[0-9a-f]{64}$/.test(text);
}

/**
 * An account short enough for one line: `0e6879a4…a3bbe880` for an implicit one, the start and the end of a long
 * named one. The whole account stays one tap away, behind «i».
 */
export function shortAccount(account: string, max = 28): string {
  if (account.length <= max) return account;
  if (/^[0-9a-f]{64}$/.test(account)) return `${account.slice(0, 8)}…${account.slice(-8)}`;
  const tail = Math.min(12, Math.floor((max - 1) / 2));
  return `${account.slice(0, max - 1 - tail)}…${account.slice(-tail)}`;
}

/** The longest word of a line: what decides whether a headline fits its column. */
export function longest(text: string): number {
  return Math.max(0, ...text.split(/\s+/).map((w) => w.length));
}

/** A person-facing name: the mask's name, or the account. */
export function nameOf(who: Who | null | undefined): string {
  return who ? who.name : '';
}

/** The line a step of the race reads as on its page. The team that opened the race reads as the team. */
export function eventLine(e: RaceEvent, team?: string): string {
  const theTeam = e.who !== null && e.who.account === team;
  const who = theTeam ? 'The team' : (e.who?.name ?? 'Someone');
  switch (e.kind) {
    case 'fund':
      return 'The safe is loaded';
    case 'open':
      return 'The vault opens';
    case 'seal':
      return `${who} seals a plan`;
    case 'move':
      if (!e.ok) return `${who} is turned away`;
      if (e.method === 'set_owner') return `${who} takes over the safe`;
      if (e.method === 'sweep') return `${who} tries to sweep it`;
      return `${who} probes the safe`;
    case 'drain':
      return `${who} drains the safe`;
    case 'reveal':
      return e.ok ? `${who} shows its plan` : `${who}'s plan is refused`;
    case 'claim':
      return e.verdict === 'paid' ? `${who}'s claim is confirmed` : e.verdict === 'waiting' ? `${who} claims the bounty` : `${who}'s claim is refused`;
    case 'paid':
      return theTeam ? 'The contract pays the team' : `The contract pays ${who}`;
    case 'refund':
      return 'The bounty goes back to the team';
  }
}
