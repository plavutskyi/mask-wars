'use client';

import type { CheckResult } from '@maskwars/check';
import Link from 'next/link';
import { type FormEvent, Fragment, useEffect, useRef, useState } from 'react';
import s from './check.module.css';
import { EXAMPLE, hostsOf, lineOf, partsOf, proofOf, readAt, refusalOf, restOf, txOf } from './show';

type State = { phase: 'idle' } | { phase: 'asking'; account: string } | { phase: 'answer'; check: CheckResult } | { phase: 'refused'; why: string };

const WORD = { allow: 'Allow', warn: 'Warn', block: 'Block' } as const;

/** One account in, one verdict out, read live through /api/check. Everything else waits behind Details. */
export function Check() {
  const [account, setAccount] = useState(EXAMPLE);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const asked = useRef(0);

  async function ask(id: string) {
    const name = id.trim();
    if (!name) return;
    const turn = ++asked.current;
    setState({ phase: 'asking', account: name });
    let next: State;
    try {
      const res = await fetch(`/api/check?account=${encodeURIComponent(name)}`, { cache: 'no-store' });
      next = res.ok ? { phase: 'answer', check: (await res.json()) as CheckResult } : { phase: 'refused', why: refusalOf(res.status, res.headers.get('retry-after')) };
    } catch {
      next = { phase: 'refused', why: refusalOf(0, null) };
    }
    // Only the latest question may answer.
    if (turn === asked.current) setState(next);
  }

  // A link may name the account: /check?account=intents.near asks at once.
  useEffect(() => {
    const named = new URLSearchParams(window.location.search).get('account');
    if (!named) return;
    setAccount(named);
    void ask(named);
    // Once, when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(account);
  }

  const asking = state.phase === 'asking';
  const check = state.phase === 'answer' ? state.check : null;

  return (
    <section className={s.panel} aria-label="MASK CHECK">
      <form className={s.form} onSubmit={submit}>
        <label className={s.field}>
          <span className={s.hidden}>NEAR account</span>
          <input
            className={s.input}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="alice.near"
            maxLength={64}
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button type="submit" className={s.btn} disabled={asking || !account.trim()} aria-busy={asking}>
          <span className={s.word}>{asking ? 'Reading the chain' : 'Check'}</span>
        </button>
      </form>

      <div className={s.result} role="status" aria-live="polite" data-phase={state.phase}>
        {check ? (
          <div className={s.verdict} data-verdict={check.verdict} key={`${check.account}:${check.checked_at}`}>
            <p className={`${s.word} ${s.stamp}`}>{WORD[check.verdict]}</p>
            <p className={s.who}>
              {check.account} <span className={s.net}>{check.network}</span>
            </p>
            <p className={s.line}>
              <Text text={lineOf(check)} />
            </p>
          </div>
        ) : state.phase === 'refused' ? (
          <p className={s.refused}>{state.why}</p>
        ) : asking ? (
          <p className={s.wait}>
            <span className={s.caret} aria-hidden />
            <span className={s.hidden}>Reading the chain</span>
          </p>
        ) : (
          <div className={s.idle}>
            <ul className={`${s.word} ${s.legend}`} aria-hidden>
              <li data-verdict="allow">Allow</li>
              <li data-verdict="warn">Warn</li>
              <li data-verdict="block">Block</li>
            </ul>
            <p className={s.hint}>One of three, read live from NEAR.</p>
          </div>
        )}
      </div>

      <details className={s.more}>
        <summary className={s.summary}>
          <span className={s.word}>Details</span>
          <Chevron />
        </summary>
        {check ? (
          <>
            <ul className={s.reasons}>
              {proofOf(check) ? (
                <li className={s.reason} data-level={check.verdict}>
                  <span className={s.dot} aria-hidden />
                  <span className={s.text}>
                    On chain:{' '}
                    <a className={s.tx} href={proofOf(check)!} target="_blank" rel="noreferrer">
                      the transaction
                    </a>
                  </span>
                </li>
              ) : null}
              {restOf(check).map((r, i) => {
                const tx = txOf(r);
                return (
                  <li key={`${r.code}:${i}`} className={s.reason} data-level={r.level}>
                    <span className={s.dot} aria-hidden />
                    <span className={s.text}>
                      <Text text={r.text} />
                      {tx ? (
                        <>
                          {' '}
                          <a className={s.tx} href={tx} target="_blank" rel="noreferrer">
                            Transaction
                          </a>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            <dl className={s.dl}>
              {readAt(check) ? (
                <>
                  <dt>Read at</dt>
                  <dd>
                    <Row parts={readAt(check)!} />
                  </dd>
                </>
              ) : null}
              <dt>From</dt>
              <dd>
                <Row parts={hostsOf(check)} />
              </dd>
            </dl>
          </>
        ) : (
          <p className={s.how}>Every answer is read from NEAR at one final block. On mainnet an allow takes two independent providers that agree.</p>
        )}
        <Link href="/mcp/connect" className={s.dev}>
          <span>For developers: call it from your agent</span>
          <Arrow />
        </Link>
      </details>
    </section>
  );
}

/** A reason's words. A time inside them reads as a date and never breaks across lines. */
function Text({ text }: { text: string }) {
  return partsOf(text).map((part, i) =>
    part.keep ? (
      <span key={i} className={s.keep}>
        {part.text}
      </span>
    ) : (
      part.text
    ),
  );
}

/** Facts side by side with a dot between them; a line breaks between two facts, never inside one. */
function Row({ parts }: { parts: readonly string[] }) {
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 ? ' ' : null}
      <span className={s.keep}>{i < parts.length - 1 ? `${part} ·` : part}</span>
    </Fragment>
  ));
}

function Chevron() {
  return (
    <svg className={s.chev} viewBox="0 0 20 20" aria-hidden focusable="false">
      <path d="M6 8l4 4 4-4" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg className={s.arrow} viewBox="0 0 24 12" aria-hidden focusable="false">
      <path d="M0 6h21M16 1l5 5-5 5" />
    </svg>
  );
}
