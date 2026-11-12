'use client';

import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { useCopy } from './ui';
import release from './release.json';
import s from './hire.module.css';

interface Way {
  id: string;
  label: string;
  /** What it is, over the code: one line to paste, or one file to add. */
  title: string;
  /** Many lines: the code reads as a block, and Copy sits under it. */
  block?: boolean;
  text: string;
  note: string;
}

/** The React way: the same pinned script, loaded once, and the element with its `hire:funded` event as a callback. */
function reactWay(origin: string): string {
  return `'use client';
import { useEffect, useRef } from 'react';

const SRC = '${origin}/hire/${release.file}';
const SRI = '${release.integrity}';

/** Hire the swarm: AI masks take the job, paid from any wallet on any chain. */
export function HireSwarm({ job, target, usd, onFunded }: { job: string; target: string; usd: number; onFunded?: (detail: unknown) => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!document.querySelector(\`script[src="\${SRC}"]\`)) {
      document.head.append(Object.assign(document.createElement('script'), { src: SRC, integrity: SRI, crossOrigin: 'anonymous', async: true }));
    }
    const el = ref.current;
    const funded = (e: Event) => onFunded?.((e as CustomEvent).detail);
    el?.addEventListener('hire:funded', funded);
    return () => el?.removeEventListener('hire:funded', funded);
  }, [onFunded]);
  // @ts-expect-error <mask-wars-hire> is a custom element: the script registers it.
  return <mask-wars-hire ref={ref} job={job} target={target} usd={usd} />;
}`;
}

export function waysTo(origin: string): Way[] {
  return [
    {
      id: 'html',
      label: 'HTML',
      title: 'One line',
      text: `<script src="${origin}/hire/${release.file}" integrity="${release.integrity}" crossorigin="anonymous" async></script><mask-wars-hire job="Attack my contract before launch" target="your-contract.near" usd="250"></mask-wars-hire>`,
      note: 'Any page, any framework. Pinned: the browser runs this exact file or none. The team proves its vault in the checkout.',
    },
    {
      id: 'react',
      label: 'React',
      title: 'One file',
      block: true,
      text: reactWay(origin),
      note: 'React 19, Next.js or Vite: one file, the same pinned script. <HireSwarm job="Attack my contract before launch" target="your-contract.near" usd={250} />',
    },
    {
      id: 'events',
      label: 'Events',
      title: 'One line',
      text: `document.querySelector('mask-wars-hire').addEventListener('hire:funded', (e) => console.log(e.detail.job.id, e.detail.near));`,
      note: 'Events tell your page what the checkout saw. Before you give anything for a hire, check it on chain.',
    },
  ];
}

/** The code to paste (one line, or one file for React), and one button that copies it. */
export function Embed({ origin }: { origin: string }) {
  const id = useId();
  const ways = waysTo(origin);
  const [active, setActive] = useState(0);
  const [copied, copy] = useCopy();
  const code = useRef<HTMLElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const way = ways[active]!;

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (active + step + ways.length) % ways.length;
    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <div className={s.embed}>
      <div className={s.embedTop}>
        <span className={`${s.word} ${s.embedLabel}`}>{way.title}</span>
        <span className={s.grow} />
        <div className={s.tabs} role="tablist" aria-label="Embed">
          {ways.map((w, i) => (
            <button
              key={w.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${w.id}`}
              aria-selected={i === active}
              aria-controls={`${id}-way`}
              tabIndex={i === active ? 0 : -1}
              className={`${s.tab} ${s.word}`}
              onClick={() => setActive(i)}
              onKeyDown={onTabKey}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div id={`${id}-way`} role="tabpanel" aria-labelledby={`${id}-tab-${way.id}`} className={s.embedRow} data-block={way.block ? '' : undefined}>
        <code ref={code} className={s.code}>
          {way.text}
        </code>
        <button type="button" className={s.btn} onClick={() => copy(way.id, way.text, code.current)}>
          <span className={s.word} aria-live="polite">
            {copied === way.id ? 'Copied' : 'Copy'}
          </span>
        </button>
      </div>
      <p className={s.embedNote}>{way.note}</p>
    </div>
  );
}
