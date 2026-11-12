'use client';

import { useEffect, useState } from 'react';
import { color } from '@maskwars/brand';
import { Arena3D, type ArenaMask, type ArenaQuality, type ArenaState } from '@/components/arena3d';
import s from './lab.module.css';

const STATES: readonly ArenaState[] = ['idle', 'live', 'breach', 'paid', 'held'];
const QUALITIES: readonly ArenaQuality[] = ['auto', 'high', 'mid', 'low'];

// Left Ember, middle Ice, right Violet: warm eyes on the left, Nova on the right.
const CASTS: Record<string, readonly [ArenaMask, ArenaMask, ArenaMask]> = {
  season: [
    { id: 'onyx', name: 'Onyx' },
    { id: 'oracle', name: 'Oracle' },
    { id: 'nova', name: 'Nova' },
  ],
  more: [
    { id: 'ronin', name: 'Ronin' },
    { id: 'wraith', name: 'Wraith' },
    { id: 'volt', name: 'Volt' },
  ],
  // A forged mask next to two of ours: its own finish, eyes and modifier, and a long name.
  forged: [
    { id: 'onyx', name: 'Onyx' },
    { id: 'forged', name: 'Nightjar Seven', look: { finish: 'porcelain', eyes: color.violet, modifier: 'seams' } },
    { id: 'nova', name: 'Nova' },
  ],
};
const CAST_ORDER = ['season', 'more', 'forged'] as const;

const pick = <T extends string>(list: readonly T[], v: string | undefined, d: T): T => (list.includes(v as T) ? (v as T) : d);

export function Lab(props: { state?: string | undefined; quality?: string | undefined; panel: boolean; insets: boolean; cast?: string | undefined }) {
  const [state, setState] = useState<ArenaState>(pick(STATES, props.state, 'idle'));
  const [quality, setQuality] = useState<ArenaQuality>(pick(QUALITIES, props.quality, 'auto'));
  const [cast, setCast] = useState(props.cast && CASTS[props.cast] ? props.cast : 'season');
  const [insets, setInsets] = useState(props.insets);
  const [attempts, setAttempts] = useState<[number, number, number]>([3, 7, 5]);
  const [startsAt, setStartsAt] = useState(() => Date.now() + 42_000);

  // A stand-in for a live race: attempts land at random while the masks work.
  useEffect(() => {
    if (state !== 'live') return;
    const id = window.setInterval(() => {
      setAttempts((a) => {
        const n = [...a] as [number, number, number];
        n[Math.floor(Math.random() * 3)]! += 1;
        return n;
      });
    }, 1100);
    return () => window.clearInterval(id);
  }, [state]);

  const go = (next: ArenaState) => {
    if (next === 'idle') setStartsAt(Date.now() + 42_000);
    setState(next);
  };

  return (
    <main className={s.screen}>
      {insets ? (
        <header className={s.head} aria-hidden>
          <span className={s.mark} />
        </header>
      ) : null}
      <Arena3D
        state={state}
        vault={{ amount: 3, unit: 'NEAR' }}
        target="Live vault"
        masks={CASTS[cast]!}
        attempts={attempts}
        winner={2}
        payout={{ amount: 0.08664, unit: 'NEAR' }}
        startsAt={startsAt}
        elapsed={state === 'held' ? 24 * 3600_000 : 44_000}
        insets={insets ? { top: 64, bottom: 120 } : undefined}
        quality={quality}
      />
      {insets ? (
        <footer className={s.deck} aria-hidden>
          <span className={s.btn}>Forge your mask</span>
        </footer>
      ) : null}

      {props.panel ? (
        <nav className={s.panel} aria-label="Arena lab">
          <div className={s.row}>
            {STATES.map((k) => (
              <button key={k} type="button" className={s.chip} aria-pressed={state === k} onClick={() => go(k)}>
                {k}
              </button>
            ))}
          </div>
          <div className={s.row}>
            {QUALITIES.map((k) => (
              <button key={k} type="button" className={s.chip} aria-pressed={quality === k} onClick={() => setQuality(k)}>
                {k}
              </button>
            ))}
            {CAST_ORDER.map((k) => (
              <button key={k} type="button" className={s.chip} aria-pressed={cast === k} onClick={() => setCast(k)}>
                {k}
              </button>
            ))}
            <button type="button" className={s.chip} aria-pressed={insets} onClick={() => setInsets(!insets)}>
              page ui
            </button>
          </div>
        </nav>
      ) : null}
    </main>
  );
}
