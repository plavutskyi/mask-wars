// A person's mask, as its page reads it: the factory's record (owner, look, model, style, fuel, tank, the race it is
// in), what is on the mask's own account for its owner, what the arena paid it, and — for confidential copying — the
// masks that copy it and what their author earned, or, when it is a copy, the author it plays and the share it owes.
// All from NEAR.
import type { MaskStats } from '@maskwars/arena';
import { raceNo } from '@maskwars/arena/format';
import {
  accountState,
  type AccountState,
  allCopiesOf,
  type CopyChild,
  copyEarnings,
  copyTerms,
  type CopyTerms,
  getMask,
  type MaskView,
  nameOk,
  reserved,
  takeOut,
} from '@maskwars/forge';
import { FORGE_NET } from './forge';
import { readArena } from './arena';

/** What a mask's page shows about copying: the copies it has and what their author earned on them, or, when it is
 * itself a copy, the author it plays and what it owes. */
export interface CopyInfo {
  /** This mask may lend its strategy: it has a sealed one and is not itself a copy. Only then its owner opens it. */
  readonly lends: boolean;
  /** This mask lets others copy its strategy, and for what share. */
  readonly copyable: boolean;
  readonly authorBps: number;
  /** The masks that copy this one. */
  readonly copies: readonly CopyChild[];
  /** What the copies paid their author and counted for it, yoctoNEAR: it never goes down. */
  readonly earned: bigint;
  /** What waits for the author on its copies now (what `pay_author` would send), yoctoNEAR, and on how many copies. */
  readonly due: bigint;
  readonly waiting: readonly string[];
  /** Set when this mask is itself a copy: its author's name and its terms on chain. */
  readonly copyOf: { readonly name: string; readonly account: string; readonly bps: number; readonly terms: CopyTerms | null } | null;
}

export interface Person {
  readonly mask: MaskView;
  /** What its owner may take out now, yoctoNEAR. For a copy, this already leaves the author's owed share on the mask. */
  readonly takeOut: bigint;
  readonly account: AccountState | null;
  /** Its races on the arena and what they paid it; null until it raced, or when the arena cannot be read. */
  readonly stats: MaskStats | null;
  readonly rank: number | null;
  readonly copy: CopyInfo;
  readonly network: string;
}

/** Each copy's terms, read from its own account, a few at a time. */
async function termsOf(copies: readonly CopyChild[]): Promise<(CopyTerms | null)[]> {
  const out: (CopyTerms | null)[] = [];
  for (let i = 0; i < copies.length; i += 16) {
    const batch = copies.slice(i, i + 16).map((c) => copyTerms(FORGE_NET, c.account).catch(() => null));
    out.push(...(await Promise.all(batch)));
  }
  return out;
}

/** The person's mask named `name`, or null when the factory has none by that name. */
export async function readPerson(name: string): Promise<Person | null> {
  if (!nameOk(name) || reserved(name)) return null;
  const mask = await getMask(FORGE_NET, name).catch(() => null);
  if (!mask || mask.state === 'forging') return null;
  const [account, arena, children, ownTerms] = await Promise.all([
    accountState(FORGE_NET, mask.account),
    readArena().catch(() => null),
    mask.copies > 0 ? allCopiesOf(FORGE_NET, name, mask.copies).catch(() => []) : Promise.resolve<CopyChild[]>([]),
    mask.copy_of ? copyTerms(FORGE_NET, mask.account).catch(() => null) : Promise.resolve(null),
  ]);
  const i = arena ? arena.league.findIndex((m) => m.who.account === mask.account) : -1;
  const terms = children.length ? await termsOf(children) : [];
  const { earned, due } = copyEarnings(terms);
  const copy: CopyInfo = {
    lends: mask.strategy && !mask.copy_of,
    copyable: mask.copyable,
    authorBps: mask.author_bps,
    copies: children,
    earned,
    due,
    waiting: children.filter((_, k) => (terms[k]?.due ?? 0n) > 0n).map((c) => c.account),
    copyOf: mask.copy_of
      ? { name: mask.copy_of, account: `${mask.copy_of}.${FORGE_NET.factory}`, bps: mask.copy_bps, terms: ownTerms }
      : null,
  };
  // A copy's owner takes out what its own code would send them: the author's share is set aside first.
  const take = mask.copy_of ? (ownTerms?.owner ?? 0n) : takeOut(account);
  return {
    mask,
    takeOut: take > 0n ? take : 0n,
    account,
    stats: arena && i >= 0 ? arena.league[i]! : null,
    rank: i >= 0 ? i + 1 : null,
    copy,
    network: arena?.network ?? FORGE_NET.id,
  };
}

export { shareText } from '@maskwars/forge';

/** Where the mask stands, in a word and a line. Rounds with the people's masks open by hand for now, not on a schedule,
 * so the page names no race it cannot point at: a mask with fuel is ready, one without is out of fuel. */
export function stateOf(m: Pick<MaskView, 'state' | 'race' | 'brain'>): { key: string; word: string; note: string } {
  if (m.state === 'racing' && m.race) return { key: 'racing', word: 'Racing now', note: `In race ${raceNo(m.race.race)}` };
  if (m.state === 'paused') return { key: 'paused', word: 'Paused', note: 'Its owner paused it' };
  if (BigInt(m.brain) === 0n) return { key: 'empty', word: 'Out of fuel', note: 'Its mind has no NEAR left to race on' };
  return { key: 'ready', word: 'Ready to race', note: 'It races when a round with the people’s masks opens' };
}
