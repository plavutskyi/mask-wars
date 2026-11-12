// The round's safe, said plainly beside it: the arena's own target. MASK WARS puts the NEAR in, only the round's masks
// may take it out, and once the round is over the safe sends what is left back. Every fact behind «i» is the chain's.

import type { NextRace, Race, Who } from '@maskwars/arena';
import { accountUrl, HOUSE, SEASONS, txUrl } from '@maskwars/arena/config';
import { near } from '@maskwars/arena/format';
import { Info, type InfoRow } from './Info';
import infoStyle from './info.module.css';
import s from './target.module.css';

/** The line itself, in its three parts: the name plate, the words, and the last word that keeps the «i» beside it. */
const TAG = 'Arena target.';
const WORDS = 'MASK WARS funds it, the masks';
const LAST = 'break it.';

/** The line: what the safe is, who funds it and who breaks it. */
export const TARGET_LINE = `${TAG} ${WORDS} ${LAST}`;

/** The safe's code in the public repository: the same `set_owner` and `sweep` the masks break it with. */
export const SAFE_SOURCE = 'https://github.com/plavutskyi/mask-wars/blob/main/contracts/challenges/live-safe/src/lib.rs';

/** What the sheet behind the line tells about one round's safe, every fact from the chain or the network's file. */
export interface TargetFacts {
  /** The safe's account; null while the round's safe has no name yet. */
  readonly safe: string | null;
  /** Who puts the NEAR in: the account that opens the round (the house, a season treasury, the team). */
  readonly funder: string;
  /** What it put into the safe for this round, and the transaction; null before the round opens. */
  readonly funded: { readonly amount: string; readonly tx: string | null } | null;
  /** The masks of the round: only they may move the safe. */
  readonly masks: readonly Who[];
  /** The safe runs the house's vault code: once the round is over, `retire` sends all it holds back to the funder. */
  readonly retires: boolean;
  /** The round's own transactions, where the page has them. */
  readonly txs: { readonly open: string | null; readonly drain: string | null; readonly payout: string | null; readonly refund: string | null };
}

/** The house's vault, or a safe running its code: it retires itself once its round is over. */
function retiresHome(account: string | null, code: string | null): boolean {
  return (account !== null && account === HOUSE.vault) || (code !== null && HOUSE.safeCode !== null && code === HOUSE.safeCode);
}

/** One round on a safe, as a race holds it, or a safe's own record (the dossier's race line). */
type Round = Pick<Race, 'kind' | 'team' | 'masks' | 'events'> & { readonly txs: Pick<Race['txs'], 'open' | 'drain' | 'payout'> };

function facts(safe: string, code: string | null, r: Round, refund: string | null): TargetFacts {
  // What the team itself put in: a transfer anyone else sent the safe is not the arena's money.
  const own = r.events.filter((e) => e.kind === 'fund' && e.who?.account === r.team && e.amount !== null);
  const amount = own.reduce((sum, e) => sum + BigInt(e.amount!), 0n);
  return {
    safe,
    funder: r.team,
    funded: amount > 0n ? { amount: amount.toString(), tx: own[0]?.tx || null } : null,
    masks: r.masks,
    retires: retiresHome(safe, code),
    txs: { open: r.txs.open, drain: r.txs.drain, payout: r.txs.payout, refund: refund ?? (r.events.find((e) => e.kind === 'refund')?.tx || null) },
  };
}

/**
 * The target of a race, when it is the arena's own: a live safe one of the arena's teams opened and funded. Another
 * team's safe and a training target in the sandbox have no line: MASK WARS does not fund them.
 */
export function targetOf(race: Race): TargetFacts | null {
  if (race.kind !== 'safe' || !race.official) return null;
  return facts(race.target, race.targetCode, race, race.refund?.tx ?? null);
}

