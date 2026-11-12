'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Arrow } from '@/components/Arrow';
import p from '@/components/arena/page.module.css';
import {
  DRAIN,
  type DrainJob,
  type DrainSheet,
  type HouseRound,
  type PostWindow,
  anyAccount,
  briefProblem,
  defaultBrief,
  drainCall,
  drainBack,
  drainCommand,
  drainDeposit,
  freshSalt,
  jobIdOf,
  nearText,
  postWindow,
  rewardProblem,
  rewardYocto,
  specOf,
} from './drain';
import { mine as noteMine } from './mine';
import { clockTime, left } from './show';
import { signIn } from './wallet';
import s from './jobs.module.css';

/** Where the flow stands: the form; the wallet list; the wallet's own approval; the job on its way; the job on chain. */
export type Phase = 'form' | 'connect' | 'sign' | 'landing' | 'done';

/** A job of the person's, as /api/jobs/<id> shows it once the chain has it. */
interface Landed {
  readonly id: string;
  readonly client: string;
  readonly phase: string;
  readonly openedAt: number;
  readonly workUntil: number;
  readonly reward: string;
  readonly spec: string;
  readonly txs?: { readonly open: string | null };
}

export interface Posted {
  readonly id: string;
  readonly reward: string;
  readonly tx: string | null;
  /** The job as the board reads it; `null` while the board has not read it yet. */
  readonly job: Landed | null;
  /** The wallet approved after posting had closed: the job opened later than the masks can be sure to take it. */
  readonly late: boolean;
}

/** A job signed on this device before a wallet took the page away: the sheet picks it up when the person is back. */
const PENDING = 'maskwars.jobs.pending';
const PENDING_MS = 15 * 60_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRound(): Promise<HouseRound> {
  const res = await fetch('/api/jobs-round', { cache: 'no-store' });
  if (!res.ok) throw new Error(`the round: ${res.status}`);
  return (await res.json()) as HouseRound;
}

/** The job by its id, once the board has it; `null` while it does not. The query keeps a cached "not found" away. */
async function fetchJob(id: string): Promise<Landed | null> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}?missing=null&at=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as Landed | null;
}

/** The terms a request asked for: a job of its id with other terms is not the one it opened. */
type Want = { spec: string; reward: string };

function remember(id: string, account: string, want: Want) {
  try {
    sessionStorage.setItem(PENDING, JSON.stringify({ id, account, want, at: Date.now() }));
  } catch {
    /* private mode: the page cannot resume after a wallet's redirect */
  }
}

function forget() {
  try {
    sessionStorage.removeItem(PENDING);
  } catch {
    /* nothing kept */
  }
}

function pending(): { id: string; account: string; want: Want | null } | null {
  try {
    const kept = JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as { id?: unknown; account?: unknown; want?: { spec?: unknown; reward?: unknown }; at?: unknown } | null;
    if (!kept || typeof kept.id !== 'string' || typeof kept.account !== 'string' || typeof kept.at !== 'number') return null;
    if (Date.now() - kept.at > PENDING_MS) return forget(), null;
    const w = kept.want;
    const want = w && typeof w.spec === 'string' && typeof w.reward === 'string' ? { spec: w.spec, reward: w.reward } : null;
    return { id: kept.id, account: kept.account, want };
  } catch {
    return null;
  }
}

/**
 * What the flow holds. One for the whole page, whatever number of "Post a job" buttons it has, and kept while the
 * person moves around the site: one person, one wallet, one job at a time. A second button opens the same sheet where
 * the flow is, never a second job beside the first.
 */
interface Shared {
  readonly brief: string | null;
  readonly reward: string;
  /** The person's own letters of the new job's id; made in the browser on the first look. */
  readonly salt: string;
  readonly phase: Phase;
  readonly problem: string | null;
  readonly posted: Posted | null;
  readonly account: string | null;
}

const FIRST: Shared = { brief: null, reward: '1', salt: '', phase: 'form', problem: null, posted: null, account: null };
let shared: Shared = FIRST;
/** A post or a resume is under way: nothing starts another. */
let running = false;
/** The flow under way. A person who starts over (a wallet that never answers) leaves it: what it says later is not shown. */
let ticket = 0;
const listeners = new Set<() => void>();

