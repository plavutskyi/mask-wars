'use client';

import type { NextRace, Race, Who } from '@maskwars/arena';
import { accountUrl, NETWORK, txUrl } from '@maskwars/arena/config';
import { duration, near } from '@maskwars/arena/format';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PickView } from '@/lib/pick';
import { day, type Faces, faceOf, isAccount, shortAccount, timeUtc, toneIn } from '@/lib/show';
import type { Across } from '@/lib/site';
import { twoLines } from '../arena3d/headline';
import { ArenaAudio } from '../arena3d/sound';
import type { ArenaState } from '../arena3d/types';
import { Arrow } from '../Arrow';
import { Mark } from '../Mark';
import { Header } from './Header';
import { Info, type InfoRow } from './Info';
import { raceName, raceTitle, stageName, standing } from './names';
import { Nums } from './Nums';
import { ownsDeck, Pick, type PickMode, pickMode } from './Pick';
import { nextCast, nextScene, offStage, opensLine, type Scene, sceneOf, stageCast } from './scene';
import { ArenaTarget, nextTargetOf, targetOf } from './Target';
import { Wings, wingPlaces } from './Wings';
import s from './stage.module.css';

// The 3D arena is its own chunk with three.js inside: it is fetched only once the page has loaded and gone quiet,
// and only on a device that wants motion. Until then, and wherever it cannot run, the flat stage below is the arena.
const Arena3D = dynamic(() => import('../arena3d/Arena3D').then((m) => m.Arena3D), { ssr: false, loading: () => null });

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

/** The home page's one line about the other network (`acrossOf`), with the time of the round that opens there next. */
export type AcrossLine = Across & { readonly at: number | null };

/** What MASK WARS is, in one line, for someone who has never heard of it. */
export const WHAT = 'AI masks break a vault of real NEAR. Live. The contract pays the winner.';

/** A round that ended keeps the stage this long; then the next one takes it, its clock running. */
export const RESULT_MS = 60 * 60_000;

/** When a round that is over stopped moving: the payout, the break, the bounty's way back, or its deadline. */
export function endOf(race: Race): number {
  return race.payout?.at ?? race.refund?.at ?? race.brokeAt ?? race.deadline;
}

