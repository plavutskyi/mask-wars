import type { MaskStats } from '@maskwars/arena';
import { accountUrl } from '@maskwars/arena/config';
import { duration, near } from '@maskwars/arena/format';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { artOf, day, toneOf } from '@/lib/show';
import { Mark } from '../Mark';
import { Header } from './Header';
import { Info, type InfoRow } from './Info';
import { raceName } from './names';
import { Nums } from './Nums';
import { World } from './World';
import s from './page.module.css';

export function MaskPage({ mask: m, rank, network }: { mask: MaskStats; rank: number; network: string }) {
  const art = artOf(m.who);
  const best = m.fastestRace ?? m.history.find((h) => h.won)?.id ?? m.history[0]?.id ?? null;
  const targets = [...new Set(m.history.filter((h) => h.won && h.targetCode).map((h) => `${h.target.split('.')[0]}: ${h.targetCode}`))];
  const facts: InfoRow[] = [
    { label: 'Account', value: m.who.account, href: accountUrl(m.who.account) },
    ...(m.who.model ? [{ label: 'Model, NEAR AI Cloud', value: m.who.model }] : []),
    ...targets.map((t) => ({ label: 'Broke, by fingerprint', value: t })),
    { label: 'Network', value: `NEAR ${network}` },
  ];

  return (
    <main className={s.page} data-tone={toneOf(m.who)}>
      <World />
      <Header network={network} />

      <section className={s.hero} data-art={art ? '' : undefined}>
        <div className={s.heroText}>
          <p className={`${s.word} ${s.kicker}`}>
            <Nums text={`#${rank} in the league`} />
          </p>
          <h1
            className={`${s.word} ${s.title} ${s.maskTitle}`}
            data-long={m.who.name.length > 8 ? '' : undefined}
            style={{ '--chars': m.who.name.length } as CSSProperties}
          >
            {m.who.name}
          </h1>
          <div className={s.big}>
            <span className={s.num} data-tone={m.breaks ? 'money' : 'plain'}>
              {near(m.earned)}
              <span className={`${s.word} ${s.unit}`}>NEAR</span>
            </span>
            <Info rows={facts} label={`${m.who.name} on chain`} align="start" />
          </div>
          <dl className={s.stats}>
            <div>
              <dt className={s.word}>Breaks</dt>
              <dd>{m.breaks}</dd>
            </div>
            <div>
              <dt className={s.word}>Fastest</dt>
              <dd>{duration(m.fastestMs)}</dd>
            </div>
            <div>
              <dt className={s.word}>Races</dt>
              <dd>{m.races}</dd>
            </div>
          </dl>
        </div>
        <div className={s.heroArt} aria-hidden>
          {art ? <Image src={art} alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 44vw" quality={85} className={s.heroMask} /> : <Mark className={s.heroMark} />}
        </div>
      </section>

      {m.history.length ? (
        <section className={s.course} aria-labelledby="races">
          <h2 id="races" className={`${s.word} ${s.h2}`}>
            Races
          </h2>
          <ol className={s.rows}>
            {m.history.map((h) => (
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
        {best ? (
          <Link href={`/race/${best}`} className={`${s.btn} ${s.word}`}>
            {m.breaks ? 'See the break' : 'See the race'}
          </Link>
        ) : (
          <Link href="/league" className={`${s.btn} ${s.word}`}>
            The league
          </Link>
        )}
        <span />
      </nav>
    </main>
  );
}
