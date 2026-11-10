'use client';

import Link from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Arrow } from '@/components/Arrow';
import p from '@/components/arena/page.module.css';
import type { PostCall } from './post';
import s from './jobs.module.css';

/**
 * The button that posts a job, and its sheet: the one call that opens a job on the jobs contract, ready to copy and
 * sign with the client's own wallet. The page sends nothing and holds no key. Rendered only when the contract is on
 * chain and can open a job.
 */
export function PostJob({ calls, className, children }: { calls: PostCall[]; className: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const call = calls[at] ?? calls[0];

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    sheet.current?.querySelector<HTMLElement>('[data-first]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
        return;
      }
      if (e.key !== 'Tab' || !sheet.current) return;
      const stops = [...sheet.current.querySelectorAll<HTMLElement>('a[href], button, summary')];
      const first = stops[0];
      const last = stops.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      root.style.overflow = before;
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  if (!call) return null;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard here: the call stays on screen, selected, to copy by hand.
      const code = sheet.current?.querySelector('code');
      if (code) window.getSelection()?.selectAllChildren(code);
    }
  }

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <>
      <button ref={button} type="button" className={className} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open
        ? createPortal(
            <div className={s.postScrim} onClick={close}>
              <div ref={sheet} className={s.post} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onClick={(e) => e.stopPropagation()}>
                <header className={s.postHead}>
                  <h2 id={`${id}-title`} className={`${p.word} ${s.postTitle}`}>
                    Post a job
                  </h2>
                  <button type="button" className={s.postClose} aria-label="Close" data-first onClick={close}>
                    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden>
                      <path d="M4 4l12 12M16 4L4 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </header>

                {calls.length > 1 ? (
                  <div className={s.postKinds} role="tablist" aria-label="The kind of work">
                    {calls.map((c, i) => (
                      <button
                        key={c.kind}
                        type="button"
                        role="tab"
                        aria-selected={i === at}
                        className={`${p.word} ${s.postKind}`}
                        data-kind={c.kind}
                        onClick={() => {
                          setAt(i);
                          setCopied(false);
                        }}
                      >
                        {c.word}
                      </button>
                    ))}
                  </div>
                ) : null}

                <p className={s.postLead}>
                  One call opens the job and locks <b>{call.deposit} NEAR</b> on the jobs contract. Your own wallet signs it.
                </p>

                <pre className={s.postCode}>
                  <code>{call.command}</code>
                </pre>

                <button type="button" className={`${p.btn} ${p.word} ${s.postCopy}`} onClick={() => copy(call.command)}>
                  <span aria-live="polite">{copied ? 'Copied' : 'Copy the call'}</span>
                </button>

                <details className={s.postMore}>
                  <summary className={`${p.word} ${s.postSummary}`}>Details</summary>
                  <dl className={s.postList}>
                    {call.fill.map((f) => (
                      <div key={f.name}>
                        <dt>{f.name}</dt>
                        <dd>{f.what}</dd>
                      </div>
                    ))}
                  </dl>
                  <dl className={`${s.postList} ${s.postParts}`}>
                    {call.parts.map((x) => (
                      <div key={x.label}>
                        <dt>{x.label}</dt>
                        <dd>{x.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className={s.postNote}>Run it with the NEAR CLI. What the job does not use comes back to your account.</p>
                </details>

                <Link href="/mcp/connect" className={s.quiet}>
                  Let your agent write it <Arrow className={s.quietArrow} />
                </Link>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
