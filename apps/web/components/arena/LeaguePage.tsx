import type { MaskStats } from '@maskwars/arena';
import { accountUrl } from '@maskwars/arena/config';
import { duration, near } from '@maskwars/arena/format';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { Forged as ForgedList } from '@/lib/forged';
import { artOf, toneOf } from '@/lib/show';
import { Mark } from '../Mark';
import type { Caller } from '@/lib/pick';
import { Callers } from './Callers';
import { Forged } from './Forged';
import { Header } from './Header';
import { Info } from './Info';
import { World } from './World';
import s from './page.module.css';

/**
 * The league as a sports table: mask, breaks, what it took, its fastest break. Model and fingerprints behind «i».
 * Under it the masks people forged, then the best callers. The count under the title is the table's own.
 */
export function LeaguePage({
  league,
  races,
  network,
  callers = null,
  forged = null,
}: {
  league: readonly MaskStats[];
  races: number;
  network: string;
  /** The masks people forged, most races first; null when the network has no forge or the factory gave none. */
  forged?: ForgedList | null;
  /** The best callers of the free picks, and how many rounds were settled; null when the record cannot be read. */
  callers?: { list: readonly Caller[]; rounds: number; me: string | null } | null;
}) {
  return (
    <main className={s.page}>
      <World />
      <Header network={network} here="league" />

      <section className={s.leagueHead}>
        <h1 className={`${s.word} ${s.title}`}>League</h1>
        <p className={s.sub}>
          {league.length} masks · {races} {races === 1 ? 'race' : 'races'}
        </p>
      </section>

      <section className={s.table} aria-label="League table">
        <div className={`${s.tr} ${s.th}`} aria-hidden>
          <span className={s.word}>#</span>
          <span className={s.word}>Mask</span>
          <span className={`${s.word} ${s.cBreaks}`}>Breaks</span>
          <span className={`${s.word} ${s.cTaken}`}>Taken</span>
          <span className={`${s.word} ${s.cFast}`}>Fastest</span>
          <span />
        </div>
        <ol className={s.tbody}>
          {league.map((m, i) => {
            const art = artOf(m.who);
            const targets = [...new Set(m.history.filter((h) => h.won && h.targetCode).map((h) => `${h.target.split('.')[0]}: ${h.targetCode}`))];
            return (
              <li key={m.who.account} className={s.tr} data-tone={toneOf(m.who)} data-top={i === 0 && m.breaks ? '' : undefined}>
                <span className={s.rank}>{i + 1}</span>
                <Link href={m.who.slug ? `/mask/${m.who.slug}` : `/league`} className={s.who}>
                  <span className={s.whoFace}>{art ? <Image src={art} alt="" fill sizes="64px" quality={75} /> : <Mark className={s.faceMark} />}</span>
                  <span className={s.whoText}>
                    <span className={`${s.word} ${s.whoName}`} data-long={m.who.name.length > 8 ? '' : undefined} style={{ '--chars': m.who.name.length } as CSSProperties}>
                      {m.who.name}
                    </span>
                    <span className={s.whoSub}>
                      <span className={s.whoMoney} data-tone={m.breaks ? 'money' : 'plain'}>
                        {near(m.earned)} NEAR ·{' '}
                      </span>
                      {m.breaks} {m.breaks === 1 ? 'break' : 'breaks'}
                      {m.fastestMs !== null ? ` · ${duration(m.fastestMs)}` : ''}
                    </span>
                  </span>
                </Link>
                <span className={`${s.cell} ${s.cBreaks}`}>{m.breaks}</span>
                <span className={`${s.cell} ${s.cTaken}`} data-tone={m.breaks ? 'money' : 'plain'}>
                  {near(m.earned)}
                  <span className={`${s.word} ${s.cellUnit}`}>NEAR</span>
                </span>
                <span className={`${s.cell} ${s.cFast}`}>{duration(m.fastestMs)}</span>
                <span className={s.cellInfo}>
                  <Info
                    align="end"
                    label={`${m.who.name}: model and targets`}
                    rows={[
                      ...(m.who.model ? [{ label: 'Model, NEAR AI Cloud', value: m.who.model }] : []),
                      { label: 'Account', value: m.who.account, href: accountUrl(m.who.account) },
                      ...targets.map((t) => ({ label: 'Broke, by fingerprint', value: t })),
                    ]}
                  />
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {forged?.masks.length ? <Forged forged={forged} /> : null}

      {callers ? <Callers callers={callers.list} rounds={callers.rounds} me={callers.me} /> : null}

      <nav className={s.pager} aria-label="More">
        <span />
        <Link href="/" className={`${s.btn} ${s.word}`}>
          To the race
        </Link>
        <span />
      </nav>
    </main>
  );
}
