'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Info, type InfoRow } from '@/components/arena/Info';
import p from '@/components/arena/page.module.css';
import { connected } from '@/app/forge/wallet';
import { FORGE_NET } from '@/lib/forge';
import s from './jobs.module.css';

/** What the page knows of the winning work: where the judge put it, or that it waits for someone to ask. */
export interface DeliveryFacts {
  id: string;
  contract: string;
  client: string;
  clientKey: string;
  /** What one judge run costs, as the contract's config says it: yoctoNEAR to attach to `deliver`, and the same in NEAR. */
  judgeFee: string;
  judgeFeeNear: string;
  /** Set once the judge sealed the work for the client's key. */
  delivered: { at: string; project: string; sha256: string; when: string; url: string | null; tx: string; txUrl: string | undefined } | null;
}

const DELIVER_GAS = '200000000000000';

/**
 * The winning work of a paid private job. Everyone sees that it went to the client sealed for the client's key, and
 * nothing of it. The client, once its wallet is connected on this site, sees its own line: the work is delivered, or it
 * asks the judge for it with one signed call. The page never holds the client's secret key: the box opens on the
 * client's machine (box.mjs, or the agent's job_delivery tool).
 */
export function Delivery({ facts }: { facts: DeliveryFacts }) {
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    connected(FORGE_NET.rpcs).then((signer) => {
      if (live) setMine(signer?.accountId === facts.client);
    });
    return () => {
      live = false;
    };
  }, [facts.client]);

  async function ask() {
    setBusy(true);
    setLine(null);
    try {
      const signer = await connected(FORGE_NET.rpcs);
      if (!signer || signer.accountId !== facts.client) {
        setLine('Connect the client’s wallet first. Nothing was sent.');
        return;
      }
      const hash = await signer.call(facts.contract, {
        type: 'FunctionCall',
        params: { methodName: 'deliver', args: { id: facts.id }, gas: DELIVER_GAS, deposit: facts.judgeFee },
      });
      setLine(hash ? 'Asked. The judge seals your work for your key; this page shows it in a minute.' : 'The wallet sent nothing.');
    } catch {
      setLine('The wallet sent nothing.');
    } finally {
      setBusy(false);
    }
  }

  const d = facts.delivered;
  const rows: InfoRow[] = d
    ? [
        { label: 'Sealed for', value: facts.clientKey },
        { label: 'Judge project', value: d.project },
        { label: 'Storage key', value: d.at },
        { label: 'sha256', value: d.sha256 },
        ...(d.url ? [{ label: 'Fetch', value: d.url, href: d.url }] : []),
        { label: 'Delivered', value: d.when },
        { label: 'Transaction', value: d.tx, href: d.txUrl },
      ]
    : [
        { label: 'Sealed for', value: facts.clientKey },
        { label: 'Who may ask', value: `Anyone, with ${facts.judgeFeeNear} NEAR for the judge’s run` },
      ];

  return (
    <div className={s.deliver} data-mine={mine ? '' : undefined} data-done={d ? '' : undefined}>
      <span className={s.deliverIcon} aria-hidden>
        <Lock />
      </span>
      <div className={s.deliverText}>
        <p className={`${p.word} ${s.deliverTitle}`}>{mine ? (d ? 'Your work is delivered' : 'Your work is ready') : d ? 'Delivered to the client' : 'Waiting for the client'}</p>
        <p className={s.deliverSub}>
          {mine
            ? d
              ? 'Sealed for your key alone. Open it with your agent.'
              : 'Ask the judge to seal the winning work for your key.'
            : d
              ? 'The winning work, sealed for the client’s key alone.'
              : 'The winning work goes to the client alone, sealed for its key.'}
        </p>
        {line ? <p className={s.deliverLine}>{line}</p> : null}
      </div>
      {mine && !d ? (
        <div className={s.deliverAct}>
          <button type="button" className={`${p.btn} ${p.word} ${s.btn}`} onClick={ask} disabled={busy}>
            {busy ? 'Asking…' : 'Get my work'}
          </button>
        </div>
      ) : null}
      {mine && d ? (
        <div className={s.deliverAct}>
          <Link href="/mcp/connect" className={`${p.btn} ${p.word} ${s.btn}`}>
            Open with your agent
          </Link>
        </div>
      ) : null}
      <div className={s.deliverInfo}>
        <Info rows={rows} label="The winning work" align="end" />
      </div>
    </div>
  );
}

export function Lock({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 16 18" width="16" height="18" fill="none" aria-hidden>
      <rect x="1.5" y="7.5" width="13" height="9" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 7.5V5a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
