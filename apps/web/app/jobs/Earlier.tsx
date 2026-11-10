'use client';

import { type ReactNode, useState } from 'react';
import p from '@/components/arena/page.module.css';
import s from './jobs.module.css';

/**
 * The earlier steps of a job's course, behind one control: the page shows the latest steps, and the whole course is
 * one tap away. The steps are rendered on the server and stay in the page; closed, they take no room.
 */
export function Earlier({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <li className={s.earlier}>
        <button type="button" className={`${p.word} ${s.earlierBtn}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span>{open ? 'Hide the earlier steps' : `Show ${count} earlier ${count === 1 ? 'step' : 'steps'}`}</span>
          <svg className={s.earlierMark} viewBox="0 0 14 8" width="14" height="8" fill="none" aria-hidden>
            <path d="M1 1l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </li>
      {open ? children : null}
    </>
  );
}
