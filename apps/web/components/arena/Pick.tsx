'use client';

import type { Who } from '@maskwars/arena';
import { duration, near } from '@maskwars/arena/format';
import { type CSSProperties, useEffect, useState } from 'react';
import { type Choice, choiceName, type Entry, HELD, linkPayload, type PickView, type RoundBrief, verdictOf } from '@/lib/pick';
import { day, timeUtc, toneOf } from '@/lib/show';
import { raceName } from './names';
import s from './pick.module.css';

/**
 * What the block shows now.
 * - `open`: the round takes picks: the masks and the vault, one tap each.
 * - `called`: the last round ended and the person picked it: how they did, their run and the share; the next round's
 *   picks one tap behind it.
 * - `locked`: picks closed, at the round's first seal or with its sealing window, and the round runs; or the judge is
 *   on the claim.
 * - `result`: the last round ended; no round takes picks.
 * - `none`: nothing to show yet.
 */
export type PickMode = 'open' | 'called' | 'locked' | 'result' | 'none';

export function pickMode(p: PickView, now: number, mine: Entry | null, opened: boolean): PickMode {
  const open = p.window !== null && now < p.window.closes;
  if (open) {
    if (mine || opened) return 'open';
    // The person's call on the last round first, with its share; the next round's picks one tap behind it.
    if (p.last && p.lastMine) return 'called';
    return 'open';
  }
  if (p.window || p.running) return 'locked';
  if (p.last) return 'result';
  return 'none';
}

/** What the person's own calls stand at, as the server keeps them. */
export interface Standing {
  readonly name: string | null;
  readonly linked: boolean;
  readonly me: { readonly streak: number; readonly best: number; readonly right: number; readonly calls: number; readonly last: { race: string; choice: Choice; right: boolean } | null } | null;
  readonly share: string | null;
}

