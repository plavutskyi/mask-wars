'use client';

import type { Race, RaceEvent, Who } from '@maskwars/arena';
import { accountUrl, NETWORK, txUrl } from '@maskwars/arena/config';
import { duration, near, raceNo } from '@maskwars/arena/format';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { artOf, day, isAccount, shortAccount, targetName, toneOf } from '@/lib/show';
import { ArenaAudio } from '../arena3d/sound';
import type { ArenaState } from '../arena3d/types';
import { Arrow } from '../Arrow';
import { Mark } from '../Mark';
import { Header } from './Header';
import { Info, type InfoRow } from './Info';
import { Nums } from './Nums';
import { type Scene, sceneOf } from './scene';
import s from './stage.module.css';

// The 3D arena is its own chunk with three.js inside: it is fetched only once the page has loaded and gone quiet,
// and only on a device that wants motion. Until then, and wherever it cannot run, the flat stage below is the arena.
const Arena3D = dynamic(() => import('../arena3d/Arena3D').then((m) => m.Arena3D), { ssr: false, loading: () => null });

/** What one mask has done in the race so far, from its moves on chain. */
function standing(who: Who, events: readonly RaceEvent[]): { heat: number; text: string } {
  const mine = events.filter((e) => e.who?.account === who.account);
  if (mine.some((e) => e.kind === 'drain')) return { heat: 1, text: 'Drained it' };
  if (mine.some((e) => e.kind === 'claim' && e.verdict === 'waiting')) return { heat: 0.9, text: 'Claiming' };
  if (mine.some((e) => e.kind === 'reveal' && e.ok)) return { heat: 0.8, text: 'Plan shown' };
  if (mine.some((e) => e.kind === 'move' && e.ok)) return { heat: 0.6, text: 'On the safe' };
  const seal = mine.find((e) => e.kind === 'seal');
  if (seal) return { heat: 0.35, text: `Sealed #${(seal.seq ?? 0) + 1}` };
  return { heat: 0.1, text: 'In the race' };
}

/** The stage holds three masks: the ones closest to the safe, in their race order. The rest are one tap away. */
const ON_STAGE = 3;

function onStage(heats: readonly { heat: number }[]): number[] {
  return heats
    .map((h, i) => ({ h: h.heat, i }))
    .sort((a, b) => b.h - a.h || a.i - b.i)
    .slice(0, ON_STAGE)
    .map((x) => x.i)
    .sort((a, b) => a - b);
}

function Digits({ text }: { text: string }) {
  return (
    <span className={s.digits}>
      {[...text].map((ch, i) => (
        <span key={i} className={/\d/.test(ch) ? s.slot : s.colon}>
          {ch}
        </span>
      ))}
    </span>
  );
}

/** 03:12 counting, 23:58:40 past the hour; never negative. */
function clock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

type Mode = 'flat' | 'load' | 'on';

/**
 * A real GPU behind WebGL 2. Without one the browser draws in software (SwiftShader, llvmpipe): every frame of the
 * arena would hold the main thread, so the flat arena stays. `failIfMajorPerformanceCaveat` is the browser's own word.
 */
function hardwareGl(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !/swiftshader|llvmpipe|softpipe|software/i.test(renderer);
  } catch {
    return false;
  }
}

/**
 * Whether the 3D arena runs here. Never with reduced motion, on Save-Data, without a GPU, on a single core or under
 * 2 GB of memory; elsewhere it starts once the page has loaded and the main thread is idle, so the first screen never
 * waits for it. The arena itself gives the screen back (`fail`) when frames stay slow.
 */
