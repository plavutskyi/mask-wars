'use client';

import { allowCopyAction, copyTerms, getMask, nearText, payAuthorAction, shareText, stopCopyAction } from '@maskwars/forge';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { connect, type Signer } from '@/app/forge/wallet';
import { FORGE_NET } from '@/lib/forge';
import p from './person.module.css';

/** The shares an author picks from, basis points: 5% to the 30% the contracts allow. */
const SHARES = [500, 1000, 1500, 2000, 2500, 3000] as const;
/** How many times the page reads NEAR after a call, a second and a half apart, before it says it does not know. */
const READS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Busy = null | 'open' | 'stop' | 'collect';

/**
 * The author's quiet control for copying, on their mask's page: open the mask to copies at a share, change the share
 * for new copies, stop new copies, and collect what waits for them on their copies. Behind one quiet button; anyone sees
 * it, only the owner's wallet acts. What the page says after the wallet comes from NEAR: the mask read again, each
 * copy's terms read again. A wallet's word alone is never a success.
 */
export function CopyOwner({
  name,
  owner,
  copyable,
  authorBps,
  copies,
  due,
  waiting,
}: {
  name: string;
  owner: string;
  copyable: boolean;
  authorBps: number;
  copies: number;
  /** yoctoNEAR waiting for the author on its copies, as a string. */
  due: string;
  /** The accounts of the copies where something waits. */
  waiting: readonly string[];
}) {
  const router = useRouter();
  const id = useId();
  const NAME = name.toUpperCase();
  const [open, setOpen] = useState(false);
  const [bps, setBps] = useState<number>(copyable && authorBps ? authorBps : 3000);
  const [busy, setBusy] = useState<Busy>(null);
  const [line, setLine] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const once = useRef(false);
  const waitingNear = BigInt(due);

  /** The owner's wallet, or a line that says whose it is not. */
  async function ownerSigner(): Promise<Signer | null> {
    let signer: Signer;
    try {
      signer = await connect(FORGE_NET.rpcs);
    } catch {
      setLine('No NEAR wallet connected. Nothing was sent.');
      return null;
    }
    if (signer.accountId !== owner) {
      setLine(`Only ${NAME}’s owner does this. This wallet is ${signer.accountId}.`);
      return null;
    }
    return signer;
  }

  async function run(what: Exclude<Busy, null>, act: (signer: Signer) => Promise<void>) {
    if (once.current) return;
    once.current = true;
    setBusy(what);
    setLine(null);
    setTx(null);
    try {
      const signer = await ownerSigner();
      if (signer) await act(signer);
    } finally {
      once.current = false;
      setBusy(null);
    }
  }

  /** Opens the mask to copies at `bps`, or changes the share for new ones; true once NEAR shows it. */
  const allow = () =>
    run('open', async (signer) => {
      const hash = await signer.call(FORGE_NET.factory, allowCopyAction(name, bps)).catch(() => null);
      setTx(hash);
      setLine('Sent. Waiting for NEAR to confirm it.');
      for (let i = 0; i < READS; i++) {
        const m = await getMask(FORGE_NET, name).catch(() => null);
        if (m?.copyable && m.author_bps === bps) {
          setLine(
            copyable
              ? `Done. New copies of ${NAME} pay you ${shareText(bps)}; copies made before keep their share.`
              : `${NAME} is open to copies. Each copy pays you ${shareText(bps)} of what it wins.`,
          );
          router.refresh();
          return;
        }
        if (!hash && i > 3) break;
        await sleep(1500);
      }
      setLine(hash ? 'NEAR does not show it yet. Look again in a minute.' : 'Not sent. Nothing changed.');
    });

  /** Closes the mask to new copies; copies already made keep playing. */
  const stop = () =>
    run('stop', async (signer) => {
      const hash = await signer.call(FORGE_NET.factory, stopCopyAction(name)).catch(() => null);
      setTx(hash);
      setLine('Sent. Waiting for NEAR to confirm it.');
      for (let i = 0; i < READS; i++) {
        const m = await getMask(FORGE_NET, name).catch(() => null);
        if (m && !m.copyable) {
          setLine(
            copies > 0
              ? `Closed to new copies. The ${copies === 1 ? 'copy' : `${copies} copies`} made keep playing and paying you.`
              : 'Closed to new copies.',
          );
          router.refresh();
          return;
        }
        if (!hash && i > 3) break;
        await sleep(1500);
      }
      setLine(hash ? 'NEAR does not show it yet. Look again in a minute.' : 'Not sent. Nothing changed.');
    });

  /** Collects the author's share from every copy where it waits: each copy's own code sends it to this mask. */
  const collect = () =>
    run('collect', async (signer) => {
      const before = await Promise.all(waiting.map((a) => copyTerms(FORGE_NET, a).catch(() => null)));
      let last: string | null = null;
      for (const [k, account] of waiting.entries()) {
        setLine(waiting.length > 1 ? `Collecting from copy ${k + 1} of ${waiting.length}…` : 'Collecting…');
        last = (await signer.call(account, payAuthorAction()).catch(() => null)) ?? last;
        setTx(last);
      }
      setLine('Sent. Waiting for NEAR to confirm it.');
      for (let i = 0; i < READS; i++) {
        const after = await Promise.all(waiting.map((a) => copyTerms(FORGE_NET, a).catch(() => null)));
        const got = after.reduce((sum, t, k) => sum + (t && before[k] ? t.paid - before[k]!.paid : 0n), 0n);
        if (got > 0n) {
          setLine(`Collected ${nearText(got.toString())} NEAR to ${NAME}’s account. Take it out below.`);
          router.refresh();
          return;
        }
        if (!last && i > 3) break;
        await sleep(1500);
      }
      setLine(last ? 'NEAR does not show it yet. Look again in a minute.' : 'Not sent. Your share waits on the copies.');
    });

  const label = copyable ? 'Manage copying' : 'Let others copy';
  const change = copyable && bps !== authorBps;

  return (
    <div className={p.owner} data-open={open ? '' : undefined}>
      <button
        type="button"
        className={p.ownerBtn}
        aria-expanded={open}
        aria-controls={`${id}-owner`}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <span className={p.ownerChevron} aria-hidden />
      </button>
      {open ? (
        <div id={`${id}-owner`} className={p.ownerBox} role="group" aria-label={`${NAME}’s copying, for its owner`}>
          <p className={p.ownerHead}>For {NAME}’s owner</p>
          <fieldset className={p.shares} disabled={busy !== null}>
            <legend className={p.sharesLegend}>
              {copyable ? `Your share of each new copy’s wins · now ${shareText(authorBps)}` : 'Your share of each copy’s wins'}
            </legend>
            {SHARES.map((v) => (
              <label key={v} className={p.share} data-on={v === bps ? '' : undefined}>
                <input type="radio" name={`${id}-share`} value={v} checked={v === bps} onChange={() => setBps(v)} />
                {shareText(v)}
              </label>
            ))}
          </fieldset>
          <div className={p.ownerActions}>
            {!copyable ? (
              <button type="button" className={p.ownerMain} onClick={allow} disabled={busy !== null} aria-busy={busy === 'open'}>
                {busy === 'open' ? 'Opening…' : `Let others copy · ${shareText(bps)}`}
              </button>
            ) : change || busy === 'open' ? (
              <button type="button" className={p.ownerMain} onClick={allow} disabled={busy !== null} aria-busy={busy === 'open'}>
                {busy === 'open' ? 'Changing…' : `Change share to ${shareText(bps)}`}
              </button>
            ) : null}
            {waitingNear > 0n ? (
              <button type="button" className={p.ownerMain} onClick={collect} disabled={busy !== null} aria-busy={busy === 'collect'}>
                {busy === 'collect' ? 'Collecting…' : `Collect ${nearText(due)} NEAR`}
              </button>
            ) : null}
            {copyable ? (
              <button type="button" className={p.ownerQuiet} onClick={stop} disabled={busy !== null} aria-busy={busy === 'stop'}>
                {busy === 'stop' ? 'Stopping…' : 'Stop new copies'}
              </button>
            ) : null}
          </div>
          <p className={p.ownerLine} role="status">
            {line ??
              (waitingNear > 0n
                ? `${nearText(due)} NEAR waits for you on ${waiting.length === 1 ? '1 copy' : `${waiting.length} copies`}.`
                : copyable
                  ? 'A new share applies to copies made from now on.'
                  : 'Copies play your sealed strategy in a TEE. Nobody reads it.')}
            {tx && busy === null ? (
              <>
                {' '}
                <a href={`${FORGE_NET.explorer}/txns/${tx}`} target="_blank" rel="noreferrer">
                  On NEAR
                </a>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