/** How the person's calls stand, asked once the page is up and only when there is a call of theirs to tell. */
export function useStanding(race: string | null, ask: boolean): [Standing | null, (f: (x: Standing | null) => Standing | null) => void] {
  const [standing, setStanding] = useState<Standing | null>(null);
  useEffect(() => {
    if (!ask) return;
    let alive = true;
    fetch(`/api/pick${race ? `?race=${encodeURIComponent(race)}` : ''}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<Standing>) : null))
      .then((j) => {
        if (alive && j) setStanding(j);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ask, race]);
  return [standing, setStanding];
}

/** The run of calls to show on a round: only the server's, only when it holds this round and the call was right. */
export function streakOn(standing: Standing | null, round: RoundBrief, entry: Entry | null): number | null {
  if (!entry || round.outcome === null || verdictOf(entry.choice, round.outcome) !== 'right') return null;
  // One right call is not a run yet: the run shows from the second in a row.
  return standing?.me?.last?.race === round.id && standing.me.streak > 1 ? standing.me.streak : null;
}

/**
 * Shares a call: on a phone the system's own sheet, elsewhere a post on X. The link carries the claim signed by the
 * server; its card is drawn from it and from the chain.
 */
export async function shareCall(round: RoundBrief, entry: Entry, token: string, streak: number | null): Promise<void> {
  const url = `${location.origin}/race/${encodeURIComponent(round.id)}?call=${encodeURIComponent(token)}`;
  const text = shareText(round, entry.choice, streak);
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.share) {
    try {
      await navigator.share({ text, url });
      return;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
    }
  }
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer');
}

/** The person's vault on this device, as /wallet keeps it: only a passkey vault can prove itself here. */
function vaultHere(): { id: string; key: string; account: string } | null {
  try {
    const w = JSON.parse(localStorage.getItem('maskwars:vault') ?? 'null') as { kind?: string; id?: string; key?: string; account?: string } | null;
    return w?.kind === 'passkey' && w.id && w.key && w.account ? { id: w.id, key: w.key, account: w.account } : null;
  } catch {
    return null;
  }
}

/** 18:45, with the day in front when it is not today's: 12 NOV 18:45. */
function When({ ms, now }: { ms: number; now: number }) {
  const time = timeUtc(ms).replace(' UTC', '');
  return (
    <b>
      {day(ms) === day(now) ? null : <span className={s.day}>{day(ms)} </span>}
      {time}
    </b>
  );
}

/** The words a person shares, every number from the chain. */
export function shareText(round: RoundBrief, choice: Choice, streak: number | null): string {
  const name = raceName(round.id);
  const by = round.winner?.name ?? 'A mask';
  const what =
    round.outcome === HELD
      ? `The vault held in ${name} of MASK WARS. Nobody got through.`
      : `${by} broke ${name} of MASK WARS${round.breakMs !== null ? ` in ${duration(round.breakMs)}` : ''} and took ${near(round.takes)} NEAR.`;
  const right = round.outcome !== null && verdictOf(choice, round.outcome) === 'right';
  if (right) return `Called it. ${what}${streak && streak > 1 ? ` ${streak} in a row.` : ''}`;
  const said = choice === HELD ? 'I said the vault holds.' : `I picked ${choiceName(choice, round.masks)}.`;
  return `${said} ${what} Running it back.`;
}

export function Pick({
  pick,
  now,
  rpId,
  onMode,
  onStage = true,
}: {
  pick: PickView;
  now: number;
  /** The passkey domain of the site's vaults. */
  rpId: string;
  /** The block takes the deck's main action in `open` and `called`: the page drops its own button then. */
  onMode?: ((mode: PickMode) => void) | undefined;
  /** The round that takes picks is the one on the stage: the ongoing round, or the next one between rounds. */
  onStage?: boolean;
}) {
  const [mine, setMine] = useState<Entry | null>(pick.mine);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<ReturnType<typeof vaultHere>>(null);
  const window_ = pick.window;
  const key = window_?.key ?? null;
  // A new round on the page brings its own pick.
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setMine(pick.mine);
    setOpened(false);
  }
  const mode = pickMode(pick, now, mine, opened);

  useEffect(() => {
    onMode?.(mode);
  }, [mode, onMode]);

  const [standing, setStanding] = useStanding(pick.last?.id ?? null, pick.lastMine !== null);
  useEffect(() => {
    setVault(vaultHere());
  }, []);

  const choose = async (choice: Choice) => {
    if (!window_ || busy) return;
    setBusy(choice);
    setError(null);
    try {
      const r = await fetch('/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: window_.key, choice }) });
      const j = (await r.json().catch(() => ({}))) as { pick?: Entry; error?: string; why?: string };
      if (r.ok && j.pick) setMine(j.pick);
      else if (j.error === 'closed' && j.why === 'seal') setError('First seal is in');
      else setError(j.error === 'closed' || j.error === 'moved' ? 'Picks just closed' : j.error === 'old' ? 'The chain is quiet. Try in a minute' : 'Not saved. Try again');
    } catch {
      setError('Not saved. Try again');
    } finally {
      setBusy(null);
    }
  };

  const link = async () => {
    const v = vault;
    if (!v) return;
    try {
      // The passkey code loads only for the few who have a vault here, when they ask.
      const { signWithPasskey } = await import('@maskwars/pay/passkey');
      const signed = await signWithPasskey(v, linkPayload(location.host, Date.now()), rpId);
      const r = await fetch('/api/pick/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed }) });
      if (r.ok) setStanding((x) => ({ ...(x ?? { me: null, share: null, name: null }), linked: true }));
    } catch {
      /* the person closed the passkey prompt: nothing changes */
    }
  };

  if (mode === 'none') return null;

  if (mode === 'open' && window_) {
    const picked = mine?.choice ?? null;
    const canLink = picked !== null && vault !== null && !(standing?.linked ?? false);
    // Until when: before the round opens, its start, the one time known ahead: a pick made by then always counts.
    // Once it is open, or due any moment, picks close at its first seal, and nobody knows that minute ahead. The
    // lines are short on purpose: beside the question they fit a 360px phone whatever the digits of the time.
    const start = window_.opens !== null && now < window_.opens ? window_.opens : null;
    return (
      <div className={s.block} data-mode="open">
        <div className={s.ticket} role="status" aria-live="polite" aria-label={picked ? `Your pick: ${choiceName(picked, window_.masks)}` : undefined}>
          <span className={s.left}>
            <span className={s.prompt}>{picked ? 'Your pick is in' : onStage ? 'Who breaks it?' : 'Next round'}</span>
          </span>
          {error ? (
            <span className={s.error}>{error}</span>
          ) : canLink ? (
            <button type="button" className={s.link} onClick={link}>
              Keep it on my vault
            </button>
          ) : (
            <span className={s.aside}>
              {start !== null ? (
                <>
                  {picked ? 'Locks after' : 'Free · by'} <When ms={start} now={now} /> UTC
                </>
              ) : picked ? (
                'Locks at the first seal'
              ) : (
                'Free · closes at first seal'
              )}
            </span>
          )}
        </div>
        <div className={s.choices} role="group" aria-label="Pick the mask that breaks the vault first, or the vault holding" data-picked={picked ? '' : undefined}>
          {[...window_.masks, null].map((m) => {
            const choice = m ? m.account : HELD;
            const on = picked === choice;
            return (
              <button
                key={choice}
                type="button"
                className={s.choice}
                data-tone={m ? toneOf(m) : 'vault'}
                data-on={on ? '' : undefined}
                data-busy={busy === choice ? '' : undefined}
                data-long={m && m.name.length > 6 ? '' : undefined}
                aria-pressed={on}
                disabled={busy !== null}
                onClick={() => choose(choice)}
                style={{ '--chars': m ? Math.max(4, m.name.length) : 6 } as CSSProperties}
              >
                {m ? (
                  <span className={s.word}>{m.name}</span>
                ) : (
                  <span className={`${s.word} ${s.holds}`}>
                    <span>Vault</span> <span>holds</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (mode === 'locked') {
    const r = pick.running ?? null;
    const entry = pick.running ? pick.runningMine : mine;
    const masks: readonly Who[] = r?.masks ?? window_?.masks ?? [];
    return (
      <div className={s.block} data-mode="row">
        <div className={s.ticket} role="status">
          <span className={s.left}>
            {entry ? (
              <>
                <span className={s.label}>Your pick</span>
                <span className={s.value}>{choiceName(entry.choice, masks)}</span>
              </>
            ) : (
              <span className={s.label}>{pick.old ? 'Picks paused' : 'Picks closed'}</span>
            )}
          </span>
          {/* With no pick on a round that still seals: its first seal closed them, and the masks have not played yet. */}
          <span className={s.aside}>
            {pick.old ? 'The chain is quiet' : r?.judging ? 'Judge checking' : entry ? 'Locked in' : r?.sealing ? 'Open again next round' : 'The masks are playing'}
          </span>
        </div>
      </div>
    );
  }

  // `called` and `result`: how the last round ended, and the person's call on it.
  const r = pick.last!;
  const entry = pick.lastMine;
  const outcome = r.outcome!;
  const right = entry ? verdictOf(entry.choice, outcome) === 'right' : false;
  const streak = streakOn(standing, r, entry);
  const token = standing?.share ?? null;
  const share = () => (entry && token ? shareCall(r, entry, token, streak) : undefined);
  return (
    <div className={s.block} data-mode={entry ? 'called' : 'row'}>
      <div className={s.ticket} role="status">
        <span className={s.left}>
          {entry ? (
            right ? (
              <>
                <span className={`${s.verdict} ${s.word}`} aria-label={`Called it: ${choiceName(entry.choice, r.masks)}`}>
                  <Check />
                  Called it
                </span>
              </>
            ) : (
              <>
                <span className={s.label}>Missed</span>
                <span className={s.value}>{choiceName(entry.choice, r.masks)}</span>
              </>
            )
          ) : (
            <>
              <span className={s.label}>{raceName(r.id)}</span>
              <span className={s.value}>{outcome === HELD ? 'Vault held' : (r.winner?.name ?? 'Broken')}</span>
            </>
          )}
        </span>
        {entry ? (
          streak !== null ? (
            <span className={s.streak}>
              <b>{streak}</b> in a row
            </span>
          ) : null
        ) : (
          <span className={s.aside}>Picks open next round</span>
        )}
      </div>
      {entry ? (
        <div className={s.actions} data-two={mode === 'called' ? '' : undefined}>
          {mode === 'called' ? (
            <button type="button" className={s.next} onClick={() => setOpened(true)}>
              <span className={s.word}>Pick the next breaker</span>
            </button>
          ) : null}
          <button type="button" className={mode === 'called' ? s.share : s.next} onClick={share} disabled={!token} aria-label="Share your call on X">
            <ShareIcon />
            <span className={s.word}>{mode === 'called' ? 'Share' : 'Share my call'}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The block holds the deck's one button: while picks are open, and when the person has a call to share. */
export const ownsDeck = (mode: PickMode, p: PickView): boolean => mode === 'open' || mode === 'called' || (mode === 'result' && p.lastMine !== null);

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8.5l3.2 3L13 4.5" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg className={s.icon} viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3H3v10h10v-3M9 2h5v5M14 2L7 9" />
    </svg>
  );
}
