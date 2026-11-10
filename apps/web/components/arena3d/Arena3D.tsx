'use client';

// The arena: a 3D scene behind a thin layer of type. The type (sum, clock, names, the payout) is real HTML,
// on screen from the first paint; the scene loads after it, only when the arena is in view, and fades in
// from black. Without WebGL the arena stays complete with the brand frames, or the page shows its own (`onFail`).

import Image from 'next/image';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { clock, count, countdown, span } from '@/lib/format';
import type { ArenaEngine, EngineInput } from './engine/engine';
import { digits, spoken, unitWord } from './format';
import { twoLines } from './headline';
import { lookKey } from './looks';
import { ArenaAudio } from './sound';
import { T } from './timing';
import type { Anchors, ArenaMoney, ArenaProps, ArenaState, MaskSlot } from './types';
import s from './arena3d.module.css';

const useIsoLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(q.matches);
    on();
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Remembers how we got into the current state, so the HUD can time its moments with the scene. */
function useArrival(state: ArenaState) {
  const ref = useRef<{ state: ArenaState; from: ArenaState | null; still: boolean }>({ state, from: null, still: true });
  if (ref.current.state !== state) ref.current = { state, from: ref.current.state, still: false };
  return ref.current;
}

const OPEN = (x: ArenaState | null) => x === 'breach' || x === 'paid';