/** A safe's own page (/contract/<safe>): its newest round, when one of the arena's own teams opened it. */
export function safeTargetOf(account: string, code: string | null, newest: Round | undefined, teams: readonly string[]): TargetFacts | null {
  if (!newest || newest.kind !== 'safe' || !teams.includes(newest.team)) return null;
  return facts(account, code, newest, null);
}

/** The next round's safe, between rounds: the house's vault, or a season's `s<nnnn>.<season>`. Nothing is in it yet. */
export function nextTargetOf(next: NextRace): TargetFacts {
  const house = next.season === HOUSE.account;
  const safe = house ? HOUSE.vault : SEASONS.includes(next.season) ? `s${String(next.n).padStart(4, '0')}.${next.season}` : null;
  return {
    safe,
    funder: next.season,
    funded: null,
    masks: next.masks,
    retires: house || retiresHome(null, next.targetCode),
    txs: { open: null, drain: null, payout: null, refund: null },
  };
}

/** A mask by its name, its account beside it; a guest with no name of its own is a guest. */
const maskRow = (m: Who): InfoRow => ({ label: m.name && m.name !== m.account ? m.name : 'Guest', value: m.account, href: accountUrl(m.account) });

/** The sheet, row by row: who funds it, who can open it, where the rest goes, its code and its record on chain. */
export function targetRows(t: TargetFacts): InfoRow[] {
  return [
    { label: 'Funded by', value: t.funder, href: accountUrl(t.funder) },
    ...(t.funded ? [{ label: 'Put in', value: `${near(t.funded.amount)} NEAR`, href: t.funded.tx ? txUrl(t.funded.tx) : undefined }] : []),
    ...(t.masks.length ? [{ label: 'Who can open it', value: 'Only the masks of this round' }, ...t.masks.map(maskRow)] : []),
    ...(t.retires ? [{ label: 'After the round', value: `On retire, everything goes back to ${t.funder}` }] : []),
    { label: 'The code', value: 'live-safe/src/lib.rs', href: SAFE_SOURCE },
    ...(t.safe ? [{ label: 'On chain', value: t.safe, href: accountUrl(t.safe) }] : []),
  ];
}

/** The round's own steps on chain, as short links: opened, drained, paid, or the bounty back. */
export function roundLinks(t: TargetFacts): { text: string; href: string }[] {
  return [
    t.txs.open ? { text: 'Opened', href: txUrl(t.txs.open) } : null,
    t.txs.drain ? { text: 'Drained', href: txUrl(t.txs.drain) } : null,
    t.txs.payout ? { text: 'Paid', href: txUrl(t.txs.payout) } : null,
    t.txs.refund ? { text: 'Refunded', href: txUrl(t.txs.refund) } : null,
  ].filter((l) => l !== null);
}

/**
 * The line beside the safe, and its quiet «i». On a wide screen the sheet opens under the whole line: centred under a
 * centred line, from its first word under one that starts a column (`align="start"`).
 */
export function ArenaTarget({
  target,
  className,
  align = 'center',
}: {
  target: TargetFacts;
  className?: string | undefined;
  align?: 'start' | 'center';
}) {
  const links = roundLinks(target);
  return (
    <p className={[s.line, className].filter(Boolean).join(' ')}>
      <span className={s.tag}>{TAG}</span> {WORDS}{' '}
      <span className={s.last}>
        {LAST}
        <span className={s.info}>
          <Info rows={targetRows(target)} label="The arena target" align={align} anchor="line">
            {links.length ? (
              <span className={infoStyle.row}>
                <span className={infoStyle.k}>The round</span>
                <span className={s.links}>
                  {links.map((l, i) => (
                    <span key={l.text}>
                      {i > 0 ? (
                        <span className={s.dot} aria-hidden>
                          ·
                        </span>
                      ) : null}
                      <a className={`${infoStyle.v} ${s.step}`} href={l.href} target="_blank" rel="noreferrer">
                        {l.text}
                      </a>
                    </span>
                  ))}
                </span>
              </span>
            ) : null}
          </Info>
        </span>
      </span>
    </p>
  );
}
