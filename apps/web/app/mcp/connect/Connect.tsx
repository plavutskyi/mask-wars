'use client';

import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import s from './connect.module.css';

interface Way {
  id: string;
  label: string;
  /** What the button copies. */
  text: string;
  /** Shown before the text: a shell prompt for a command, nothing for a bare URL. */
  prompt: boolean;
}

function waysTo(endpoint: string): Way[] {
  return [
    { id: 'claude', label: 'Claude Code', text: `claude mcp add --transport http maskwars ${endpoint}`, prompt: true },
    { id: 'codex', label: 'Codex', text: `codex mcp add maskwars --url ${endpoint}`, prompt: true },
    { id: 'any', label: 'Any client', text: endpoint, prompt: false },
  ];
}

/** One command per client and one button that copies it. */
export function Connect({ endpoint }: { endpoint: string }) {
  const ways = waysTo(endpoint);
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const code = useRef<HTMLElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const way = ways[active]!;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  function pick(i: number) {
    setActive(i);
    setCopied(false);
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (active + step + ways.length) % ways.length;
    pick(next);
    tabs.current[next]?.focus();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(way.text);
      setCopied(true);
    } catch {
      // No clipboard (an insecure page, a locked-down browser): select the command so one keystroke copies it.
      const node = code.current?.querySelector('[data-text]');
      const sel = window.getSelection();
      if (node && sel) {
        const range = document.createRange();
        range.selectNodeContents(node);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  return (
    <div className={s.way}>
      <div className={s.tabs} role="tablist" aria-label="Your agent">
        {ways.map((w, i) => (
          <button
            key={w.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${w.id}`}
            aria-selected={i === active}
            aria-controls="connect-way"
            tabIndex={i === active ? 0 : -1}
            className={`${s.tab} ${s.word}`}
            onClick={() => pick(i)}
            onKeyDown={onTabKey}
          >
            {w.label}
          </button>
        ))}
      </div>
      <div id="connect-way" role="tabpanel" aria-labelledby={`tab-${way.id}`} className={s.way}>
        <code ref={code} className={s.cmd}>
          {way.prompt && (
            <span className={s.prompt} aria-hidden>
              ${' '}
            </span>
          )}
          <span data-text>{way.text}</span>
        </code>
        <button type="button" className={s.btn} onClick={copy}>
          <span className={s.word} aria-live="polite">
            {copied ? 'Copied' : 'Copy'}
          </span>
        </button>
      </div>
    </div>
  );
}
