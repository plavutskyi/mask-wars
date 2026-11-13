import { look as lookOf, nearText } from '@maskwars/forge';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { Forged as ForgedList } from '@/lib/forged';
import { lookTone } from '@/lib/show';
import { Mark } from '../Mark';
import c from './callers.module.css';
import f from './forged.module.css';
import s from './page.module.css';

/** A space a line never breaks at: a number stays with its word, and a line breaks only after a dot. */
const NB = ' ';
const count = (n: number, one: string) => `${n}${NB}${n === 1 ? one : `${one}s`}`;

/**
 * The masks people forged, on the league page: under the arena's own table and in its rows. The face of its look, its
 * name, how often it raced and broke a vault, what its mind has left to race on. Each row opens the mask's own page.
 */
export function Forged({ forged }: { forged: ForgedList }) {
  return (
    <section className={c.callers} aria-labelledby="forged">
      <div className={c.head}>
        <h2 id="forged" className={`${c.word} ${c.title}`}>
          Forged masks
        </h2>
        <div className={f.side}>
          <p className={c.sub}>Made by people on the forge</p>
          <Link href="/forge" className={`${s.word} ${f.yours}`}>
            Forge yours
          </Link>
        </div>
      </div>
      <div className={`${s.tr} ${s.th} ${f.row} ${f.labels}`} aria-hidden>
        <span className={s.word}>Mask</span>
        <span className={`${s.word} ${s.cBreaks}`}>Races</span>
        <span className={`${s.word} ${s.cBreaks}`}>Breaks</span>
        <span className={`${s.word} ${s.cTaken}`}>Tank</span>
      </div>
      <ol className={s.tbody}>
        {forged.masks.map((m) => {
          const NAME = m.name.toUpperCase();
          const art = lookOf(m.look)?.art;
          const tank = nearText(m.tank);
          return (
            <li key={m.name} className={`${s.tr} ${f.row}`} data-tone={lookTone(m.look)}>
              <Link href={`/mask/${m.name}`} className={`${s.who} ${f.who}`}>
                <span className={s.whoFace}>{art ? <Image src={art} alt="" fill sizes="72px" quality={75} /> : <Mark className={s.faceMark} />}</span>
                <span className={s.whoText}>
                  <span className={`${s.word} ${s.whoName}`} data-long={NAME.length > 8 ? '' : undefined} style={{ '--chars': NAME.length } as CSSProperties}>
                    {NAME}
                  </span>
                  <span className={`${s.word} ${f.state}`} data-state={m.state.key}>
                    {m.state.word}
                  </span>
                  <span className={`${s.whoSub} ${f.sub}`}>
                    <span className={s.whoMoney}>{`${tank}${NB}NEAR`}</span>
                    {`${NB}tank${NB}· ${count(m.races, 'race')}${NB}· ${count(m.breaks, 'break')}`}
                  </span>
                </span>
              </Link>
              <span className={`${s.cell} ${s.cBreaks}`}>{m.races}</span>
              <span className={`${s.cell} ${s.cBreaks}`}>{m.breaks}</span>
              <span className={`${s.cell} ${s.cTaken}`}>
                {tank}
                <span className={`${s.word} ${s.cellUnit}`}>NEAR</span>
              </span>
            </li>
          );
        })}
      </ol>
      {forged.more > 0 ? <p className={f.more}>and {forged.more} more</p> : null}
    </section>
  );
}
