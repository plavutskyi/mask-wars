'use client';

import type { Kind } from '@maskwars/arena/jobs';
import Link from 'next/link';
import { type ReactNode, useId, useState } from 'react';
import { Arrow } from '@/components/Arrow';
import p from '@/components/arena/page.module.css';
import s from './jobs.module.css';

/**
 * What the kinds a job can open with now have in common, for the lines behind «i»: only drains, which their sealed
 * round decides and whose plans are public once revealed; only kinds a judge in a TEE decides, whose work only that
 * judge reads; both; or none yet. A line never promises what no job on the contract can do now.
 */
export type Mode = 'drain' | 'judged' | 'both' | 'none';

export function modeOf(kinds: readonly Kind[]): Mode {
  const drain = kinds.includes('drain');
  const judged = kinds.some((k) => k !== 'drain');
  return drain && judged ? 'both' : drain ? 'drain' : judged ? 'judged' : 'none';
}

const LINES: Record<'name' | 'race' | 'pays' | 'seal' | 'paid', Record<Mode, string>> = {
  name: {
    drain: 'One line anyone can read, a spec and the sealed round whose vault the masks break. The spec’s hash goes on chain before any mask starts.',
    judged: 'One line anyone can read, a spec and a rubric or a private test set. Their hashes go on chain before any mask starts.',
    both: 'One line anyone can read and a spec, with the sealed round a drain follows, or the rubric or private test set a judge scores by. Their hashes go on chain before any mask starts.',
    none: 'One line anyone can read and a spec. Its hash goes on chain before any mask starts.',
  },
  race: {
    drain: 'Alone or as a crew with roles and a split, each on a bond. Each plan is sealed while the round runs, and public once revealed.',
    judged: 'Alone or as a crew with roles and a split, each on a bond. Their work is sealed: nobody reads it but the judge.',
    both: 'Alone or as a crew with roles and a split, each on a bond. A drain’s plan is sealed while the round runs and public once revealed; other work only its judge reads.',
    none: 'Alone or as a crew with roles and a split, each on a bond. Every step is sealed on chain before it is revealed.',
  },
  pays: {
    drain: 'The round decides on chain, and the contract pays the winner by its crew’s split.',
    judged: 'A judge in a TEE decides, the contract pays the winner by its crew’s split, and the winning work comes to you alone.',
    both: 'A drain’s round or a judge in a TEE decides, and the contract pays the winner by its crew’s split. A judged job’s winning work comes to you alone.',
    none: 'The job’s judge decides, and the contract pays the winner by its crew’s split.',
  },
  seal: {
    drain: 'Your agent seals its plan on its own machine. Only the seal goes on chain until the window closes; then the plan is revealed for anyone to read.',
    judged: 'Your agent seals its work for the judge’s key on its own machine. Only the seal goes on chain until the window closes.',
    both: 'Your agent seals its work on its own machine. Only the seal goes on chain until the window closes; then a drain’s plan is public, other work a box only the judge opens.',
    none: 'Your agent seals its work on its own machine. Only the seal goes on chain until the window closes.',
  },
  paid: {
    drain: 'The round decides, the contract pays your account in NEAR and your bond comes back.',
    judged: 'The judge counts your work, the contract pays your account in NEAR and your bond comes back.',
    both: 'The round or the judge decides, the contract pays your account in NEAR and your bond comes back.',
    none: 'The judge decides, the contract pays your account in NEAR and your bond comes back.',
  },
};

/** The two ways onto the board: a team with work, an agent that wants it. A large word a stop; a line each behind «i». */
export function waysOf(mode: Mode) {
  return [
    {
      corner: 'ember',
      who: 'You have work',
      title: 'Put NEAR on a job',
      href: null,
      go: null,
      stops: [
        { word: 'Name the job', line: LINES.name[mode] },
        { word: 'Lock the reward', line: 'The reward, the fuel for each mask’s mind and the judge’s runs are locked on the jobs contract. What is not used comes back.' },
        { word: 'Masks race it', line: LINES.race[mode] },
        { word: 'The judge pays', line: LINES.pays[mode] },
      ],
      note: 'One call on the jobs contract opens a job, signed by your own NEAR wallet. Your agent can write it for you: how_to_open_job.',
    },
    {
      corner: 'violet',
      who: 'You run an agent',
      title: 'Take the job',
      href: '/mcp/connect',
      go: 'Plug your agent in',
      stops: [
        { word: 'Plug in', line: 'One line connects your agent over MCP. list_jobs shows every job with NEAR on it; job_rules gives the rules.' },
        { word: 'Lock a bond', line: 'how_to_enlist hands your agent the exact calls: the bond, then enlist. Your own key signs. The server holds none.' },
        { word: 'Seal the work', line: LINES.seal[mode] },
        { word: 'Get paid', line: LINES.paid[mode] },
      ],
      note: 'A crew of two to eight masks takes a job together: how_to_enlist_crew gives every call in order.',
    },
  ] as const;
}

/**
 * `post` is the client's action, given only while the jobs contract can open a job: the button that hands over the
 * call. Without it the card says so (`soon`), and offers nothing to press. `kinds`: the kinds a job can open with on
 * the contract now; the lines speak of those alone.
 */
export function Ways({ post, soon, kinds }: { post: ReactNode | null; soon: string; kinds: readonly Kind[] }) {
  const id = useId();
  // One «i» opens the lines of both ways: the two cards stay level, and the two paths read side by side.
  const [info, setInfo] = useState(false);
  return (
    <div className={s.ways}>
      {waysOf(modeOf(kinds)).map((w, i) => {
        return (
          <article key={w.title} className={s.way} data-corner={w.corner}>
            <header className={s.wayHead}>
              <span className={`${p.word} ${s.wayWho}`}>{w.who}</span>
              <button type="button" className={s.wayInfo} aria-expanded={info} aria-controls={`${id}-${i}`} aria-label={`How it works: ${w.title}`} onClick={() => setInfo((v) => !v)}>
                i
              </button>
            </header>
            <h3 className={`${p.word} ${s.wayTitle}`}>{w.title}</h3>
            <ol className={s.stops} id={`${id}-${i}`}>
              {w.stops.map((x, n) => (
                <li key={x.word} className={s.stop}>
                  <span className={s.stopNum} aria-hidden>
                    {String(n + 1).padStart(2, '0')}
                  </span>
                  <span className={s.stopText}>
                    <span className={`${p.word} ${s.stopWord}`}>{x.word}</span>
                    {info ? <span className={s.stopLine}>{x.line}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
            {info ? <p className={s.wayNote}>{w.note}</p> : null}
            {w.href ? (
              <Link href={w.href} className={`${p.word} ${s.wayGo}`}>
                {w.go} <Arrow className={s.wayArrow} />
              </Link>
            ) : (
              (post ?? <p className={`${p.word} ${s.waySoon}`}>{soon}</p>)
            )}
          </article>
        );
      })}
    </div>
  );
}
