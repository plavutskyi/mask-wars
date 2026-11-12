'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Arrow } from '@/components/Arrow';
import { isMine } from './mine';
import { signIn, signOut } from './wallet';
import s from './jobs.module.css';

/** `cancel` runs the same `finish` as `close` and `settle`, which the contract asks 200 TGas for: plain transfers back to
 * the client and to whoever locked a bond. What it does not burn comes back. */
const CANCEL_GAS = (200n * 10n ** 12n).toString();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function phaseOf(id: string): Promise<string | null> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}?missing=null&at=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return null;
  const job = (await res.json().catch(() => null)) as { phase?: unknown } | null;
  return typeof job?.phase === 'string' ? job.phase : null;
}

/**
 * Take a job back: its client's own `cancel`, which the contract takes while no mask has sealed a step on it. The
 * reward, the fuel and the storage come back at once (the record's few bytes stay on chain), and so does every bond a
 * mask was waiting with. Shown on the device that posted the job (mine.ts), in a row of its own under the job's action:
 * a refresh of the page never moves it, so nothing the person started is lost. The wallet that signs must be the job's
 * client, or nothing is sent.
 */
export function TakeBack({ id, client, contract, explorer, alone = false }: { id: string; client: string; contract: string; explorer: string | null; alone?: boolean }) {
  const router = useRouter();
  const [shown, setShown] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'connect' | 'sign' | 'landing'>('idle');
  const [line, setLine] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  /** The account the wallet signed in with when it was not the client's, while the person may switch. */
  const [other, setOther] = useState<string | null>(null);
  useEffect(() => setShown(isMine(id)), [id]);
  if (!shown) return null;

  async function take(fresh = false) {
    if (phase !== 'idle') return;
    setLine(null);
    setTx(null);
    const before = other;
    setOther(null);
    setPhase('connect');
    let signer;
    try {
      if (fresh) await signOut();
      signer = await signIn();
    } catch {
      setPhase('idle');
      return setLine('No NEAR wallet connected. Nothing was sent.');
    }
    if (signer.accountId !== client) {
      setPhase('idle');
      setOther(signer.accountId);
      // A wallet that would not sign out comes back with the same account: switching is up to the wallet then.
      if (fresh && signer.accountId === before) return setLine(`Your NEAR wallet kept ${signer.accountId}. Switch to ${client} there, then take it back. Nothing was sent.`);
      return setLine(`This is ${signer.accountId}: only ${client} can take this job back. Nothing was sent.`);
    }
    setPhase('sign');
    let hash: string | null = null;
    let sent = true;
    try {
      hash = await signer.call(contract, { type: 'FunctionCall', params: { methodName: 'cancel', args: { id }, gas: CANCEL_GAS, deposit: '0' } });
    } catch {
      sent = false;
    }
    setPhase('landing');
    for (let i = 0; i < (sent ? 20 : 4); i++) {
      await wait(i === 0 ? 1200 : 2000);
      if ((await phaseOf(id)) === 'cancelled') {
        setPhase('idle');
        setLine('Taken back. Your NEAR is on its way to your account.');
        // The page reads the job again: it says "Taken back", with its course.
        router.refresh();
        return;
      }
    }
    setPhase('idle');
    setTx(hash);
    // Only what was seen: the job still reads as open.
    setLine(hash ? 'Not taken back yet. The transaction shows how it went.' : 'The job is still open. Your NEAR wallet shows whether anything was sent.');
  }

  const busy = phase !== 'idle';
  const word = phase === 'connect' ? 'Pick your NEAR wallet' : phase === 'sign' ? 'Confirm in NEAR wallet' : phase === 'landing' ? 'Taking it back' : 'Take it back';
  const url = tx && explorer ? `${explorer}/txns/${tx}` : null;
  return (
    <div className={s.takeBack} data-alone={alone ? '' : undefined}>
      <button type="button" className={s.quiet} onClick={() => void take()} aria-busy={busy} aria-disabled={busy}>
        {word}
      </button>
      {other && !busy ? (
        <button type="button" className={s.quiet} onClick={() => void take(true)}>
          Use another wallet
        </button>
      ) : null}
      {line ? (
        <span className={s.takeBackLine} role="status">
          {line}
        </span>
      ) : null}
      {url ? (
        <a className={s.quiet} href={url} target="_blank" rel="noreferrer">
          The transaction <Arrow className={s.quietArrow} />
        </a>
      ) : null}
    </div>
  );
}