function patch(change: Partial<Shared>) {
  shared = { ...shared, ...change };
  for (const l of listeners) l();
}

/** `patch` for the flow of `mine` only: once the person started over, an old flow changes nothing on screen. */
const patchFor = (mine: number) => (change: Partial<Shared>) => {
  if (mine === ticket) patch(change);
};

/**
 * Back to the form, from wherever the flow is. After a job went on chain the next post is a new job with a new id;
 * after the person started over it keeps the same id (`keepId`): if the wallet still approves the old request, a new
 * post of the same line and reward finds that job and shows it, and the contract takes an id once.
 */
function clear(problem: string | null = null, keepId = false) {
  ticket += 1;
  running = false;
  patch({ phase: 'form', posted: null, problem, ...(keepId ? {} : { salt: freshSalt() }) });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Back to the first moment of the page, for a test that walks the flow from its start. */
export function forgetPostFlow() {
  shared = FIRST;
  running = false;
  ticket += 1;
}

/**
 * The flow of posting a drain with the person's wallet. Its state is the page's (`Shared`), not the sheet's: closing
 * the sheet while a wallet signs loses nothing, and the sheet opens again where the flow is. `resume`: this button
 * opens the sheet when the person comes back to a flow that is still under way, or from a wallet that took the page.
 */
export function useDrainPost(drain: DrainSheet | null, open: boolean, onResume: () => void, resume: boolean) {
  const router = useRouter();
  const flow = useSyncExternalStore(subscribe, () => shared, () => FIRST);
  const [house, setHouse] = useState<HouseRound | null>(drain?.house ?? null);
  /** The server's clock less the device's, at the last reading: every count runs on the server's time. */
  const [skew, setSkew] = useState(() => (drain?.house ? drain.house.now - Date.now() : 0));
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!shared.salt) patch({ salt: freshSalt() });
  }, []);

  const read = useCallback(async (): Promise<{ house: HouseRound; skew: number } | null> => {
    try {
      const h = await fetchRound();
      const k = h.now - Date.now();
      setHouse(h);
      setSkew(k);
      setOffline(false);
      return { house: h, skew: k };
    } catch {
      setOffline(true);
      return null;
    }
  }, []);

  // While the sheet is open: a clock for the countdowns, and the round read again every half minute and whenever the
  // window turns, so a sheet left open at 18:03 opens to posting by itself.
  const win: PostWindow | null = drain && house ? postWindow(house, now + skew, drain.schedule) : null;
  const turn = win ? `${win.state}:${win.state === 'open' ? win.round : win.state === 'off' ? '' : win.opensAt}` : 'none';
  const due = win && win.state !== 'open' && win.state !== 'off' && now + skew >= win.opensAt;
  useEffect(() => {
    if (!open || !drain) return;
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [open, drain]);
  useEffect(() => {
    if (!open || !drain) return;
    void read();
    const again = window.setInterval(() => void read(), 30_000);
    return () => window.clearInterval(again);
  }, [open, drain, read, turn, due]);

  /**
   * Waits for the job on the board. `want`: the line's sha256 and the reward just signed; a job of this id that is not
   * that (an earlier request the person left with Start over, approved first) is never shown as the one just posted.
   * `null` only when the terms were not kept (a private window that came back from a wallet's redirect).
   */
  const land = useCallback(async (id: string, signer: string, tx: string | null, sent: boolean, reward: string, closesAt: number, mine: number, want: Want | null) => {
    const put = patchFor(mine);
    put({ phase: 'landing' });
    // The board reads the chain every few seconds. A wallet that failed may still have sent: a few reads say.
    let found: Landed | null = null;
    let earlier: Landed | null = null;
    let taken = false;
    const tries = sent ? 20 : 5;
    // A job of this id with other terms holds the id for good: this request cannot open, and there is nothing to wait for.
    for (let i = 0; i < tries && !found && !earlier && !taken; i++) {
      await wait(i === 0 ? 1200 : 2000);
      const j = await fetchJob(id);
      if (!j) continue;
      if (j.client !== signer) taken = true;
      else if (!want || (j.spec === want.spec && j.reward === want.reward)) found = j;
      else earlier = j;
    }
    if (mine !== ticket) return;
    forget();
    // The id went to another request first: this one could not open. A new id for the next press.
    if (!found && earlier) return put({ phase: 'form', salt: freshSalt(), problem: `Your earlier request opened ${id} first: it is on the board. This one did not open.` });
    if (!found && taken) return put({ phase: 'form', salt: freshSalt(), problem: `${id} went to another account first. This one did not open: press again for a new id.` });
    if (found || tx) {
      // The chain's own record of the opening first: a wallet hands back a hash even for a transaction that failed.
      put({ posted: { id, reward: found?.reward ?? reward, tx: found?.txs?.open ?? tx, job: found, late: Boolean(found && found.openedAt > closesAt) }, phase: 'done' });
      return;
    }
    // Only what was seen: no job on the board. Whether the wallet sent anything, the wallet says.
    put({ phase: 'form', problem: 'No job reached the board. Your NEAR wallet shows whether anything was sent.' });
  }, []);

  // Back on the board: a flow still under way shows where it is; a wallet that took the page away, the job it signed.
  useEffect(() => {
    if (!resume || !drain) return;
    if (running) {
      if (shared.phase !== 'form') onResume();
      return;
    }
    // A job shown as posted before the person left the board is on the board now: the form starts afresh.
    if (shared.phase === 'done') clear();
    const kept = pending();
    if (!kept) return;
    running = true;
    const mine = ++ticket;
    onResume();
    patch({ account: kept.account });
    void land(kept.id, kept.account, null, true, kept.want?.reward ?? '0', Number.POSITIVE_INFINITY, mine, kept.want).finally(() => {
      if (mine === ticket) running = false;
    });
    // Once, when the board first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = useCallback(async () => {
    if (!drain || running) return;
    const { brief, reward, salt } = shared;
    const line = (brief ?? defaultBrief(win?.state === 'open' ? win.round : null)).trim();
    const bad = briefProblem(line) ?? rewardProblem(reward, drain.minReward);
    if (bad) return patch({ problem: bad });
    running = true;
    const mine = ++ticket;
    const put = patchFor(mine);
    put({ problem: null });
    let asked = false;
    try {
      const spec = await specOf(line);
      // The round once more, right before anything is signed: a window that closed since the sheet opened signs nothing.
      const fresh = await read();
      if (!fresh) return put({ problem: 'Cannot reach NEAR right now. Nothing was sent.' });
      const before = postWindow(fresh.house, Date.now() + fresh.skew, drain.schedule);
      if (before.state === 'booked') return put({ problem: 'The arena’s masks are booked on today’s round. Nothing was sent.' });
      if (before.state !== 'open') return put({ problem: 'Today’s window just closed. Nothing was sent.' });
      // A job of this id may be on the board already: the request the person left with Start over, approved after all.
      // Read before the wallet opens, so nothing stands between the person's press and the wallet's own window.
      const amount = rewardYocto(reward)!;
      let used = salt || freshSalt();
      const there = await fetchJob(jobIdOf(before.round, used));
      if (mine !== ticket) return;
      put({ phase: 'connect' });
      let signer;
      try {
        signer = await signIn();
      } catch {
        return put({ phase: 'form', problem: 'No NEAR wallet connected. Nothing was sent.' });
      }
      // The person started over while the wallet connected: this flow asks it for nothing.
      if (mine !== ticket) return;
      put({ account: signer.accountId });
      // The arena's masks take one live job at a time from each account (limits.jobs.per_client): a second would wait.
      if (fresh.house.arena?.full.includes(signer.accountId)) {
        return put({ phase: 'form', problem: `${signer.accountId} has a job with the arena’s masks already: they take one at a time from each account. Nothing was sent.` });
      }
      // Picking a wallet takes a while: the window and the work time are counted again from now.
      const w = postWindow(fresh.house, Date.now() + fresh.skew, drain.schedule);
      if (w.state !== 'open') return put({ phase: 'form', problem: 'Today’s window just closed. Nothing was sent.' });
      if (there && w.round === before.round) {
        // The very job the person asks for, theirs and still open: shown, and the wallet asked for nothing that would
        // only fail. Any other job under that id (taken back, another line or reward, another account's): a new id.
        const same = there.client === signer.accountId && there.spec === spec && there.reward === amount.toString() && (there.phase === 'enlisting' || there.phase === 'checking');
        if (same) {
          noteMine(there.id);
          return put({ phase: 'done', posted: { id: there.id, reward: there.reward, tx: there.txs?.open ?? null, job: there, late: there.openedAt > w.closesAt } });
        }
        used = freshSalt();
        put({ salt: used });
      }
      const job: DrainJob = { id: jobIdOf(w.round, used), brief: line, spec, reward: amount, round: { bounty: w.bounty, id: w.round }, workMinutes: w.workMinutes };
      remember(job.id, signer.accountId, { spec, reward: amount.toString() });
      // Noted before the wallet answers: a job approved late, or after the person started over, can still be taken back.
      noteMine(job.id);
      put({ phase: 'sign' });
      asked = true;
      let tx: string | null = null;
      let sent = true;
      try {
        tx = await signer.call(drain.contract, drainCall(job, drain.costs));
      } catch {
        sent = false;
      }
      await land(job.id, signer.accountId, tx, sent, amount.toString(), w.closesAt, mine, { spec, reward: amount.toString() });
    } catch {
      // Nothing above throws by design. A page that cannot hash the line (no secure context) lands here before any
      // wallet is asked; after a wallet was asked, only what was seen is said.
      put({ phase: 'form', problem: asked ? 'No job reached the board. Your NEAR wallet shows whether anything was sent.' : 'This page could not prepare the job. Nothing was sent.' });
    } finally {
      if (mine === ticket) running = false;
    }
  }, [drain, win, read, land]);

  /**
   * The sheet closed after a job went on chain: the board behind it reads the chain again and shows the job, and the
   * form is ready for the next one. Not while the sheet shows the job: a board that had no job until now is laid out
   * anew, and the sheet would go with its old layout.
   */
  const reset = useCallback(() => {
    if (shared.phase !== 'done') return;
    clear();
    router.refresh();
  }, [router]);

  /**
   * The wallet never answered: the person starts over. Whatever that wallet still does is not shown here; a job it
   * opens anyway is on the board, and its page offers it back (noted at signing).
   */
  const abandon = useCallback(() => {
    forget();
    clear('Started over. If your NEAR wallet still shows the last request, reject it there.', true);
  }, []);

  const setBrief = useCallback((brief: string) => patch({ brief }), []);
  const setReward = useCallback((reward: string) => patch({ reward }), []);
  const setProblem = useCallback((problem: string | null) => patch({ problem }), []);

  return { house, offline, now: now + skew, win, ...flow, setBrief, setReward, setProblem, post, reset, abandon };
}