function useThree(possible: boolean): { mode: Mode; ready: () => void; fail: () => void } {
  const [mode, setMode] = useState<Mode>('flat');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!possible || failed) return;
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    if (nav.connection?.saveData || (nav.deviceMemory ?? 4) < 2 || (nav.hardwareConcurrency || 4) < 2) return;
    let alive = true;
    let timer = 0;
    let idle = 0;
    const ric = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const start = () => {
      if (!alive || q.matches) return;
      window.clearTimeout(timer);
      // A beat after the load, then the first idle moment: the page answers first, the show comes after.
      timer = window.setTimeout(() => {
        const go = () => {
          if (!alive || q.matches) return;
          if (!hardwareGl()) {
            setFailed(true);
            return;
          }
          setMode((m) => (m === 'flat' ? 'load' : m));
        };
        if (ric.requestIdleCallback) idle = ric.requestIdleCallback(go, { timeout: 2500 });
        else go();
      }, 1800);
    };
    const motion = () => {
      if (q.matches) setMode('flat');
      else start();
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    q.addEventListener('change', motion);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      if (idle) ric.cancelIdleCallback?.(idle);
      window.removeEventListener('load', start);
      q.removeEventListener('change', motion);
    };
  }, [possible, failed]);
  return {
    mode: possible && !failed ? mode : 'flat',
    ready: () => setMode('on'),
    fail: () => {
      setFailed(true);
      setMode('flat');
    },
  };
}

/**
 * Where the arena is. The first time a race is on screen the arena walks through its `intro` (the break plays again,
 * the bolts of a held vault slam home); after that it follows the race as the chain moves it.
 */
function useShown(scene: Scene | null, on: boolean, key: string): ArenaState {
  const [played, setPlayed] = useState({ key, step: 0, done: false });
  let p = played;
  if (p.key !== key) {
    // A new race on the page plays its own arrival.
    p = { key, step: 0, done: false };
    setPlayed(p);
  }
  const rest = scene?.rest ?? 'idle';
  const intro = scene?.intro ?? [rest];
  const last = intro.length - 1;
  const done = p.done || (on && p.step >= last);
  useEffect(() => {
    if (!on || p.done) return;
    if (p.step >= last) {
      setPlayed((x) => ({ ...x, done: true }));
      return;
    }
    // The scene dissolves in on the first state (1.2 s) and holds a breath; the break comes 2.2 s in, the payout
    // 2.4 s after it.
    const id = window.setTimeout(() => setPlayed((x) => ({ ...x, step: x.step + 1 })), p.step === 0 ? 2200 : 2400);
    return () => window.clearTimeout(id);
  }, [on, p.done, p.step, last]);
  return done ? rest : (intro[Math.min(p.step, last)] ?? rest);
}

