'use client';

import {
  grantViewAction,
  type HistoryEvent,
  nearText,
  type RaceNote,
  readHistory,
  revokeViewAction,
  setViewKeyAction,
  VIEW_MESSAGE,
  VIEW_NONCE,
  VIEW_RECIPIENT,
  type Viewer,
  viewersOf,
  viewKeyFromSignature,
  viewKeyOf,
  type ViewKey,
} from '@maskwars/forge';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { connect, type Signer } from '@/app/forge/wallet';
import { FORGE_NET } from '@/lib/forge';
import { Info, type InfoRow } from './Info';
import { raceName } from './names';
import { Nums } from './Nums';
import p from './person.module.css';

/** How many times the page reads NEAR after a call, a second and a half apart, before it says it does not know. */
const READS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

type Phase = 'idle' | 'opening' | 'key' | 'open';

/**
 * A mask's race history, private: how its mind played each race, opened only for the accounts its owner chose. The page
 * shows it only when the factory's keeper sealed at least one note of this mask for an account that holds a view
 * (`readableHistory`). Anyone then sees that it exists and how many may read it; a reader's wallet signs one fixed
 * message, the page makes the reader's view key from that signature and opens, here in the browser, every race the
 * keeper sealed for that key. Nothing is sent anywhere to read it. The owner's own control (who may read) sits behind
 * one quiet button.
 */
export function HistoryPanel({
  name,
  account,
  owner,
  viewers,
  events,
}: {
  name: string;
  account: string;
  owner: string;
  viewers: readonly Viewer[];
  events: readonly HistoryEvent[];
}) {
  const router = useRouter();
  const id = useId();
  const NAME = name.toUpperCase();
  // A note written again (a correction) is the same race.
  const races = new Set(events.flatMap((e) => (e.kind === 'note' ? [e.race] : []))).size;
  const [phase, setPhase] = useState<Phase>('idle');
  const [line, setLine] = useState<string | null>(null);
  const [notes, setNotes] = useState<RaceNote[] | null>(null);
  const [reader, setReader] = useState<{ signer: Signer; view: ViewKey } | null>(null);
  const once = useRef(false);

  async function guard(act: () => Promise<void>) {
    if (once.current) return;
    once.current = true;
    try {
      await act();
    } finally {
      once.current = false;
    }
  }

  /** The reader's wallet signs the view message; the page makes the key, then opens what was shared with it. */
  const open = () =>
    guard(async () => {
      setPhase('opening');
      setLine(null);
      let signer: Signer;
      try {
        signer = await connect(FORGE_NET.rpcs);
      } catch {
        setLine('No NEAR wallet connected.');
        setPhase('idle');
        return;
      }
      const granted = viewers.find((v) => v.account === signer.accountId);
      if (!granted) {
        setLine(`Only the accounts ${NAME}’s owner chose read it. This wallet is ${signer.accountId}.`);
        setPhase('idle');
        return;
      }
      const sig = signer.signMessage ? await signer.signMessage(VIEW_MESSAGE, VIEW_RECIPIENT, VIEW_NONCE).catch(() => null) : null;
      if (!sig) {
        setLine('This wallet signed nothing, so no key was made. Nothing was sent.');
        setPhase('idle');
        return;
      }
      const view = await viewKeyFromSignature(new Uint8Array(sig), signer.accountId);
      setReader({ signer, view });
      const read = await readHistory(view, signer.accountId, events);
      setNotes(read);
      if (granted.key !== view.public) {
        setPhase('key');
        setLine(
          granted.key
            ? 'This wallet made another key than the one on NEAR. Save this one: races sealed for it open here.'
            : 'Save your view key on NEAR once: races sealed for it open here.',
        );
        return;
      }
      setPhase('open');
      setLine(read.length ? null : `No race of ${NAME} was shared with this key yet.`);
    });

  /** Saves the reader's view key on the factory, once for every mask; true once NEAR shows it. */
  const saveKey = () =>
    guard(async () => {
      if (!reader) return;
      setLine('Sent. Waiting for NEAR to confirm it.');
      const hash = await reader.signer.call(FORGE_NET.factory, setViewKeyAction(reader.view.public)).catch(() => null);
      for (let i = 0; i < READS; i++) {
        const k = await viewKeyOf(FORGE_NET, reader.signer.accountId).catch(() => null);
        if (k === reader.view.public) {
          setPhase('open');
          setLine('Your view key is on NEAR.');
          router.refresh();
          return;
        }
        if (!hash && i > 3) break;
        await sleep(1500);
      }
      setLine(hash ? 'NEAR does not show it yet. Look again in a minute.' : 'Not sent. Nothing changed.');
    });

  const readers = viewers.length;
  return (
    <section className={p.hist} aria-labelledby={`${id}-h`}>
      <div className={p.histHead}>
        <div className={p.copyText}>
          <p id={`${id}-h`} className={p.histTitle}>
            Race history
          </p>
          <p className={p.histState}>
            <span className={p.histLock} aria-hidden />
            Private · {readers === 0 ? 'shared with nobody yet' : readers === 1 ? '1 account reads it' : `${readers} accounts read it`}
            {races ? ` · ${races} ${races === 1 ? 'race' : 'races'} sealed on NEAR` : ''}
          </p>
        </div>
        {phase === 'key' ? (
          <button type="button" className={p.histBtn} onClick={saveKey}>
            Save view key
          </button>
        ) : phase !== 'open' && races > 0 ? (
          <button type="button" className={p.histBtn} onClick={open} disabled={phase === 'opening'} aria-busy={phase === 'opening'}>
            {phase === 'opening' ? 'Opening…' : 'Open history'}
          </button>
        ) : null}
      </div>
      {line ? (
        <p className={p.histLine} role="status">
          {line}
        </p>
      ) : null}
      {notes && notes.length ? <Notes notes={notes} /> : null}
      <HistoryOwner name={name} owner={owner} viewers={viewers} account={account} />
    </section>
  );
}

