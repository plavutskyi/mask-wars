import { accountUrl } from '@maskwars/arena/config';
import { duration, near } from '@maskwars/arena/format';
import { look as lookOf, mind as mindOf, nearText, STYLES, times, timesText } from '@maskwars/forge';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { type Person, readableHistory, stateOf } from '@/lib/person';
import { day } from '@/lib/show';
import { CopyPanel } from './CopyPanel';
import { Header } from './Header';
import { HistoryPanel } from './HistoryPanel';
import { Info, type InfoRow } from './Info';
import { raceName } from './names';
import { Nums } from './Nums';
import { TakeOut } from './TakeOut';
import { titleEm } from './title';
import { World } from './World';
import s from './page.module.css';
import p from './person.module.css';

const TONE: Record<string, 'ember' | 'ice' | 'violet'> = { porcelain: 'ice', crimson: 'ember', graphite: 'violet' };

/** A person's mask: its face, its mind and style, what the arena paid it, its ×, and its prize for its owner. */
export function PersonPage({ person }: { person: Person }) {
  const { mask: m, stats, rank, takeOut, network } = person;
  const name = m.name.toUpperCase();
  const face = lookOf(m.look);
  const mind = mindOf(m.model);
  const style = STYLES.find((x) => x.id === m.style);
  const earned = stats?.earned ?? '0';
  const x = times(earned, m.fuel);
  const won = (stats?.breaks ?? 0) > 0;
  const state = stateOf(m);
  const facts: InfoRow[] = [
    { label: 'Account', value: m.account, href: accountUrl(m.account) },
    { label: 'Owner', value: m.owner, href: accountUrl(m.owner) },
    { label: 'Model, NEAR AI TEE', value: m.model },
    { label: 'Put in', value: `${nearText(m.fuel)} NEAR` },
    { label: 'Left for its mind', value: `${nearText(m.brain)} NEAR, up to ${nearText(m.race_limit)} a race` },
    { label: 'Its mind spent', value: `${nearText(m.spent, 4)} NEAR in ${m.races} ${m.races === 1 ? 'race' : 'races'}` },
    { label: 'Strategy', value: m.strategy ? 'Sealed: only its mind opens it, in a TEE' : 'None' },
    { label: 'Network', value: `NEAR ${network}` },
  ];

  return (
    <main className={s.page} data-tone={TONE[m.look] ?? 'ice'}>
      <World />
      <Header network={network} />

      <section className={s.hero} data-art={face ? '' : undefined}>
        <div className={s.heroText}>
          <p className={`${s.word} ${s.kicker}`}>
            <Nums text={rank ? `#${rank} in the league` : `Forged ${day(Number(BigInt(m.born_ns) / 1_000_000n))}`} />
          </p>
          <h1
            className={`${s.word} ${s.title} ${s.maskTitle}`}
            data-long={name.length > 8 ? '' : undefined}
            style={{ '--chars': name.length, '--em': titleEm(name) } as CSSProperties}
          >
            {name}
          </h1>
          <div className={`${s.big} ${p.big}`}>
            <span className={s.num} data-tone={won ? 'money' : 'plain'}>
              {near(earned)}
              <span className={`${s.word} ${s.unit}`}>NEAR</span>
            </span>
            <span className={p.times} data-on={x && x > 0 ? '' : undefined} aria-label={`${timesText(x)} on what was put in`}>
              {timesText(x)}
            </span>
            <Info rows={facts} label={`${name} on chain`} align="start" />
          </div>
          <p className={p.state} data-state={state.key}>
            <span className={`${s.word} ${p.stateWord}`}>{state.word}</span>
            <span className={p.stateNote}>{state.note}</span>
          </p>
          <dl className={s.stats}>
            <div>
              <dt className={s.word}>Breaks</dt>
              <dd>{stats?.breaks ?? 0}</dd>
            </div>
            <div>
              <dt className={s.word}>Races</dt>
              <dd>{Math.max(stats?.races ?? 0, m.races)}</dd>
            </div>
            <div>
              <dt className={s.word}>Tank</dt>
              <dd>
                {nearText(m.brain)}
                <span className={`${s.word} ${p.statUnit}`}>NEAR</span>
              </dd>
            </div>
          </dl>
          <ul className={p.mind} aria-label="Its mind">
            <li>
              <span className={`${s.word} ${p.mindLabel}`}>Mind</span>
              <span className={p.mindValue}>{mind?.name ?? m.model}</span>
            </li>
            <li>
              <span className={`${s.word} ${p.mindLabel}`}>Style</span>
              <span className={p.mindValue}>{style?.name ?? m.style}</span>
            </li>
            {m.strategy ? (
              <li>
                <span className={`${s.word} ${p.mindLabel}`}>Plan</span>
                <span className={p.mindValue}>Sealed</span>
              </li>
            ) : null}
          </ul>
        </div>
        <div className={s.heroArt} aria-hidden>
          {face ? (
            <Image src={face.art} alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 44vw" quality={85} className={s.heroMask} />
          ) : null}
        </div>
      </section>

      <CopyPanel person={person} />

      {takeOut > 0n ? (
        <TakeOut name={m.name} account={m.account} owner={m.owner} amount={takeOut.toString()} author={m.copy_of} />
      ) : null}

      {readableHistory(person.history) ? (
        <HistoryPanel name={m.name} account={m.account} owner={m.owner} viewers={person.history.viewers} events={person.history.events} />
      ) : null}

      {stats?.history.length ? (
        <section className={s.course} aria-labelledby="races">
          <h2 id="races" className={`${s.word} ${s.h2}`}>
            Races
          </h2>
          <ol className={s.rows}>
            {stats.history.map((h) => (
              <li key={h.id}>
                <Link href={`/race/${h.id}`} className={s.rowLink} data-won={h.won ? '' : undefined}>
                  <span className={`${s.word} ${s.rowName}`}>
                    <Nums text={raceName(h.id)} />
                  </span>
                  <span className={s.rowWhen}>{day(h.at)}</span>
                  <span className={s.rowResult}>
                    {h.won ? (h.breakMs !== null ? `Broke it in ${duration(h.breakMs)}` : 'Broke it') : h.phase === 'held' ? 'Held' : h.phase === 'broken' ? 'Beaten' : 'Racing'}
                  </span>
                  <span className={s.amount} data-tone={h.won ? 'money' : 'plain'}>
                    {h.won && h.takes ? `+${near(h.takes)} NEAR` : ''}
                  </span>
                  <span className={s.go} aria-hidden>
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <nav className={s.pager} aria-label="More">
        <span />
        <Link href="/forge" className={`${s.btn} ${s.word}`}>
          Forge your own
        </Link>
        <span />
      </nav>
    </main>
  );
}
