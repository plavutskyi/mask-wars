'use client';

import Image from 'next/image';
import Link from 'next/link';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { type BreakRequest, bountyOk as isBounty, contactOk as isContact, MIN_BOUNTY, normalizeRepo } from '@/lib/break';
import { usd } from '@/lib/format';
import s from './break.module.css';

const QUICK = [1_000, 5_000, 10_000] as const;

/** Left to right on the stage. Each right answer wakes one mask, Oracle last. */
const CAST = [
  { id: 'onyx', wakes: 0 },
  { id: 'oracle', wakes: 2 },
  { id: 'nova', wakes: 1 },
] as const;

const STEPS = ['repo', 'bounty', 'contact'] as const;
type Step = (typeof STEPS)[number];

const WRONG: Record<Step, string> = {
  repo: 'Paste a link to the code, like github.com/you/contract.',
  bounty: `The bounty starts at ${usd(MIN_BOUNTY)}.`,
  contact: 'Leave a handle or an email so we can reach you.',
};

const digits = (v: string) => Number(v.replace(/[^\d]/g, '').slice(0, 9) || 0);

export function BreakForm() {
  const id = useId();
  const [step, setStep] = useState(0);
  const [repo, setRepo] = useState('');
  const [bounty, setBounty] = useState('');
  const [contact, setContact] = useState('');
  const [site, setSite] = useState('');
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<BreakRequest | null>(null);
  const moved = useRef(false);

  const repoOk = normalizeRepo(repo);
  const amount = digits(bounty);
  const bountyOk = isBounty(amount);
  const contactOk = isContact(contact);

  const now = STEPS[step] as Step;
  const ok = { repo: Boolean(repoOk), bounty: bountyOk, contact: contactOk };
  const last = step === STEPS.length - 1;
  const awake = done ? 3 : [ok.repo, ok.bounty, ok.contact].filter(Boolean).length;

  // Focus follows the steps once the person has moved. The first field waits for a tap: no keyboard over the stage on arrival.
  useEffect(() => {
    if (moved.current) document.getElementById(`${id}-${STEPS[step]}`)?.focus();
  }, [id, step]);

  const go = (to: number) => {
    moved.current = true;
    setTried(false);
    setFailed(false);
    setStep(to);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    if (!ok[now]) {
      setTried(true);
      document.getElementById(`${id}-${now}`)?.focus();
      return;
    }
    if (!last) {
      go(step + 1);
      return;
    }
    if (!repoOk) return;
    const entry: BreakRequest = { repo: repoOk, bounty: amount, contact: contact.trim() };
    setSending(true);
    setFailed(false);
    try {
      const res = await fetch('/api/break', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...entry, site }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setDone(entry);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const wrong = tried && !ok[now];
  const note = failed
    ? 'Could not send. Try again in a minute.'
    : wrong
      ? WRONG[now]
      : last
        ? 'Only your code, before deploy. Only you see the break.'
        : null;

  return (
    <div className={s.body} data-done={done ? '' : undefined}>
      <section className={s.stage}>
        <h1 className={s.title}>
          <span className={`${s.word} ${s.titleA}`}>Break my</span> <span className={`${s.word} ${s.titleB}`}>contract</span>
        </h1>
        <div className={s.vault} aria-hidden>
          <Image src="/art/vault.webp" alt="" fill priority sizes="(max-width: 900px) 88vw, 60vh" quality={85} className={s.ring} />
          <i className={s.dark} />
          {CAST.map((m) => (
            <div key={m.id} className={s.mask} data-mask={m.id} data-awake={awake > m.wakes ? '' : undefined}>
              <Image src={`/art/${m.id}.webp`} alt="" fill priority sizes="(max-width: 900px) 50vw, 34vh" quality={80} />
            </div>
          ))}
        </div>
      </section>

      <section className={s.band}>
        {done ? (
          <div className={s.done} role="status">
            <div className={s.doneSum}>{usd(done.bounty)}</div>
            <p className={s.doneLine}>
              Request received for <b>{done.repo.replace(/^https?:\/\//, '')}</b>. We will reach you at <b>{done.contact}</b>.
            </p>
            <Link href="/" className={`${s.btn} ${s.quiet}`}>
              <span className={s.word}>Watch a race</span>
            </Link>
          </div>
        ) : (
          <form className={s.form} onSubmit={submit} noValidate>
            <p className={s.lede} data-first={step === 0 ? '' : undefined}>
              Put up a bounty. Masks race to drain your vault before you ship.
            </p>

            <div className={s.top}>
              <label htmlFor={`${id}-${now}`} className={`${s.word} ${s.label}`}>
                {now === 'repo' ? 'Repository' : now === 'bounty' ? 'Bounty' : 'Contact'}
              </label>
              {step > 0 ? (
                <button type="button" className={s.back} onClick={() => go(step - 1)}>
                  Back
                </button>
              ) : null}
              <span className={s.count} aria-label={`Step ${step + 1} of ${STEPS.length}`}>
                {step + 1}/{STEPS.length}
              </span>
            </div>

            <div className={s.row} key={now}>
              {now === 'repo' ? (
                <input
                  id={`${id}-repo`}
                  className={s.input}
                  data-bad={wrong ? '' : undefined}
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="github.com/you/contract"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  aria-invalid={wrong}
                />
              ) : null}
              {now === 'bounty' ? (
                <div className={s.money}>
                  <span className={s.dollar} aria-hidden>
                    $
                  </span>
                  <input
                    id={`${id}-bounty`}
                    className={`${s.input} ${s.num}`}
                    data-bad={wrong ? '' : undefined}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="5,000"
                    value={amount ? amount.toLocaleString('en-US') : ''}
                    onChange={(e) => setBounty(e.target.value)}
                    aria-invalid={wrong}
                  />
                </div>
              ) : null}
              {now === 'contact' ? (
                <input
                  id={`${id}-contact`}
                  className={s.input}
                  data-bad={wrong ? '' : undefined}
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="@handle or email"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  aria-invalid={wrong}
                />
              ) : null}
              <button type="submit" className={s.btn} disabled={sending} aria-busy={sending}>
                <span className={s.word}>{sending ? 'Sending' : last ? 'Request a race' : 'Next'}</span>
              </button>
            </div>

            {now === 'bounty' ? (
              <div className={s.quick} role="group" aria-label="Quick amounts">
                {QUICK.map((q) => (
                  <button key={q} type="button" className={s.chip} data-on={amount === q ? '' : undefined} onClick={() => setBounty(String(q))}>
                    {usd(q)}
                  </button>
                ))}
              </div>
            ) : null}

            {note ? (
              <p className={s.note} data-bad={wrong || failed ? '' : undefined} role={wrong || failed ? 'alert' : undefined}>
                {note}
              </p>
            ) : null}

            <input
              className={s.trap}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden
              name="site"
              value={site}
              onChange={(e) => setSite(e.target.value)}
            />
          </form>
        )}
      </section>
    </div>
  );
}