const RESULT: Record<RaceNote['result'], string> = { won: 'Broke it', held: 'Held', beaten: 'Beaten', missed: 'Missed' };

function Notes({ notes }: { notes: readonly RaceNote[] }) {
  return (
    <ol className={p.histRows}>
      {notes.map((n) => {
        const plan = n.sealed?.plan.join(' → ') ?? '—';
        const rows: InfoRow[] = [
          { label: 'Mind', value: n.mind ? `${n.mind.model} · ${n.mind.where}${n.mind.strategy ? ' · sealed strategy' : ''}` : 'The keeper’s plan' },
          ...n.attempts.map((a) => ({ label: `Attempt ${a.n}`, value: `${a.plan.join(' → ') || 'no plan'} · ${a.verdict}` })),
          { label: 'Sealed', value: n.sealed ? `seal #${n.sealed.seq} · ${plan}` : 'nothing' },
          { label: 'Prize', value: `${nearText(n.prize, 4)} NEAR` },
          { label: 'Loot', value: `${nearText(n.loot, 4)} NEAR` },
          ...(n.authorShare ? [{ label: `${(n.copyOf ?? 'author').toUpperCase()}’s share`, value: `${nearText(n.authorShare, 4)} NEAR` }] : []),
          { label: 'The mind spent', value: `${nearText(n.spent, 4)} NEAR` },
          ...n.txs.map((t) => ({ label: t.what, value: `${t.hash.slice(0, 10)}…`, href: `${FORGE_NET.explorer}/txns/${t.hash}` })),
        ];
        const took = BigInt(n.prize) + BigInt(n.loot);
        return (
          <li key={n.race} className={p.histRow} data-won={n.result === 'won' ? '' : undefined}>
            <span className={p.histRace}>
              <Nums text={raceName(n.race)} />
            </span>
            <span className={p.histResult}>{RESULT[n.result]}</span>
            <span className={p.histPlan}>{plan}</span>
            <span className={p.histAmount} data-tone={took > 0n ? 'money' : 'plain'}>
              {took > 0n ? `+${nearText(took)} NEAR` : ''}
            </span>
            <span className={p.histInfo}>
              <Info rows={rows} label={`${raceName(n.race)}, as the keeper noted it`} align="end" />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

type Busy = null | 'grant' | string;

/** The owner's quiet control: who may read the history. Anyone sees the button; only the owner's wallet acts. */
function HistoryOwner({ name, owner, viewers, account }: { name: string; owner: string; viewers: readonly Viewer[]; account: string }) {
  const router = useRouter();
  const id = useId();
  const NAME = name.toUpperCase();
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [line, setLine] = useState<string | null>(null);
  const once = useRef(false);

  async function run(what: Exclude<Busy, null>, act: (signer: Signer) => Promise<void>) {
    if (once.current) return;
    once.current = true;
    setBusy(what);
    setLine(null);
    try {
      let signer: Signer;
      try {
        signer = await connect(FORGE_NET.rpcs);
      } catch {
        setLine('No NEAR wallet connected. Nothing was sent.');
        return;
      }
      if (signer.accountId !== owner) {
        setLine(`Only ${NAME}’s owner does this. This wallet is ${signer.accountId}.`);
        return;
      }
      await act(signer);
    } finally {
      once.current = false;
      setBusy(null);
    }
  }

  /** Waits until the factory's list says `done`. */
  async function settle(hash: string | null, done: (list: readonly Viewer[]) => boolean, ok: string) {
    setLine('Sent. Waiting for NEAR to confirm it.');
    for (let i = 0; i < READS; i++) {
      const list = await viewersOf(FORGE_NET, name).catch(() => null);
      if (list && done(list)) {
        setLine(ok);
        router.refresh();
        return;
      }
      if (!hash && i > 3) break;
      await sleep(1500);
    }
    setLine(hash ? 'NEAR does not show it yet. Look again in a minute.' : 'Not sent. Nothing changed.');
  }

  const target = who.trim().toLowerCase();
  const valid = target.length >= 2 && target.length <= 64 && ACCOUNT.test(target) && target !== account;
  const grant = () =>
    run('grant', async (signer) => {
      const hash = await signer.call(FORGE_NET.factory, grantViewAction(name, target)).catch(() => null);
      await settle(hash, (l) => l.some((v) => v.account === target), `${target} holds a view of ${NAME}’s history.`);
      setWho('');
    });
  const revoke = (viewer: string) =>
    run(viewer, async (signer) => {
      const hash = await signer.call(FORGE_NET.factory, revokeViewAction(name, viewer)).catch(() => null);
      await settle(hash, (l) => !l.some((v) => v.account === viewer), `${viewer} gets no race of ${NAME} from now on.`);
    });

  return (
    <div className={p.owner} data-open={open ? '' : undefined}>
      <button type="button" className={p.ownerBtn} aria-expanded={open} aria-controls={`${id}-readers`} onClick={() => setOpen((o) => !o)}>
        Who reads it
        <span className={p.ownerChevron} aria-hidden />
      </button>
      {open ? (
        <div id={`${id}-readers`} className={p.ownerBox} role="group" aria-label={`Who reads ${NAME}’s history, for its owner`}>
          <p className={p.ownerHead}>For {NAME}’s owner</p>
          {viewers.length ? (
            <ul className={p.readers}>
              {viewers.map((v) => (
                <li key={v.account} className={p.reader}>
                  <span className={p.readerWho}>
                    <span className={p.readerName}>{v.account}</span>
                    <span className={p.readerKey}>{v.key ? 'View key saved' : 'No view key yet'}</span>
                  </span>
                  <button
                    type="button"
                    className={p.ownerQuiet}
                    onClick={() => revoke(v.account)}
                    disabled={busy !== null}
                    aria-busy={busy === v.account}
                  >
                    {busy === v.account ? 'Taking back…' : 'Take back'}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className={p.grant}
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) grant();
            }}
          >
            <p className={p.sharesLegend} id={`${id}-who-label`}>
              Let an account read it
            </p>
            <div className={p.grantRow}>
              <input
                id={`${id}-who`}
                aria-labelledby={`${id}-who-label`}
                className={p.grantInput}
                value={who}
                onChange={(e) => setWho(e.target.value)}
                placeholder="alice.near"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="email"
              />
              <button type="submit" className={p.ownerMain} disabled={!valid || busy !== null} aria-busy={busy === 'grant'}>
                {busy === 'grant' ? 'Granting…' : 'Grant'}
              </button>
            </div>
          </form>
          <p className={p.ownerLine} role="status">
            {line ?? 'A reader sees each race: the plans, the result, the money. Never the strategy.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}