export function Arena3D(props: ArenaProps) {
  const { state, vault, target, masks, attempts = [0, 0, 0], notes, winner = null, payout, startsAt, elapsed, line, lineIsAccount, headline, aside, now, insets, quality = 'auto', className } = props;
  const root = useRef<HTMLElement>(null);
  const hud = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<ArenaEngine | null>(null);
  const audio = useRef<ArenaAudio | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [tier, setTier] = useState<string>('');
  const [sound, setSound] = useState(false);
  const reduced = useReducedMotion();
  // The page's own sound and callbacks, read at the moment they fire: a new function from the page is not a new scene.
  const outer = useRef({ audio: props.audio, onReady: props.onReady, onFail: props.onFail });
  outer.current = { audio: props.audio, onReady: props.onReady, onFail: props.onFail };
  const tr = useArrival(state);
  const top = insets?.top ?? 0;
  const bottom = insets?.bottom ?? 0;

  // Arrays from props compare by content: a new array with the same numbers is not a new strike.
  const input = useMemo<EngineInput>(
    () => ({ state, masks, attempts, winner, reduced, quality }),
    [state, lookKey(masks[0]), lookKey(masks[1]), lookKey(masks[2]), attempts[0], attempts[1], attempts[2], winner, reduced, quality],
  );
  const inputRef = useRef(input);
  inputRef.current = input;
  const insetRef = useRef({ top, bottom });
  insetRef.current = { top, bottom };

  // Anchors from the scene land straight in CSS variables: no React render per frame.
  const onAnchors = useCallback((a: Anchors) => {
    const el = hud.current;
    if (!el) return;
    const set = (k: string, v: number) => el.style.setProperty(k, `${v.toFixed(2)}px`);
    set('--vx', a.vault.x);
    set('--vy', a.vault.y);
    a.masks.forEach((m, i) => {
      set(`--m${i}x`, m.x);
      set(`--m${i}b`, m.bottom);
    });
  }, []);

  // Load the scene once the arena is on screen and the page has painted.
  useEffect(() => {
    const el = root.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    let alive = true;
    let visible = false;
    let started = false;
    let made: ArenaEngine | null = null;
    const frame = () => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), ...insetRef.current };
    };
    const fail = () => {
      if (!alive) return;
      setFailed(true);
      outer.current.onFail?.();
    };
    const start = async () => {
      // No WebGL 2 here: keep the fallback and do not download the scene at all.
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) {
        fail();
        return;
      }
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      try {
        const { ArenaEngine } = await import('./engine/engine');
        if (!alive) return;
        made = new ArenaEngine(
          cv,
          {
            anchors: onAnchors,
            ready: () => {
              if (!alive) return;
              setReady(true);
              outer.current.onReady?.();
            },
            sound: (k, g) => (outer.current.audio ?? audio.current)?.play(k, g),
            tier: (t) => alive && setTier(t),
            slow: () => {
              // Even the simplest scene drops frames here: give the screen back to the page's fallback.
              if (!alive || !outer.current.onFail) return;
              made?.dispose();
              made = null;
              engine.current = null;
              fail();
            },
            lost: () => {
              if (!alive) return;
              setReady(false);
              made?.dispose();
              made = null;
              engine.current = null;
              window.setTimeout(() => alive && setGeneration((g) => g + 1), 600);
            },
          },
          inputRef.current.quality,
        );
        engine.current = made;
        made.resize(frame());
        made.set(inputRef.current);
        // Frames and shaders first, so the first frame on screen is the finished arena.
        await made.warm();
        if (!alive || !made) return;
        made.setActive(visible && !document.hidden);
      } catch {
        made?.dispose();
        made = null;
        engine.current = null;
        fail();
      }
    };
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      made?.setActive(visible && !document.hidden);
      if (visible && !made && !started) {
        started = true;
        const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        if (idle) idle(() => void start(), { timeout: 900 });
        else window.setTimeout(() => void start(), 120);
      }
    });
    io.observe(el);
    const ro = new ResizeObserver(() => made?.resize(frame()));
    ro.observe(el);
    const vis = () => {
      made?.setActive(visible && !document.hidden);
      audio.current?.setHidden(document.hidden);
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      alive = false;
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', vis);
      made?.dispose();
      engine.current = null;
    };
  }, [generation, onAnchors]);

  // The page's own interface moved: recompose, no reload.
  useEffect(() => {
    const el = root.current;
    if (!el || !engine.current) return;
    const r = el.getBoundingClientRect();
    engine.current.resize({ w: Math.round(r.width), h: Math.round(r.height), top, bottom });
  }, [top, bottom]);

  useEffect(() => {
    engine.current?.set(input);
  }, [input]);

  useEffect(() => () => audio.current?.dispose(), []);

  const toggleSound = async () => {
    audio.current ??= new ArenaAudio();
    if (audio.current.on) {
      audio.current.disable();
      setSound(false);
    } else {
      setSound(true);
      await audio.current.enable();
    }
  };

  // HUD timing: the payout number lands with the pulse; the sum lifts when the halves part.
  const fromOpen = OPEN(tr.from);
  const payoutDelay = tr.still || reduced ? 0 : (fromOpen ? 0 : T.payoutAfterBreach) + T.payoutFlight;
  const liftDelay = tr.still || reduced ? 0 : T.breachSplit;
  const paid: ArenaMoney | null = payout ?? vault;
  const win = winner;
  const own = outer.current.audio === undefined;

  // The line under the sum: the page's own words when it brings them, else the state's.
  let under: ReactNode = null;
  const head = headline !== undefined && !vault ? twoLines(headline) : null;
  if (line !== undefined && lineIsAccount) under = <span className={s.account}>{line}</span>;
  else if (line !== undefined) under = <Words text={line} className={state === 'breach' || state === 'paid' ? s.won : undefined} />;
  else if (state === 'idle' && startsAt !== undefined) under = <Countdown to={startsAt} now={now} />;
  else if (state === 'live' && target) under = <Words text={target} />;
  else if (state === 'breach') under = <Words text={elapsed !== undefined ? `Broken in ${span(elapsed)}` : 'Broken'} className={s.won} />;
  else if (state === 'held') under = <Words text={elapsed !== undefined ? `Held ${span(elapsed)}` : 'Held'} />;

  const style = { '--top': `${top}px`, '--bottom': `${bottom}px`, '--pay-delay': `${payoutDelay}ms`, '--lift-delay': `${liftDelay}ms` } as CSSProperties;

  return (
    <section
      ref={root}
      className={[s.root, className].filter(Boolean).join(' ')}
      style={style}
      data-state={state}
      data-ready={ready ? '' : undefined}
      data-still={tr.still ? '' : undefined}
      data-tier={tier || undefined}
      data-keep={state === 'paid' && line !== undefined ? '' : undefined}
      aria-label="Arena"
    >
      <div className={s.poster} aria-hidden />
      <canvas key={generation} ref={canvas} className={s.canvas} aria-hidden />
      <i className={s.vignette} aria-hidden />

      <div ref={hud} className={s.hud}>
        {failed && !props.onFail ? <Frames masks={masks} /> : null}

        <div className={s.vault}>
          <div
            className={s.stack}
            data-empty={vault ? undefined : ''}
            data-headline={head ? '' : undefined}
            style={head ? ({ '--chars': Math.max(8, ...head.map((l) => l.length)) } as CSSProperties) : undefined}
          >
            {vault ? <Money m={vault} className={s.sum} /> : head ? <Headline lines={head} /> : null}
            <div className={s.under} data-short={typeof line === 'string' && line.length <= 10 ? '' : undefined}>
              {under}
              {aside && (under || head) ? <span className={s.aside}>{aside}</span> : null}
            </div>
          </div>
        </div>

        {masks.map((m, i) => {
          // What the mask is doing, in the page's words; a live race without them counts the tries.
          const note = notes ? notes[i] : state === 'live' ? `${count(attempts[i] ?? 0)} ${attempts[i] === 1 ? 'try' : 'tries'}` : null;
          return (
            <div
              key={i}
              className={s.cap}
              data-slot={i}
              data-win={win === i ? '' : undefined}
              data-long={m.name.length > 8 ? '' : undefined}
              style={{ '--chars': Math.max(4, m.name.length) } as CSSProperties}
            >
              <span className={`${s.word} ${s.name}`}>{m.name}</span>
              {note ? <Note text={note} /> : null}
            </div>
          );
        })}

        {state === 'paid' && win !== null && paid ? <Payout money={paid} slot={win} name={masks[win].name} /> : null}
      </div>

      {own ? (
        <button type="button" className={s.sound} onClick={toggleSound} aria-pressed={sound} aria-label="Sound">
          <SpeakerIcon on={sound} />
        </button>
      ) : null}

      <p className={s.sr} aria-live="polite">
        {announce(state, vault, masks, win, paid)}
      </p>
    </section>
  );
}