export function Stage({ race, serverNow, error }: { race: Race | null; serverNow: number; error?: boolean }) {
  const router = useRouter();
  const [now, setNow] = useState(serverNow);
  const running = race !== null && (race.phase === 'sealing' || race.phase === 'racing');
  const scene = useMemo(() => sceneOf(race, error === true), [race, error]);
  const three = useThree(scene !== null);
  const shown = useShown(scene, three.mode === 'on', race?.id ?? (error ? 'error' : 'empty'));
  const screen = useRef<HTMLElement>(null);
  const [insets, setInsets] = useState<{ top: number; bottom: number } | null>(null);
  // One player for the page: the flat stage plays the bed, the 3D arena adds the lock and the payout to it.
  const [audio] = useState(() => new ArenaAudio());
  const [sound, setSound] = useState(false);

  // The clock ticks on the device; the race itself is read again from the chain every few seconds while it runs.
  useEffect(() => {
    setNow(Date.now());
    const tick = running ? window.setInterval(() => setNow(Date.now()), 1000) : undefined;
    const poll = window.setInterval(() => router.refresh(), race?.live || running ? 5_000 : 60_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [router, running, race?.live]);

  // The arena composes between the header and the deck: their real heights, measured, as the page lays them out.
  useEffect(() => {
    const el = screen.current;
    if (!el || three.mode === 'flat') return;
    const head = el.querySelector('header');
    const deck = el.querySelector('footer');
    if (!head || !deck) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const top = Math.round(head.getBoundingClientRect().bottom - box.top);
      const bottom = Math.round(box.bottom - deck.getBoundingClientRect().top);
      setInsets((p) => (p && p.top === top && p.bottom === bottom ? p : { top, bottom }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(head);
    ro.observe(deck);
    return () => ro.disconnect();
  }, [three.mode]);

  useEffect(() => {
    const vis = () => audio.setHidden(document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      audio.dispose();
    };
  }, [audio]);

  const toggleSound = async () => {
    if (audio.on) {
      audio.disable();
      setSound(false);
    } else {
      setSound(true);
      await audio.enable();
    }
  };

  const facts: InfoRow[] = race
    ? [
        { label: 'Race', value: `${race.id} · ${day(race.openedAt)}` },
        ...(race.loot ? [{ label: 'From the safe', value: `${near(race.loot)} NEAR`, href: race.txs.drain ? txUrl(race.txs.drain) : undefined }] : []),
        ...(race.payout ? [{ label: 'Bounty paid', value: `${near(race.payout.amount)} NEAR`, href: race.payout.tx ? txUrl(race.payout.tx) : undefined }] : []),
        ...(race.winner ? [{ label: 'Winner', value: race.winner.account, href: accountUrl(race.winner.account) }] : []),
        { label: 'Network', value: `NEAR ${race.network}` },
      ]
    : [];
  const ended = race !== null && (race.phase === 'broken' || race.phase === 'held');
  const aside =
    ended && (shown === 'breach' || shown === 'paid' || shown === 'held') ? (
      <Info rows={facts} label={race?.phase === 'broken' ? 'Where the money came from' : 'The race'} side="top" />
    ) : null;

  let center: ReactNode = null;
  if (race) {
    if (race.phase === 'sealing' && race.startsAt) {
      center = (
        <>
          <span className={s.clockLabel}>Starts in</span>
          <Digits text={clock(race.startsAt - now)} />
        </>
      );
    } else if (race.live && race.startsAt) {
      center = <Digits text={clock(now - race.startsAt)} />;
    } else if (race.phase === 'racing') {
      center = (
        <>
          <span className={s.clockLabel}>Closes in</span>
          <Digits text={clock(race.deadline - now)} />
        </>
      );
    } else {
      center = (
        <>
          <span className={s.clockLabel}>Last race</span>
          <span className={s.clockDay}>{day(race.brokeAt ?? race.openedAt)}</span>
        </>
      );
    }
  }

  const heats = race ? race.masks.map((m) => standing(m, race.events)) : [];
  const heat = !race ? 0 : race.phase === 'broken' ? 1 : race.phase === 'sealing' ? 0.15 : Math.max(0, ...heats.map((h) => h.heat));
  const lead = race?.phase === 'racing' && heats.length ? heats.indexOf(heats.reduce((a, b) => (b.heat > a.heat ? b : a))) : -1;
  const tone = !race ? 'ice' : race.phase === 'broken' ? toneOf(race.winner) : lead >= 0 ? toneOf(race.masks[lead]) : 'ice';

  return (
    <main
      ref={screen}
      className={s.screen}
      data-phase={race?.phase ?? 'empty'}
      data-tone={tone}
      data-three={three.mode === 'on' ? '' : undefined}
      style={{ '--heat': heat.toFixed(3) } as CSSProperties}
    >
      <div className={s.flatBack} aria-hidden>
        <div className={s.world}>
          {/* The floor is the backdrop, never the largest paint: it loads beside the vault, not ahead of it. */}
          <Image src="/art/arena.webp" alt="" fill loading="eager" fetchPriority="low" sizes="100vw" quality={75} className={s.worldImg} />
        </div>
        <i className={s.glow} />
      </div>

      <Header center={center} live={race?.live ?? false} network={race?.network ?? NETWORK} here="race" />

      {race ? <Flat race={race} heats={heats} lead={lead} facts={facts} /> : <FlatEmpty error={error === true} />}

      {three.mode !== 'flat' && scene && insets ? (
        <div className={s.three}>
          <Arena3D
            state={shown}
            vault={scene.vault}
            masks={scene.masks}
            attempts={scene.attempts}
            winner={scene.winner}
            payout={scene.payout ?? undefined}
            line={scene.lines[shown]}
            aside={aside}
            insets={insets}
            audio={audio}
            onReady={three.ready}
            onFail={three.fail}
          />
        </div>
      ) : null}

      <footer className={s.deck}>
        {error && !race ? (
          // The chain did not answer: the one useful action is to ask it again.
          <a href="/" className={s.btn}>
            <span className={s.word}>Try again</span>
          </a>
        ) : (
          <Link href={race ? `/race/${race.id}` : '/league'} className={s.btn}>
            <span className={s.word}>{!race ? 'See the league' : running ? 'Watch live' : race.phase === 'broken' ? 'See the break' : 'See the race'}</span>
          </Link>
        )}
        <Link href="/break" className={s.quiet} prefetch={false}>
          Break my contract
        </Link>
        <button type="button" className={s.sound} onClick={toggleSound} aria-pressed={sound} aria-label="Sound">
          <SpeakerIcon on={sound} />
        </button>
      </footer>
      <span className={s.sr} aria-live="polite">
        {race?.live ? `Race ${raceNo(race.id)} is live` : ''}
      </span>
    </main>
  );
}

/** The flat arena: the first paint, and the whole arena wherever the 3D one does not run. */
function Flat({ race, heats, lead, facts }: { race: Race; heats: { heat: number; text: string }[]; lead: number; facts: InfoRow[] }) {
  const winner = race.winner;
  const broken = race.phase === 'broken';
  const taker = broken ? artOf(winner) : null;
  const ended = race.phase === 'broken' || race.phase === 'held';
  const target = targetName(race);
  const vault = near(race.phase === 'held' ? (race.refund?.amount ?? race.bounty) : race.prize);
  const shown = onStage(heats);
  const more = race.masks.length - shown.length;
  const sum = near(race.phase === 'held' ? (race.refund?.amount ?? race.bounty) : race.takes);
  return (
    <>
      <section className={s.stage} aria-label={`${targetName(race)} vault`}>
        <div className={s.vault}>
          <div className={s.halves} aria-hidden>
            {/* A broken vault has opened out of sight: the winner's face is what the first paint waits for. */}
            <Image src="/art/vault.webp" alt="" fill priority={!broken} fetchPriority={broken ? 'low' : 'high'} sizes="(max-width: 760px) 86vw, 560px" quality={85} className={`${s.half} ${s.hl}`} />
            <Image src="/art/vault.webp" alt="" fill priority={!broken} fetchPriority={broken ? 'low' : 'high'} sizes="(max-width: 760px) 86vw, 560px" quality={85} className={`${s.half} ${s.hr}`} />
          </div>
          <i className={s.seam} aria-hidden />
          {taker ? (
            <div className={s.taker}>
              <Image src={taker} alt={winner?.name ?? ''} fill priority fetchPriority="high" sizes="(max-width: 760px) 86vw, 560px" quality={85} />
            </div>
          ) : broken ? (
            // A winner the arena has no art for still takes the face: every mask shares the mark's silhouette (§5).
            <div className={s.taker} data-mark="">
              <Mark className={s.takerMark} />
            </div>
          ) : (
            <div className={s.inside}>
              {isAccount(target) ? (
                <span className={s.targetAccount} title={target}>
                  {shortAccount(target, 28)}
                </span>
              ) : (
                <span className={`${s.word} ${s.target}`}>
                  <Nums text={target} />
                </span>
              )}
              {/* A held vault is shut: its number is the result below, said once. */}
              {race.phase === 'held' ? null : (
                <span className={s.bounty} style={{ '--chars': vault.length } as CSSProperties}>
                  {vault}
                  <span className={`${s.word} ${s.unit}`}>NEAR</span>
                </span>
              )}
            </div>
          )}
        </div>
        <i className={s.stem} aria-hidden />
      </section>

      <section className={s.board}>
        {!ended ? (
          <ol className={s.masks} aria-label="Masks in the race">
            {shown.map((i, k) => {
              const m = race.masks[i]!;
              const art = artOf(m);
              const st = heats[i]!;
              return (
                <li
                  key={m.account}
                  className={s.mask}
                  data-tone={toneOf(m)}
                  data-lead={i === lead ? '' : undefined}
                  data-yield={more > 0 && k === shown.length - 1 ? '' : undefined}
                  style={{ '--h': st.heat.toFixed(2) } as CSSProperties}
                >
                  <Link href={m.slug ? `/mask/${m.slug}` : `/race/${race.id}`} className={s.maskLink} aria-label={`${m.name}: ${st.text}`}>
                    <span className={s.face}>{art ? <Image src={art} alt="" fill sizes="(max-width: 760px) 30vw, 160px" quality={80} /> : <Mark className={s.faceMark} />}</span>
                    <span className={`${s.word} ${s.maskName}`} data-long={m.name.length > 8 ? '' : undefined} style={{ '--chars': m.name.length } as CSSProperties}>
                      {m.name}
                    </span>
                    <span className={s.maskState}>{st.text}</span>
                  </Link>
                </li>
              );
            })}
            {more > 0 ? (
              <li className={s.mask} data-more="">
                <Link href={`/race/${race.id}`} className={s.maskLink} aria-label={`${race.masks.length} masks in the race`}>
                  <span className={s.face}>
                    <span className={s.moreNum}>
                      <span className={s.wide}>+{more}</span>
                      <span className={s.narrow}>+{more + 1}</span>
                    </span>
                  </span>
                  <span className={`${s.word} ${s.maskName}`}>{more === 1 ? 'Mask' : 'Masks'}</span>
                  <span className={s.maskState}>In the race</span>
                </Link>
              </li>
            ) : null}
          </ol>
        ) : (
          <div className={s.result} role="status">
            {race.phase === 'broken' ? (
              <>
                <div className={`${s.word} ${s.kicker}`}>
                  <Nums text={race.breakMs !== null ? `Broken in ${duration(race.breakMs)}` : 'Broken'} />
                </div>
                <div className={s.sum} style={{ '--chars': sum.length } as CSSProperties}>
                  <span className={s.money}>
                    {sum}
                    <span className={`${s.word} ${s.moneyUnit}`}>NEAR</span>
                  </span>
                  <span className={s.to}>
                    <Arrow className={s.arr} />
                    {winner?.slug ? (
                      <Link href={`/mask/${winner.slug}`} className={`${s.word} ${s.who}`} data-long={winner.name.length > 8 ? '' : undefined}>
                        {winner.name}
                      </Link>
                    ) : winner?.mask ? (
                      <span className={`${s.word} ${s.who}`} data-long={winner.name.length > 8 ? '' : undefined}>
                        {winner.name}
                      </span>
                    ) : (
                      <span className={s.whoAccount} title={winner?.account}>
                        {shortAccount(winner?.account ?? '', 24)}
                      </span>
                    )}
                  </span>
                  <Info rows={facts} label="Where the money came from" side="top" />
                </div>
              </>
            ) : (
              <>
                <div className={`${s.word} ${s.kicker} ${s.held}`}>Nobody got through</div>
                <div className={s.sum} style={{ '--chars': sum.length } as CSSProperties}>
                  <span>
                    {sum}
                    <span className={`${s.word} ${s.moneyUnit}`}>NEAR</span>
                  </span>
                  <span className={s.to}>
                    <Arrow className={s.arr} />
                    <span className={`${s.word} ${s.who}`}>Back to the team</span>
                  </span>
                  <Info rows={facts} label="The race" side="top" />
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function FlatEmpty({ error }: { error: boolean }) {
  return (
    <>
      <section className={s.stage}>
        <div className={s.vault}>
          <div className={s.halves} aria-hidden>
            <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 760px) 86vw, 560px" quality={85} className={`${s.half} ${s.hl}`} />
            <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 760px) 86vw, 560px" quality={85} className={`${s.half} ${s.hr}`} />
          </div>
          <i className={s.seam} aria-hidden />
        </div>
        <i className={s.stem} aria-hidden />
      </section>
      <section className={s.board}>
        <div className={s.result} role="status">
          <div className={`${s.word} ${s.kicker} ${s.held}`}>{error ? 'The chain is not answering' : 'No race yet'}</div>
        </div>
      </section>
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
