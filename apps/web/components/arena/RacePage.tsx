import type { Race, RaceEvent, Who } from '@maskwars/arena';
import { accountUrl, txUrl } from '@maskwars/arena/config';
import { duration, near } from '@maskwars/arena/format';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { artOf, day, eventLine, longest, shortAccount, toneOf, utc } from '@/lib/show';
import { Mark } from '../Mark';
import { Clock } from './Clock';
import { Header } from './Header';
import { Info, type InfoRow } from './Info';
import { raceName, raceTitle } from './names';
import { Nums } from './Nums';
import { Refresh } from './Refresh';
import { World } from './World';
import s from './page.module.css';

function title(r: Race): string {
  if (r.phase === 'broken') {
    if (!r.winner?.mask) return 'Broken';
    return r.kind === 'safe' ? `${r.winner.name} broke the safe` : `${r.winner.name} broke ${r.target}`;
  }
  if (r.phase === 'sealing') return 'Masks are sealing';
  if (r.phase === 'racing') return 'The safe is open';
  return r.kind === 'safe' ? 'The vault held' : 'Nobody got through';
}

/** +8:13 from the opening; −0:26 before it. */
function offset(at: number, from: number | null): string {
  if (from === null) return '';
  const d = at - from;
  return `${d < 0 ? '−' : '+'}${duration(Math.abs(d))}`;
}

function amountTone(e: RaceEvent): 'money' | 'plain' {
  return e.kind === 'drain' || e.kind === 'paid' ? 'money' : 'plain';
}

/** The headline. A long mask name narrows on the width axis, then gives up size, so it never leaves the column (§4). */
function Title({ text }: { text: string }) {
  const chars = longest(text);
  return (
    <h1 className={`${s.word} ${s.title}`} data-long={chars > 10 ? '' : undefined} style={{ '--chars': chars } as CSSProperties}>
      {text}
    </h1>
  );
}

/** Six masks at a glance, the winner among them; a bigger field opens with one tap. */
const CHIPS = 6;