function announce(state: ArenaState, vault: ArenaMoney | null, masks: ArenaProps['masks'], win: MaskSlot | null, paid: ArenaMoney | null): string {
  const who = win === null ? null : masks[win].name;
  if (state === 'idle') return vault ? `The vault holds ${spoken(vault)}. The race has not started.` : 'The vault is closed.';
  if (state === 'live') return `The race is on. ${masks.map((m) => m.name).join(', ')} are breaking the vault.`;
  if (state === 'breach') return who ? `${who} broke the vault.` : 'The vault is broken.';
  if (state === 'paid') return who && paid ? `${who} was paid ${spoken(paid)}.` : 'Paid.';
  return 'The vault held.';
}

function Money({ m, className }: { m: ArenaMoney; className?: string | undefined }) {
  const d = digits(m);
  const unit = unitWord(m);
  // Long amounts shrink to stay inside the door.
  const chars = d.length + (unit ? 2.4 : 0);
  return (
    <span className={className} style={{ '--chars': chars } as CSSProperties} aria-label={spoken(m)}>
      <span className={s.digits}>{d}</span>
      {unit ? <span className={`${s.word} ${s.unit}`}>{unit}</span> : null}
    </span>
  );
}

/** A line of words and numbers: words in Hubot, numbers in Mona (Hubot's zero is slashed, BRANDBOOK §4). */
function Words({ text, className }: { text: string; className?: string | undefined }) {
  return (
    <span className={[s.line, className].filter(Boolean).join(' ')}>
      {text.split(' ').map((t, i) => (
        <span key={i} className={/\d/.test(t) ? s.num : s.word}>
          {t}
        </span>
      ))}
    </span>
  );
}

/** The door's own message when there is no sum to show: “Vault held”, “No race yet”. */
function Headline({ lines }: { lines: string[] }) {
  return (
    <span className={`${s.word} ${s.headline}`}>
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </span>
  );
}

/** What a mask is doing, under its name: the words quiet, the numbers in the number face and bright. */
function Note({ text }: { text: string }) {
  return (
    <span className={s.note}>
      {text.split(/(\d[\d,.:]*)/).map((part, i) => (/\d/.test(part) ? <b key={i}>{part}</b> : part))}
    </span>
  );
}

function Countdown({ to, now }: { to: number; now?: number | undefined }) {
  // The clock is the browser's: until it has read it, the slots hold their width and show nothing.
  const [t, setT] = useState<number | null>(now ?? null);
  useEffect(() => {
    if (now !== undefined) {
      setT(now);
      return;
    }
    setT(Date.now());
    const id = window.setInterval(() => setT(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [now]);
  const text = t === null ? '00:00' : to - t > 0 ? countdown(to - t) : clock(0);
  return (
    <span className={s.count}>
      <span className={s.word}>Starts in</span>
      <span className={s.clock} data-wait={t === null ? '' : undefined}>
        {[...text].map((ch, i) => (
          <span key={i} className={/\d/.test(ch) ? s.slot : s.colon}>
            {ch}
          </span>
        ))}
      </span>
    </span>
  );
}

function Payout({ money, slot, name }: { money: ArenaMoney; slot: MaskSlot; name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // The block centres on the winner but never leaves the screen: its width feeds the clamp in CSS.
  useIsoLayout(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.style.setProperty('--pw', `${el.offsetWidth}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={s.payout} data-slot={slot}>
      <span className={s.plus}>
        <Money m={money} className={s.paid} />
      </span>
      <span className={`${s.word} ${s.payee}`}>{name}</span>
    </div>
  );
}

/** No WebGL: the arena still stands, in the brand frames. */
function Frames({ masks }: { masks: ArenaProps['masks'] }) {
  const art = (id: string) => (['onyx', 'nova', 'oracle', 'wraith', 'ronin', 'volt'].includes(id.toLowerCase()) ? `/art/${id.toLowerCase()}.webp` : '/art/onyx.webp');
  return (
    <>
      <div className={s.frameWorld} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill sizes="100vw" quality={75} />
      </div>
      <div className={s.frameVault} aria-hidden>
        <Image src="/art/vault.webp" alt="" fill sizes="(max-width: 760px) 86vw, 560px" quality={85} />
      </div>
      {masks.map((m, i) => (
        <div key={i} className={s.frameMask} data-slot={i} aria-hidden>
          <Image src={art(m.id)} alt="" fill sizes="240px" quality={75} />
        </div>
      ))}
    </>
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
      {on ? (
        <>
          <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
          <path d="M18 6.8a7.4 7.4 0 0 1 0 10.4" />
        </>
      ) : (
        <path d="M16 9.5l5 5M21 9.5l-5 5" />
      )}
    </svg>
  );
}