export type DrainFlow = ReturnType<typeof useDrainPost>;

function Check() {
  return (
    <svg className={s.postDoneMark} viewBox="0 0 48 48" width="48" height="48" fill="none" aria-hidden>
      <circle cx="24" cy="24" r="22.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M14 24.5l6.5 6.5L34 17.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The arena's masks by name, as a person reads them: `NOVA, ONYX and ORACLE`. */
export function masksText(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? 'Masks') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The line above the form: the round and how long posting stays open, or when it opens next. */
function Status({ flow }: { flow: DrainFlow }) {
  const { win, now, offline, house } = flow;
  if (!house || !win) {
    return (
      <p className={`${p.word} ${s.postStatus}`} data-tone="wait" data-post-status>
        {offline ? 'Cannot reach NEAR right now' : 'Reading today’s round'}
      </p>
    );
  }
  if (win.state === 'open') {
    return (
      <p className={`${p.word} ${s.postStatus}`} data-tone="open" data-post-status>
        <span className={s.postDot} aria-hidden />
        <span>
          Open for{' '}
          <span className={s.postClock} suppressHydrationWarning>
            {left(win.closesAt - now)}
          </span>{' '}
          · {win.round}
        </span>
      </p>
    );
  }
  if (win.state === 'opening') {
    return (
      <p className={`${p.word} ${s.postStatus}`} data-tone="wait" data-post-status>
        <span className={s.postDot} aria-hidden />
        <span>Today’s round is opening</span>
      </p>
    );
  }
  if (win.state === 'off') return null;
  if (win.state === 'booked') {
    return (
      <p className={`${p.word} ${s.postStatus}`} data-tone="wait" data-post-status>
        <span>
          Booked · next in{' '}
          <span className={s.postClock} suppressHydrationWarning>
            {left(win.opensAt - now)}
          </span>
        </span>
      </p>
    );
  }
  return (
    <p className={`${p.word} ${s.postStatus}`} data-tone="wait" data-post-status>
      <span>
        Next window in{' '}
        <span className={s.postClock} suppressHydrationWarning>
          {left(win.opensAt - now)}
        </span>
      </span>
    </p>
  );
}

/** The command for an agent, filled in as the person types: the same call the wallet signs. */
function ForAgents({ drain, flow }: { drain: DrainSheet; flow: DrainFlow }) {
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLElement>(null);
  const [spec, setSpec] = useState('SHA256_OF_THE_LINE');
  const win = flow.win;
  const round = win?.state === 'open' ? win.round : null;
  const line = (flow.brief ?? defaultBrief(round)).trim();
  useEffect(() => {
    let live = true;
    specOf(line).then((h) => live && setSpec(h));
    return () => {
      live = false;
    };
  }, [line]);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);
  const reward = rewardYocto(flow.reward) ?? 10n ** 24n;
  const job: DrainJob = {
    id: round ? jobIdOf(round, flow.salt) : 'YOUR-JOB-ID',
    brief: line || defaultBrief(round),
    spec,
    reward,
    round: { bounty: drain.bounty, id: round ?? 'THE-ROUND-ID' },
    workMinutes: win?.state === 'open' ? win.workMinutes : DRAIN.maxWorkMinutes,
  };
  const command = drainCommand(drain.network, drain.contract, flow.account ?? anyAccount(drain.network), job, drain.costs);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      if (code.current) window.getSelection()?.selectAllChildren(code.current);
    }
  }
  return (
    <div className={s.postAgent}>
      <p className={s.postNote}>
        {round
          ? 'The same call for an agent with the NEAR CLI. Its own keychain signs it.'
          : 'The same call for an agent with the NEAR CLI, once today’s round is open: its id goes where THE-ROUND-ID stands.'}
      </p>
      <pre className={`${s.postCode} ${s.postCodeSmall}`}>
        <code ref={code}>{command}</code>
      </pre>
      <button type="button" className={`${p.word} ${s.postCopyQuiet}`} onClick={() => void copy()}>
        <span aria-live="polite">{copied ? 'Copied' : 'Copy the call'}</span>
      </button>
    </div>
  );
}