export function Stage({
  race,
  next = null,
  serverNow,
  asOf = null,
  error,
  across = null,
  pick = null,
  rpId = 'maskwars.xyz',
  faces = null,
}: {
  race: Race | null;
  next?: NextRace | null;
  serverNow: number;
  /** When the reading was taken, for one too old to be shown as happening now (`asOf` of lib/arena); else null. */
  asOf?: number | null;
  error?: boolean;
  across?: AcrossLine | null;
  /** Pick the breaker: the round that takes picks, and the person's own calls (lib/pick). */
  pick?: PickView | null;
  rpId?: string;
  /** The faces of the round's masks that people forged, by account (lib/forged.ts): the arena has no art of its own for them. */
  faces?: Faces | null;
}) {
  const router = useRouter();
  const [now, setNow] = useState(serverNow);
  const running = race !== null && (race.phase === 'sealing' || race.phase === 'racing');
  // LIVE and every running clock belong to a reading of now. One the chain could not renew says when it was taken
  // instead, and the page asks again.
  const old = asOf !== null;
  const live = !old && (race?.live ?? false);
  // The next round, while nothing runs: only one the treasury can open, and only until its minute comes. Past it the
  // scheduler is on its way, or late: the page promises no time it cannot keep.
  const upNext = !old && !running && !live && next !== null && next.funded && next.at > now ? next : null;
  // Between rounds the stage is the next one: its vault and its sum, the clock to it in the header. A round that has
  // just ended keeps the stage for a while first.
  const ahead = upNext !== null && (race === null || now - endOf(race) > RESULT_MS) ? upNext : null;
  const scene = useMemo(() => (ahead ? nextScene(ahead) : sceneOf(race, error === true, faces)), [ahead, race, error, faces]);
  const three = useThree(scene !== null);
  const shown = useShown(scene, three.mode === 'on', ahead ? `next-${ahead.at}` : (race?.id ?? (error ? 'error' : 'empty')));
  // The round that takes picks is the one on the stage: the round itself, or the next one between rounds.
  const onStage = pick?.window?.race != null || ahead !== null;
  const [mode, setMode] = useState<PickMode>(() => (pick ? pickMode(pick, serverNow, pick.mine, false) : 'none'));
  const onMode = useCallback((m: PickMode) => setMode(m), []);
  // The block takes the deck's one button while the round takes picks, or while it offers the next one.
  const picking = pick !== null && ownsDeck(mode, pick);
  const screen = useRef<HTMLElement>(null);
  const [insets, setInsets] = useState<{ top: number; bottom: number } | null>(null);
  // One player for the page: the flat stage plays the bed, the 3D arena adds the lock and the payout to it.
  const [audio] = useState(() => new ArenaAudio());
  const [sound, setSound] = useState(false);

  // In its last minutes the page asks the chain as often as during a race, so the new round is on screen as it opens.
  const nearly = !running && next !== null && next.funded && next.at - now < 3 * 60_000 && now - next.at < 15 * 60_000;
  const ticking = !old && (running || live || upNext !== null || Boolean(pick?.window));
  // The other network has its line only between races: while this arena runs, the screen is the race's alone.
  const other = !running && !live ? across : null;
  const otherAt = other?.at && other.at > now ? new Date(other.at).toISOString().slice(11, 16) : null;

  // The clock ticks on the device; the race itself is read again from the chain every few seconds while it runs. A
  // chain that is not answering is asked again soon, and not every few seconds by every open page.
  useEffect(() => {
    setNow(Date.now());
    const tick = ticking ? window.setInterval(() => setNow(Date.now()), 1000) : undefined;
    const poll = window.setInterval(() => router.refresh(), old ? 20_000 : live || running || nearly ? 5_000 : 60_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [router, ticking, running, live, nearly, old]);

  // The arena composes between the header and the deck: their real heights, measured, as the page lays them out.
  useEffect(() => {
    const el = screen.current;
    if (!el || three.mode === 'flat') return;
    // The top is the line under the header when the page has one: the arena composes under it.
    const head = el.querySelector('[data-top]') ?? el.querySelector('header');
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

  // Everything technical about the race, one tap away: its id, the safe's account, where each sum came from.
  const facts: InfoRow[] = race
    ? [
        { label: 'Race', value: `${raceTitle(race.id)} · ${day(race.openedAt)}` },
        { label: 'Id', value: race.id },
        ...(race.kind === 'safe' ? [{ label: 'Vault', value: race.target, href: accountUrl(race.target) }] : [{ label: 'Target', value: race.target }]),
        ...(running && race.inSafe ? [{ label: 'In the vault', value: `${near(race.inSafe)} NEAR` }] : []),
        ...(running ? [{ label: 'Bounty', value: `${near(race.bounty)} NEAR`, href: race.txs.open ? txUrl(race.txs.open) : undefined }] : []),
        ...(race.loot ? [{ label: 'From the vault', value: `${near(race.loot)} NEAR`, href: race.txs.drain ? txUrl(race.txs.drain) : undefined }] : []),
        ...(race.payout ? [{ label: 'Bounty paid', value: `${near(race.payout.amount)} NEAR`, href: race.payout.tx ? txUrl(race.payout.tx) : undefined }] : []),
        ...(race.winner ? [{ label: 'Winner', value: race.winner.account, href: accountUrl(race.winner.account) }] : []),
        ...(race.phase === 'held' ? [{ label: 'Back to the team', value: `${near(race.refund?.amount ?? race.bounty)} NEAR`, href: race.refund?.tx ? txUrl(race.refund.tx) : undefined }] : []),
        { label: 'Network', value: `NEAR ${race.network}` },
      ]
    : [];
  const factsLabel = race?.phase === 'broken' ? 'Where the money came from' : 'The race on chain';
  // The safe on the stage, said plainly: the arena's own target. The next round's between rounds, else the race's.
  const target = ahead ? nextTargetOf(ahead) : race ? targetOf(race) : null;
  // In the door the sheet opens down, over the floor: above it is the header. The next round has no facts yet.
  const aside = race && !ahead ? <Info rows={facts} label={factsLabel} side="bottom" /> : null;

  // The clock, top centre: to the start, since the start, to the close; then to the next round. Over a round read too
  // long ago to count on, the time it was read at, and no clock that runs.
  let center: ReactNode = null;
  if (asOf !== null && running) {
    center = (
      <>
        <span className={s.clockLabel}>As of</span>
        <span className={s.clockDay}>{timeUtc(asOf)}</span>
      </>
    );
  } else if (race && race.phase === 'sealing' && race.startsAt) {
    center = (
      <>
        <span className={s.clockLabel}>Starts in</span>
        <Digits text={clock(race.startsAt - now)} />
      </>
    );
  } else if (race && race.phase === 'racing' && live && race.startsAt) {
    center = <Digits text={clock(now - race.startsAt)} />;
  } else if (race && race.phase === 'racing') {
    center = (
      <>
        <span className={s.clockLabel}>Closes in</span>
        <Digits text={clock(race.deadline - now)} />
      </>
    );
  } else if (race && live) {
    // Broken, the judge on the claim: the door already says in how long, and LIVE says it is not over.
    center = null;
  } else if (upNext) {
    center = (
      <>
        <span className={s.clockLabel}>Next round</span>
        <Digits text={clock(upNext.at - now)} />
      </>
    );
  } else if (race) {
    center = (
      <>
        <span className={s.clockLabel}>{raceName(race.id).startsWith('Round') ? 'Last round' : 'Last race'}</span>
        <span className={s.clockDay}>{day(race.brokeAt ?? race.openedAt)}</span>
      </>
    );
  }

  const cast = useMemo(() => (ahead ? nextCast(ahead) : stageCast(race, faces)), [ahead, race, faces]);
  // The stage holds three. The round's other masks stand in its wings, under the three: nobody in the round is left out.
  const wings = useMemo(() => offStage(ahead ? ahead.masks : (race?.masks ?? []), cast), [ahead, race, cast]);
  const heats = race && !ahead ? cast.map((m) => standing(m, race.events)) : cast.map(() => ({ heat: 0.1, text: '' }));
  // The light behind the vault is the whole round's: a mask in the wings that closes in on the vault burns in it too.
  const closest = race && !ahead ? Math.max(0, ...heats.map((h) => h.heat), ...wings.map((m) => standing(m, race.events).heat)) : 0;
  const heat = ahead ? 0.15 : !race ? 0 : race.phase === 'broken' ? 1 : race.phase === 'sealing' ? 0.15 : race.phase === 'held' ? 0 : closest;
  const lead = !ahead && race?.phase === 'racing' && heats.length ? heats.indexOf(heats.reduce((a, b) => (b.heat > a.heat ? b : a))) : -1;
  const tone = ahead || !race ? 'ice' : race.phase === 'broken' ? toneIn(race.winner, faces) : lead >= 0 ? toneIn(cast[lead], faces) : 'ice';
  const action = !race
    ? 'See the league'
    : ahead
      ? 'Last round'
      : running
        ? live
          ? 'Watch live'
          : 'See the race'
        : race.phase === 'broken'
          ? 'See the break'
          : 'See the race';
  const phase = ahead ? 'next' : (race?.phase ?? 'empty');

  return (
    <main
      ref={screen}
      className={s.screen}
      data-phase={phase}
      data-tone={tone}
      data-three={three.mode === 'on' ? '' : undefined}
      data-across={other ? '' : undefined}
      data-target={target ? '' : undefined}
      data-pick={mode === 'none' || !pick ? undefined : mode === 'open' ? 'open' : picking ? 'called' : 'row'}
      data-wings={wings.length ? wingPlaces(wings.length) : undefined}
      style={{ '--heat': heat.toFixed(3) } as CSSProperties}
    >
      <div className={s.flatBack} aria-hidden>
        <div className={s.world}>
          {/* The floor is the backdrop, never the largest paint: it loads beside the vault, not ahead of it. */}
          <Image src="/art/arena.webp" alt="" fill loading="eager" fetchPriority="low" sizes="100vw" quality={75} className={s.worldImg} />
        </div>
        <i className={s.glow} />
      </div>

      <Header center={center} live={live} network={race?.network ?? NETWORK} here="race" />
      <div className={s.top} data-top="">
        <p className={s.what}>{WHAT}</p>
        {target ? <ArenaTarget target={target} className={s.target} /> : null}
      </div>

      {race?.phase === 'broken' && !ahead ? (
        <FlatBroken race={race} facts={facts} faces={faces} />
      ) : (
        <>
          <FlatStage
            race={ahead ? null : race}
            error={error === true}
            cast={cast}
            faces={faces}
            heats={heats}
            lead={lead}
            aside={aside}
            door={ahead ? { sum: near(ahead.prize), line: opensLine(ahead.at) } : null}
          />
          <div className={s.fill} />
        </>
      )}

      {three.mode !== 'flat' && scene && insets ? (
        <div className={s.three}>
          <Arena3D
            state={shown}
            vault={scene.vault}
            masks={scene.masks}
            attempts={scene.attempts}
            notes={scene.notes ?? undefined}
            winner={scene.winner}
            payout={scene.payout ?? undefined}
            line={scene.lines[shown]}
            lineIsAccount={scene.account && (shown === 'idle' || shown === 'live')}
            headline={scene.headlines[shown]}
            aside={aside}
            insets={insets}
            audio={audio}
            onReady={three.ready}
            onFail={three.fail}
          />
        </div>
      ) : null}

      <footer className={s.deck}>
        {wings.length ? <Wings masks={wings} events={running && race ? race.events : null} faces={faces} href={race && !ahead ? `/race/${race.id}` : '/league'} /> : null}
        {pick ? <Pick pick={pick} now={now} rpId={rpId} onMode={onMode} onStage={onStage} /> : null}
        {error && !race ? (
          // The chain did not answer: the one useful action is to ask it again.
          <a href="/" className={s.btn}>
            <span className={s.word}>Try again</span>
          </a>
        ) : picking ? null : (
          <Link href={race ? `/race/${race.id}` : '/league'} className={s.btn}>
            <span className={s.word}>{action}</span>
          </Link>
        )}
        <div className={s.quietRow}>
          {picking && race ? (
            <Link href={`/race/${race.id}`} className={s.quiet}>
              {action}
            </Link>
          ) : null}
          <Link href="/break" className={s.quiet} prefetch={false}>
            Break my contract
          </Link>
        </div>
        <button type="button" className={s.sound} onClick={toggleSound} aria-pressed={sound} aria-label="Sound">
          <SpeakerIcon on={sound} />
        </button>
        {other ? (
          <a
            href={other.href}
            className={s.across}
            aria-label={
              other.kind === 'season'
                ? `The daily season runs on ${other.network}${otherAt ? `: the next round opens at ${otherAt} UTC` : ''}. Open the ${other.network} site`
                : `Races for real NEAR run on ${other.network}. Open the ${other.network} site`
            }
          >
            <span className={s.acrossWhat}>
              <span className={s.word}>{other.kind === 'season' ? 'Daily season' : 'Races for real NEAR'}</span>
              <span className={`${s.word} ${s.acrossTag}`}>{other.network}</span>
            </span>
            <span className={s.acrossGo}>
              {otherAt ? (
                <span className={s.acrossTime}>
                  <span className={`${s.word} ${s.acrossNext}`}>Next round</span>
                  <b>{otherAt}</b>
                  <span className={s.word}>UTC</span>
                </span>
              ) : null}
              <Arrow className={s.acrossArr} />
            </span>
          </a>
        ) : null}
      </footer>
      <span className={s.sr} aria-live="polite">
        {race && live ? `${raceName(race.id)} is live` : ''}
      </span>
    </main>
  );
}

/**
 * The flat arena: the first paint, and the whole arena wherever the 3D one does not run. It is composed by the same
 * numbers as the 3D arena (arena3d/layout.ts), in the brand's own frames: the vault, its sum and its line, the same
 * three masks in the same places under the same names. The 3D arena dissolves in over the frame it was composed from.
 */
function FlatStage({
  race,
  error,
  cast,
  faces,
  heats,
  lead,
  aside,
  door = null,
}: {
  race: Race | null;
  error: boolean;
  cast: readonly Who[];
  faces: Faces | null;
  heats: readonly { heat: number; text: string }[];
  lead: number;
  aside: ReactNode;
  /** The next round's vault, between rounds: its sum and when it opens. */
  door?: { sum: string; line: string } | null;
}) {
  const running = race !== null && (race.phase === 'sealing' || race.phase === 'racing');
  const sum = door ? door.sum : running && race ? near(race.prize) : null;
  const name = door ? { text: door.line, account: false } : race ? stageName(race) : null;
  // A vault with no sum to show says what happened in its door.
  const headline = running ? null : twoLines(!race ? (error ? 'The chain is not answering' : 'No race yet') : 'Vault held');
  return (
    <section className={s.flat} aria-label={door ? `The next round: ${door.line}` : race ? `${name!.text}: the vault` : 'The vault'} data-masks={cast.length}>
      <div className={s.fVault} aria-hidden>
        <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 760px) 96vw, 640px" quality={85} className={`${s.half} ${s.hl}`} />
        <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 760px) 96vw, 640px" quality={85} className={`${s.half} ${s.hr}`} />
        <i className={s.seam} />
      </div>

      <div className={s.fDoor} role={running ? undefined : 'status'}>
        {sum !== null ? (
          <>
            <span className={s.fSum} style={{ '--chars': sum.length + 2.4 } as CSSProperties}>
              {sum}
              <span className={`${s.word} ${s.fUnit}`}>NEAR</span>
            </span>
            <span className={s.fUnder} data-short={name!.text.length <= 10 || door ? '' : undefined}>
              {name!.account ? (
                <span className={s.fAccount} title={race!.target}>
                  {name!.text}
                </span>
              ) : (
                <Line text={name!.text} />
              )}
              {aside ? <span className={s.fAside}>{aside}</span> : null}
            </span>
          </>
        ) : (
          <>
            <span className={`${s.word} ${s.fHeadline}`} style={{ '--chars': Math.max(8, ...headline!.map((l) => l.length)) } as CSSProperties}>
              {headline!.map((l, i) => (
                <span key={i}>{l}</span>
              ))}
            </span>
            {race ? (
              <span className={s.fUnder} data-sub="">
                <Line text="Nobody got through" />
                {aside ? <span className={s.fAside}>{aside}</span> : null}
              </span>
            ) : null}
          </>
        )}
      </div>

      <ol className={s.fMasks} aria-label={race ? 'Masks in the race' : 'Masks of the arena'}>
        {cast.map((m, i) => {
          const art = faceOf(m, faces);
          const st = heats[i]!;
          const note = running ? st.text : '';
          return (
            <li
              key={m.account}
              className={s.fMask}
              data-tone={toneIn(m, faces)}
              data-lead={i === lead ? '' : undefined}
              data-long={m.name.length > 8 ? '' : undefined}
              style={{ '--h': (running ? st.heat : 0.1).toFixed(2), '--chars': Math.max(4, m.name.length) } as CSSProperties}
            >
              <Link href={m.slug ? `/mask/${m.slug}` : race ? `/race/${race.id}` : '/league'} className={s.fLink} aria-label={note ? `${m.name}: ${note}` : m.name}>
                <span className={s.fFace}>{art ? <Image src={art} alt="" fill loading="eager" sizes="(max-width: 760px) 46vw, 300px" quality={85} /> : <Mark className={s.fMark} />}</span>
                <span className={`${s.word} ${s.fMaskName}`}>{m.name}</span>
                {note ? (
                  <span className={s.fNote}>
                    {note.split(/(\d[\d,.:]*)/).map((part, k) => (/\d/.test(part) ? <b key={k}>{part}</b> : part))}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A line of words and numbers, set as the 3D arena sets it: words in Hubot, numbers in Mona (BRANDBOOK §4). */
function Line({ text }: { text: string }) {
  return (
    <span className={s.fLine}>
      {text.split(' ').map((t, i) => (
        <span key={i} className={/\d/.test(t) ? s.fNum : s.word}>
          {t}
        </span>
      ))}
    </span>
  );
}

/** The flat arena of a broken vault: the mask that broke it takes the whole face, the money and its name under it. */
function FlatBroken({ race, facts, faces }: { race: Race; facts: InfoRow[]; faces: Faces | null }) {
  const winner = race.winner;
  // The winner's own face: the arena's art of it, or the look a person forged it with. Never another mask's.
  const taker = faceOf(winner, faces);
  const sum = near(race.takes);
  return (
    <>
      <section className={s.stage} aria-label={`${raceName(race.id)}: the vault, broken`}>
        <div className={s.vault}>
          {taker ? (
            <div className={s.taker}>
              <Image src={taker} alt={winner?.name ?? ''} fill priority fetchPriority="high" sizes="(max-width: 760px) 86vw, 560px" quality={85} />
            </div>
          ) : (
            // A winner the arena has no art for still takes the face: every mask shares the mark's silhouette (§5).
            <div className={s.taker} data-mark="">
              <Mark className={s.takerMark} />
            </div>
          )}
        </div>
      </section>

      <section className={s.board}>
        <div className={s.result} role="status">
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
              ) : winner?.mask && !isAccount(winner.name) ? (
                <span className={`${s.word} ${s.who}`} data-long={winner.name.length > 8 ? '' : undefined}>
                  {winner.name}
                </span>
              ) : (
                <span className={s.whoAccount} title={winner?.account}>
                  {shortAccount(winner?.account ?? '', 24)}
                </span>
              )}
              {/* Beside the name it belongs to: on a narrow screen it never drops to a line of its own. */}
              <Info rows={facts} label="Where the money came from" side="top" />
            </span>
          </div>
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
