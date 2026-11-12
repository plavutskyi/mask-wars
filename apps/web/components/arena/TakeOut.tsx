'use client';

import { accountState, copyTerms, fuelAction, fueled, nearText, takeOut, withdrawAction, withdrawn, type Withdrawn } from '@maskwars/forge';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { connect } from '@/app/forge/wallet';
import { FORGE_NET } from '@/lib/forge';
import p from './person.module.css';
import s from './page.module.css';

type Phase = 'idle' | 'signing' | 'checking' | 'done' | 'gone' | 'pending' | 'wrong' | 'failed';
/** The owner's two moves with the prize: take it out (`withdraw`), or let the mask pay for its own mind (`fuel`). */
type Move = 'withdraw' | 'fuel';
/** The least the factory's `refuel` takes, so the least the mask's `fuel` sends: below it the move is not offered. */
const MIN_FUEL = 10n ** 23n;

/** How many times the page asks NEAR about the withdraw, a second and a half apart, before it says it does not know. */
const READS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The prize on a person's mask, and the owner's two calls on the mask's own account: `withdraw` gives it to the
 * owner; `fuel` puts it into the mask's own tank, so the mask pays for its own mind with what it won. Anyone sees what
 * waits there; only the owner's wallet moves it, and the gas fund stays for the next race. What the page says after
 * the wallet comes from NEAR, as `/forge` does for a forge: the transaction's outcome and the amount the mask's own log
 * names, then the mask's account read again. A wallet's word alone is never a success. */
export function TakeOut({
  name,
  account,
  owner,
  amount,
  author = null,
}: {
  name: string;
  account: string;
  owner: string;
  amount: string;
  /** For a copy: its author's name. The copy's own code pays the author's share in the same withdraw, so what is left
   * for the owner is read from the copy's terms, not from its balance. */
  author?: string | null;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [move, setMove] = useState<Move>('withdraw');
  const router = useRouter();
  const [who, setWho] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  /** On the mask's account for its owner: the page's figure until NEAR answers, then what NEAR says. */
  const [shown, setShown] = useState(amount);
  const busy = useRef(false);
  const NAME = name.toUpperCase();
  // The page reads the chain again (after a copy's share is collected onto this mask, say): show the new figure.
  useEffect(() => {
    if (phase === 'idle') setShown(amount);
  }, [amount, phase]);

  async function take(m: Move) {
    if (busy.current) return;
    busy.current = true;
    setMove(m);
    setPhase('signing');
    try {
      let signer;
      try {
        signer = await connect(FORGE_NET.rpcs);
      } catch {
        setPhase('failed');
        return;
      }
      setWho(signer.accountId);
      if (signer.accountId !== owner) {
        setPhase('wrong');
        return;
      }
      let hash: string | null = null;
      try {
        hash = await signer.call(account, m === 'fuel' ? fuelAction() : withdrawAction());
      } catch {
        // A wallet can fail after it has sent: the mask's account says whether the prize left.
      }
      setTx(hash);
      setPhase('checking');
      let got: Withdrawn = { state: 'unknown' };
      for (let i = 0; hash && got.state === 'unknown' && i < READS; i++) {
        const read = m === 'fuel' ? fueled : withdrawn;
        got = await read(FORGE_NET, hash, owner, account).catch((): Withdrawn => ({ state: 'unknown' }));
        if (got.state === 'unknown') await sleep(1500);
      }
      const left = author
        ? ((await copyTerms(FORGE_NET, account).catch(() => null))?.owner ?? BigInt(amount))
        : takeOut(await accountState(FORGE_NET, account).catch(() => null));
      if (got.state === 'done') {
        setShown(got.amount.toString());
        setPhase('done');
        // The tank on the page is the factory's: read it again.
        if (m === 'fuel') router.refresh();
      } else if (got.state === 'failed') {
        setShown(left.toString());
        setPhase('failed');
      } else if (left < BigInt(amount)) {
        // No transaction NEAR knows, but the prize is no longer on the mask: only its owner's calls move it.
        setShown(left.toString());
        setPhase('gone');
      } else {
        setPhase(hash ? 'pending' : 'failed');
      }
    } finally {
      busy.current = false;
    }
  }

  const fuel = move === 'fuel';
  const line = {
    idle: `Waiting on ${NAME}’s account for its owner.`,
    signing: `Waiting on ${NAME}’s account for its owner.`,
    checking: 'Sent. Waiting for NEAR to confirm it.',
    done: fuel ? `Fueled. ${nearText(shown)} NEAR went into ${NAME}’s mind.` : `Taken out. ${nearText(shown)} NEAR went to ${owner}.`,
    gone: fuel ? `Fueled. The prize left ${NAME}’s account for its mind.` : `Taken out. The prize left ${NAME}’s account for ${owner}.`,
    pending: `NEAR does not show it yet. The prize is still on ${NAME}’s account.`,
    wrong: `Only ${NAME}’s owner moves it. This wallet is ${who}.`,
    failed: fuel ? 'Not fueled. The prize stays on the mask.' : 'Not taken out. The prize stays on the mask.',
  }[phase];
  const over = phase === 'done' || phase === 'gone';

  return (
    <section className={p.take} aria-labelledby="take" data-phase={phase}>
      <div className={p.takeText}>
        <h2 id="take" className={`${s.word} ${p.takeTitle}`}>
          {over ? (fuel ? 'Fueled' : 'Taken out') : 'On its account'}
        </h2>
        {phase !== 'gone' ? (
          <span className={p.takeNum}>
            {nearText(shown)}
            <span className={`${s.word} ${s.unit}`}>NEAR</span>
          </span>
        ) : null}
        <p className={p.takeLine} role="status">
          {line}
          {tx && phase !== 'signing' ? (
            <>
              {' '}
              <a href={`${FORGE_NET.explorer}/txns/${tx}`} target="_blank" rel="noreferrer">
                On NEAR
              </a>
            </>
          ) : null}
        </p>
      </div>
      {!over ? (
        <div className={p.takeActs}>
          <button
            type="button"
            className={`${s.btn} ${s.word} ${p.takeBtn}`}
            onClick={() => take('withdraw')}
            disabled={phase === 'signing' || phase === 'checking'}
            aria-busy={!fuel && (phase === 'signing' || phase === 'checking')}
          >
            {!fuel && phase === 'signing' ? 'Signing…' : !fuel && phase === 'checking' ? 'Confirming…' : 'Take it out'}
          </button>
          {BigInt(shown) >= MIN_FUEL ? (
            <button
              type="button"
              className={`${s.btn} ${s.word} ${p.fuelBtn}`}
              onClick={() => take('fuel')}
              disabled={phase === 'signing' || phase === 'checking'}
              aria-busy={fuel && (phase === 'signing' || phase === 'checking')}
            >
              {fuel && phase === 'signing' ? 'Signing…' : fuel && phase === 'checking' ? 'Confirming…' : 'Fuel its mind'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
