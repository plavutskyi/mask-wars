'use client';

import { useId, useState } from 'react';
import s from './hire.module.css';

/** How the money goes, in four stops: one large word each, in the order the payer meets them. One line each behind «i». */
const STOPS = [
  { word: 'Your vault', line: 'The payer proves the vault is theirs, with its passkey or NEAR wallet. Only then is there an address.' },
  { word: 'Any chain', line: 'A coin from Solana, Base, Ethereum, Arbitrum, Tron or Bitcoin, sent from any wallet or exchange.' },
  { word: 'NEAR Intents', line: '1Click swaps it to NEAR, at most 1% off the price, or sends it back to the same vault.' },
  { word: 'Funded', line: 'The NEAR is in the vault with the job’s note, the team’s to move. MASK WARS never holds it.' },
] as const;

/** `live`: deposit addresses are open (HIRE_LIVE); until then the details say when they open. */
export function Flow({ live }: { live: boolean }) {
  const id = useId();
  const [info, setInfo] = useState(false);
  return (
    <div className={s.flow}>
      <div className={s.flowTop}>
        <span className={`${s.word} ${s.flowLabel}`}>How the money goes</span>
        <button type="button" className={s.info} aria-expanded={info} aria-controls={`${id}-details`} aria-label="Details" onClick={() => setInfo((v) => !v)}>
          i
        </button>
      </div>
      <ol className={s.stops} id={`${id}-details`} data-open={info ? '' : undefined}>
        {STOPS.map((x, i) => (
          <li key={x.word} className={s.stop}>
            <span className={s.stopNum} aria-hidden>
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className={`${s.word} ${s.stopWord}`}>{x.word}</span>
            {info ? <span className={s.stopLine}>{x.line}</span> : null}
          </li>
        ))}
      </ol>
      {info ? <p className={s.flowNote}>{live ? 'Deposit addresses are open.' : 'Prices are live now. Deposit addresses open soon.'}</p> : null}
    </div>
  );
}
