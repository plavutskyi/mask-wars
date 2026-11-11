'use client';

import type { Entry, RoundBrief } from '@/lib/pick';
import { choiceName, verdictOf } from '@/lib/pick';
import { shareCall, streakOn, useStanding } from './Pick';
import s from './pick.module.css';

/**
 * A person's call on this round, on its page: what they picked (still open to change on the home page until the
 * round's first seal) and, once the chain has said how it ended, whether they called it, their run, and the share.
 */
export function RaceCall({ round, mine, open = false }: { round: RoundBrief; mine: Entry; open?: boolean }) {
  const [standing] = useStanding(round.id, round.outcome !== null);
  const name = choiceName(mine.choice, round.masks);
  if (round.outcome === null) {
    return (
      <div className={s.call} role="status">
        <span className={s.label}>Your pick</span>
        <span className={s.value}>{name}</span>
        <span className={s.aside}>{open ? 'Picks still open' : round.judging ? 'Judge checking' : 'Locked in'}</span>
      </div>
    );
  }
  const right = verdictOf(mine.choice, round.outcome) === 'right';
  const streak = streakOn(standing, round, mine);
  const token = standing?.share ?? null;
  return (
    <div className={s.call} role="status">
      {right ? (
        <span className={`${s.verdict} ${s.word}`}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 8.5l3.2 3L13 4.5" />
          </svg>
          You called it
        </span>
      ) : (
        <span className={s.label}>You picked</span>
      )}
      <span className={s.value}>{name}</span>
      {streak !== null ? (
        <span className={s.streak}>
          <b>{streak}</b> in a row
        </span>
      ) : null}
      <button type="button" className={s.callShare} onClick={() => (token ? shareCall(round, mine, token, streak) : undefined)} disabled={!token} aria-label="Share your call on X">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M6 3H3v10h10v-3M9 2h5v5M14 2L7 9" />
        </svg>
        <span className={s.word}>Share</span>
      </button>
    </div>
  );
}