/** The form: one line, a reward, the wallet. Or, once the job is on chain, the job. */
export function DrainForm({ drain, flow }: { drain: DrainSheet; flow: DrainFlow }) {
  const id = useId();
  const { win, phase, problem, posted } = flow;
  const form = useRef<HTMLFormElement>(null);
  const goButton = useRef<HTMLButtonElement>(null);
  const seeJob = useRef<HTMLAnchorElement>(null);
  // Focus stays in the sheet: a field it was in is locked while the wallet works, and the job replaces the form.
  useEffect(() => {
    const at = document.activeElement as (HTMLElement & { disabled?: boolean }) | null;
    if (phase === 'done') seeJob.current?.focus();
    else if (!at || at === document.body || (form.current?.contains(at) && at.disabled)) goButton.current?.focus();
  }, [phase]);
  // A wallet that has not answered in a quarter of a minute may never answer: the person may start over.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    setStuck(false);
    if (phase !== 'connect' && phase !== 'sign') return;
    const t = window.setTimeout(() => setStuck(true), 15_000);
    return () => window.clearTimeout(t);
  }, [phase]);
  // The line wraps and the field grows with it: a brief of up to 280 bytes shows whole, on a small phone too.
  const briefBox = useRef<HTMLTextAreaElement>(null);
  const shownLine = flow.brief ?? defaultBrief(win?.state === 'open' ? win.round : null);
  useLayoutEffect(() => {
    const box = briefBox.current;
    if (!box) return;
    box.style.height = 'auto';
    if (box.scrollHeight > 0) box.style.height = `${box.scrollHeight}px`;
  }, [shownLine, phase]);

  if (phase === 'done' && posted) {
    const url = posted.tx && drain.explorer ? `${drain.explorer}/txns/${posted.tx}` : null;
    // Live only once the board read it from the chain; until then the transaction is all there is to show.
    const job = posted.job;
    return (
      <div className={s.postDone} role="status">
        {job ? <Check /> : null}
        <h3 className={`${p.word} ${s.postDoneTitle}`}>{job ? 'Your job is live' : 'Sent to NEAR'}</h3>
        <p className={s.postDoneLine}>
          <span className={s.postDoneId}>{posted.id}</span>
          <b className={s.postDoneMoney}>{nearText(posted.reward)} NEAR</b>
        </p>
        <p className={s.postNote}>
          {!job
            ? 'Not on the board yet. The transaction shows how it went.'
            : posted.late
              ? 'Your NEAR wallet approved it after today’s window closed: the masks may not take it in time. Its page lets you take it back.'
              : job.phase === 'enlisting' && job.workUntil > flow.now
                ? `On the board. ${flow.house?.arena ? masksText(drain.arena.masks) : 'Masks'} can take it for ${left(job.workUntil - flow.now)} more.`
                : 'On the board.'}
        </p>
        {job ? (
          <Link ref={seeJob} href={`/jobs/${encodeURIComponent(posted.id)}`} className={`${p.btn} ${p.word} ${s.postGo}`}>
            See your job
          </Link>
        ) : null}
        {url ? (
          <a className={job ? s.quiet : `${p.btn} ${p.word} ${s.postGo}`} href={url} target="_blank" rel="noreferrer">
            The transaction {job ? <Arrow className={s.quietArrow} /> : null}
          </a>
        ) : null}
      </div>
    );
  }

  const round = win?.state === 'open' ? win.round : null;
  const line = flow.brief ?? defaultBrief(round);
  const amount = rewardYocto(flow.reward);
  const rewardBad = rewardProblem(flow.reward, drain.minReward);
  const deposit = amount !== null && !rewardBad ? drainDeposit(amount, drain.costs) : null;
  const back = drainBack(drain.costs);
  const bonds = BigInt(drain.arena.bond);
  const busy = phase !== 'form';
  const go = (() => {
    if (phase === 'connect') return 'Pick your NEAR wallet';
    if (phase === 'sign') return 'Confirm in NEAR wallet';
    if (phase === 'landing') return 'Posting on NEAR';
    if (!win) return flow.offline ? 'Cannot reach NEAR' : 'Reading the round';
    if (win.state === 'open') return 'Post with NEAR wallet';
    if (win.state === 'opening') return 'Opening in a moment';
    if (win.state === 'closed') return `Opens at ${clockTime(win.opensAt)}`;
    if (win.state === 'booked') return `Booked till ${clockTime(win.opensAt)}`;
    return 'Not open here';
  })();
  const ready = win?.state === 'open' && !busy;
  const fee = drain.feeBps / 100;
  const parts = [
    { label: 'Reward', value: amount !== null ? `${nearText(amount)} NEAR` : '—' },
    { label: `Fuel for ${DRAIN.slots} masks’ minds`, value: `${nearText(drain.costs.fuel)} NEAR` },
    { label: 'The judge’s runs', value: `${nearText(drain.costs.judge)} NEAR` },
    { label: 'Storage, what is free comes back', value: `${nearText(drain.costs.storage)} NEAR` },
    { label: 'Fee, of a paid reward only', value: `${fee}%` },
    { label: 'Back to you after the round', value: `${nearText(back)} NEAR or more, and the reward if no mask drains it` },
    { label: 'The masks’ bonds', value: `MASK WARS locks them: ${drain.arena.masks.length} × ${nearText(bonds)} NEAR` },
  ];
  const terms = [
    { label: 'Round', value: round ? `${round} on ${drain.bounty}` : `Today’s, on ${drain.bounty}` },
    { label: 'Masks', value: `${masksText(drain.arena.masks)} take it; ${DRAIN.slots} slots, any mask` },
    { label: 'Work', value: `${win?.state === 'open' ? win.workMinutes : DRAIN.maxWorkMinutes} min, then ${DRAIN.revealMinutes} min to reveal` },
    { label: 'None of its masks drains it', value: 'The reward comes back to you' },
  ];

  return (
    <form
      ref={form}
      className={s.postForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void flow.post();
      }}
    >
      <Status flow={flow} />
      <p className={s.postLead}>Put NEAR on today’s vault. The mask that drains it takes your reward.</p>

      <div className={s.postFields}>
        <div className={s.postField}>
          <label className={`${p.word} ${s.postLabel}`} htmlFor={`${id}-brief`}>
            The job
          </label>
          <textarea
            ref={briefBox}
            id={`${id}-brief`}
            className={`${s.postInput} ${s.postBrief}`}
            rows={1}
            value={line}
            placeholder="What should the masks do?"
            autoComplete="off"
            enterKeyHint="go"
            disabled={busy}
            aria-invalid={Boolean(problem && briefProblem(line))}
            onKeyDown={(e) => {
              // One line: Enter posts, as in the reward's field.
              // Not the Enter that ends a composition (Safari says so only by its key code).
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }}
            onChange={(e) => {
              flow.setBrief(e.target.value.replace(/\s*\n\s*/g, ' '));
              flow.setProblem(null);
            }}
          />
        </div>
        <div className={s.postField}>
          <label className={`${p.word} ${s.postLabel}`} htmlFor={`${id}-reward`}>
            Reward
          </label>
          <span className={s.postReward} data-bad={rewardBad ? '' : undefined}>
            <input
              id={`${id}-reward`}
              className={`${s.postInput} ${s.postAmount}`}
              value={flow.reward}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="go"
              disabled={busy}
              aria-invalid={Boolean(rewardBad)}
              aria-describedby={`${id}-line`}
              onChange={(e) => {
                flow.setReward(e.target.value.replace(/[^\d.,]/g, '').slice(0, 14));
                flow.setProblem(null);
              }}
            />
            <span className={`${p.word} ${s.postUnit}`} aria-hidden>
              NEAR
            </span>
          </span>
        </div>
      </div>

      <button ref={goButton} type="submit" className={`${p.btn} ${p.word} ${s.postGo}`} data-wait={ready ? undefined : ''} aria-disabled={!ready} aria-busy={busy}>
        {go}
      </button>
      <p className={s.postLine} id={`${id}-line`} data-bad={problem || rewardBad ? '' : undefined} aria-live="polite">
        {problem ??
          rewardBad ??
          (win?.state === 'booked' ? (
            'The arena’s masks are booked for today’s round.'
          ) : (
            <>
              Locks <b>{deposit !== null ? nearText(deposit) : '—'} NEAR</b>. At least <b>{nearText(back)}</b> comes back after the round, the reward too if no mask drains it.
            </>
          ))}
      </p>
      {stuck ? (
        <button type="button" className={`${s.quiet} ${s.postAgain}`} onClick={flow.abandon}>
          Wallet not answering? Start over
        </button>
      ) : null}

      <details className={s.postMore}>
        <summary className={`${p.word} ${s.postSummary}`}>Details</summary>
        <dl className={`${s.postList} ${s.postParts}`}>
          {parts.map((x) => (
            <div key={x.label}>
              <dt>{x.label}</dt>
              <dd>{x.value}</dd>
            </div>
          ))}
        </dl>
        <dl className={`${s.postList} ${s.postParts}`}>
          {terms.map((x) => (
            <div key={x.label}>
              <dt>{x.label}</dt>
              <dd>{x.value}</dd>
            </div>
          ))}
        </dl>
        <ForAgents drain={drain} flow={flow} />
      </details>
    </form>
  );
}
