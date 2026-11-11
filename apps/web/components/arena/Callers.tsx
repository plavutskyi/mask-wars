import { type Caller, callerName } from '@/lib/pick';
import s from './callers.module.css';

/**
 * The best callers: the people who named the mask that broke the vault, or the vault that held, before the round. By
 * rounds called right, then the longest run. Free picks, no prize: the table is the prize.
 */
export function Callers({ callers, rounds, me }: { callers: readonly Caller[]; rounds: number; me: string | null }) {
  return (
    <section className={s.callers} aria-labelledby="callers">
      <div className={s.head}>
        <h2 id="callers" className={`${s.word} ${s.title}`}>
          Best callers
        </h2>
        <p className={s.sub}>Called the breaker before the round</p>
      </div>
      {callers.length ? (
        <ol className={s.list}>
          {callers.map((c, i) => (
            <li key={c.who} className={s.row} data-top={i === 0 ? '' : undefined} data-me={c.who === me ? '' : undefined}>
              <span className={s.rank}>{i + 1}</span>
              <span className={s.name}>
                {callerName(c.who)}
                {c.who === me ? <span className={`${s.word} ${s.you}`}>You</span> : null}
              </span>
              <span className={s.stat}>
                <b>{c.right}</b>
                <span className={s.of}>/{c.calls}</span>
                <span className={s.unit}>called</span>
              </span>
              <span className={s.stat} data-run="">
                <b>{c.best}</b>
                <span className={s.unit}>
                  best<span className={s.wide}> run</span>
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className={s.empty}>{rounds ? 'No round called yet. The first right call tops this table.' : 'The first round with picks opens this table.'}</p>
      )}
    </section>
  );
}