function Chips({ race: r }: { race: Race }) {
  const won = r.winner?.account;
  const first = r.masks.slice(0, CHIPS);
  if (won && !first.some((m) => m.account === won)) {
    const w = r.masks.find((m) => m.account === won);
    if (w) first.splice(CHIPS - 1, 1, w);
  }
  const rest = r.masks.filter((m) => !first.includes(m));
  const chip = (m: Who) => <MaskChip key={m.account} who={m} won={won === m.account} race={r} />;
  return (
    <div className={s.field}>
      <ul className={s.chips} aria-label="Masks in the race">
        {first.map(chip)}
      </ul>
      {rest.length ? (
        <details className={s.moreChips}>
          <summary className={s.moreSummary}>
            <span className={s.moreCount}>+{rest.length}</span>
            <span className={`${s.word} ${s.moreWord}`}>{rest.length === 1 ? 'mask' : 'masks'}</span>
          </summary>
          <ul className={s.chips} aria-label="More masks in the race">
            {rest.map(chip)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function MaskChip({ who, won, race }: { who: Who; won: boolean; race: Race }) {
  const art = artOf(who);
  const body = (
    <>
      <span className={s.chipFace}>{art ? <Image src={art} alt="" fill sizes="56px" quality={75} /> : <Mark className={s.faceMark} />}</span>
      <span className={`${s.word} ${s.chipName}`} data-long={who.name.length > 8 ? '' : undefined}>
        {who.name}
      </span>
    </>
  );
  return (
    <li className={s.chip} data-tone={toneOf(who)} data-won={won ? '' : undefined} data-out={race.phase === 'broken' && !won ? '' : undefined}>
      {who.slug ? (
        <Link href={`/mask/${who.slug}`} className={s.chipLink}>
          {body}
        </Link>
      ) : (
        <span className={s.chipLink}>{body}</span>
      )}
    </li>
  );
}

export function RacePage({ race: r, prev, next }: { race: Race; prev: Race | null; next: Race | null }) {
  const winner = r.winner;
  const art = r.phase === 'broken' ? artOf(winner) : null;
  const number = r.phase === 'broken' ? r.takes : r.phase === 'held' ? (r.refund?.amount ?? r.bounty) : r.prize;
  const numberTone = r.phase === 'broken' ? 'money' : 'plain';

  const facts: InfoRow[] = [
    { label: 'Id', value: r.id },
    { label: 'Contract', value: r.contract, href: accountUrl(r.contract) },
    { label: r.kind === 'safe' ? 'Safe' : 'Target', value: r.target, href: r.kind === 'safe' ? accountUrl(r.target) : undefined },
    ...(r.targetCode ? [{ label: 'Target fingerprint', value: r.targetCode }] : []),
    { label: 'Team', value: r.team, href: accountUrl(r.team) },
    ...(r.locked ? [{ label: 'Bounty locked', value: `${near(r.locked)} NEAR`, href: r.txs.open ? txUrl(r.txs.open) : undefined }] : []),
    ...(r.safeFunded ? [{ label: 'In the safe at the start', value: `${near(r.safeFunded)} NEAR` }] : []),
    ...(r.minLoot ? [{ label: 'A drain counts from', value: `${near(r.minLoot)} NEAR` }] : []),
    ...(r.loot ? [{ label: 'Taken from the safe', value: `${near(r.loot)} NEAR`, href: r.txs.drain ? txUrl(r.txs.drain) : undefined }] : []),
    ...(r.payout ? [{ label: 'Bounty paid', value: `${near(r.payout.amount)} NEAR`, href: r.payout.tx ? txUrl(r.payout.tx) : undefined }] : []),
    ...(winner ? [{ label: 'Winner', value: winner.account, href: accountUrl(winner.account) }] : []),
    ...(r.judge ? [{ label: 'Judge (OutLayer, TEE)', value: r.judge }] : []),
    ...(r.runId ? [{ label: 'Sandbox run', value: r.runId }] : []),
    { label: 'Deadline', value: utc(r.deadline) },
    { label: 'Network', value: `NEAR ${r.network}` },
  ];

  const sub =
    r.phase === 'broken'
      ? [r.breakMs !== null ? `in ${duration(r.breakMs)}` : null, winner && !winner.mask ? (winner.account === r.team ? "paid to the team's own account" : `to ${shortAccount(winner.account)}`) : null].filter(Boolean).join(' · ')
      : r.phase === 'held'
        ? 'back to the team'
        : 'on the line';

  return (
    <main className={s.page} data-phase={r.phase}>
      <World />
      {r.live || r.phase === 'sealing' || r.phase === 'racing' ? <Refresh everyMs={r.live ? 5_000 : 30_000} /> : null}
      <Header live={r.live} network={r.network} here="race" />

      <section className={s.hero} data-art={art ? '' : undefined}>
        <div className={s.heroText}>
          <p className={`${s.word} ${s.kicker}`}>
            <Nums text={`${raceTitle(r.id)} · ${day(r.openedAt)}`} />
          </p>
          <Title text={title(r)} />
          <div className={s.big}>
            <span className={s.num} data-tone={numberTone}>
              {near(number)}
              <span className={`${s.word} ${s.unit}`}>NEAR</span>
            </span>
            <Info rows={facts} label="The race on chain" align="start" />
          </div>
          <p className={s.sub}>
            {r.phase === 'sealing' && r.startsAt ? (
              <>
                starts in <Clock to={r.startsAt} className={s.clock} />
              </>
            ) : r.phase === 'racing' ? (
              <>
                closes in <Clock to={r.deadline} className={s.clock} />
              </>
            ) : (
              sub
            )}
          </p>
          {r.masks.length ? <Chips race={r} /> : null}
        </div>
        <div className={s.heroArt} aria-hidden>
          {art ? (
            <Image src={art} alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 44vw" quality={85} className={s.heroMask} />
          ) : (
            <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 40vw" quality={85} className={s.heroVault} />
          )}
        </div>
      </section>

      <section className={s.course} aria-labelledby="course">
        <h2 id="course" className={`${s.word} ${s.h2}`}>
          The race
        </h2>
        <ol className={s.steps}>
          {r.events.map((e, i) => (
            <li key={`${e.tx}-${e.kind}-${i}`} className={s.step} data-kind={e.kind} data-quiet={e.kind === 'claim' && e.verdict !== 'paid' ? '' : undefined}>
              <span className={s.when}>{offset(e.at, r.openedAt)}</span>
              <span className={s.what}>
                {eventLine(e, r.team)}
                {e.kind === 'drain' ? <span className={`${s.word} ${s.tag}`}>The break</span> : null}
              </span>
              <span className={s.amount} data-tone={amountTone(e)}>
                {e.amount ? `${near(e.amount)} NEAR` : ''}
              </span>
              <span className={s.stepInfo}>
                <Info
                  align="end"
                  label="This step on chain"
                  rows={[
                    { label: 'Time', value: utc(e.at) },
                    ...(e.who ? [{ label: 'Who', value: e.who.account, href: accountUrl(e.who.account) }] : []),
                    ...(e.method ? [{ label: 'Call', value: e.method }] : []),
                    ...(e.tx ? [{ label: 'Transaction', value: e.tx, href: txUrl(e.tx) }] : []),
                  ]}
                />
              </span>
            </li>
          ))}
        </ol>
      </section>

      <nav className={s.pager} aria-label="Races">
        {prev ? (
          <Link href={`/race/${prev.id}`} className={s.pagerLink}>
            <span aria-hidden>←</span> {raceName(prev.id)}
          </Link>
        ) : (
          <span />
        )}
        <Link href="/league" className={`${s.btn} ${s.word}`}>
          The league
        </Link>
        {next ? (
          <Link href={`/race/${next.id}`} className={s.pagerLink}>
            {raceName(next.id)} <span aria-hidden>→</span>
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </main>
  );
}
