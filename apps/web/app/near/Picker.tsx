'use client';

import type { NearChain, NearCoin } from '@maskwars/pay';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChainMark, CoinMark, TokenFacts } from './CoinMark';
import { priceText, searchCoins } from './flow';
import s from './near.module.css';

/**
 * The coin picker: one search for coin or network, the networks down the side (across the top on a phone), and the
 * coins. With nothing typed and no network picked it opens on where people's money usually sits.
 */
export function Picker(p: {
  chains: readonly NearChain[];
  current: string | null;
  onPick: (assetId: string) => void;
  onClose: () => void;
  /** What the picker is for: "Pay with" on Get NEAR, "You pay" and "You receive" on Swap. */
  title?: string;
  /** The coins shown before anything is typed. */
  popular?: readonly (readonly [string, string])[];
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [chainId, setChainId] = useState<string | null>(null);
  /** The coin whose contract is open under its row. */
  const [facts, setFacts] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => searchCoins(p.chains, text, chainId, p.popular), [p.chains, text, chainId, p.popular]);
  const { onClose } = p;

  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    // A phone's keyboard would cover half the list: the search takes focus only where there is a pointer.
    if (window.matchMedia('(pointer: fine)').matches) search.current?.focus();
    else box.current?.querySelector<HTMLElement>('[data-close]')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !box.current) return;
      const all = [...box.current.querySelectorAll<HTMLElement>('button, input, a[href]')].filter((el) => !el.hasAttribute('disabled'));
      const first = all[0];
      const last = all.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      root.style.overflow = before;
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const heading = chainId ? (p.chains.find((c) => c.id === chainId)?.name ?? '') : text.trim() ? 'Results' : 'Popular';

  return createPortal(
    <div className={s.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={s.picker} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <div className={s.pickHead}>
          <span className={`${s.word} ${s.label}`} id={`${id}-title`}>
            {p.title ?? 'Pay with'}
          </span>
          <span className={s.grow} />
          <button type="button" className={s.close} data-close aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <label className={s.search}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" strokeLinecap="square" />
          </svg>
          <input
            ref={search}
            className={s.searchInput}
            value={text}
            placeholder="Coin or network"
            aria-label="Search a coin or network"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className={s.pickBody}>
          <nav className={s.nets} aria-label="Networks">
            <button type="button" className={s.net} aria-pressed={chainId === null} onClick={() => setChainId(null)}>
              <span className={s.netAll} aria-hidden>
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                  <rect x="1" y="1" width="6" height="6" />
                  <rect x="9" y="1" width="6" height="6" />
                  <rect x="1" y="9" width="6" height="6" />
                  <rect x="9" y="9" width="6" height="6" />
                </svg>
              </span>
              All
              <span className={s.netCount}>{p.chains.length}</span>
            </button>
            {p.chains.map((c) => (
              <button key={c.id} type="button" className={s.net} aria-pressed={chainId === c.id} onClick={() => setChainId(c.id)}>
                <ChainMark id={c.id} />
                {c.name}
              </button>
            ))}
          </nav>
          <div className={s.coins}>
            <p className={s.coinsHead} aria-live="polite">
              {heading}
            </p>
            {rows.length ? (
              <ul className={s.coinList}>
                {rows.map(({ chain, coin }) => (
                  <CoinRow
                    key={coin.assetId}
                    id={`${id}-${coin.assetId}`}
                    chain={chain}
                    coin={coin}
                    current={coin.assetId === p.current}
                    open={facts === coin.assetId}
                    onPick={() => p.onPick(coin.assetId)}
                    onFacts={() => setFacts((f) => (f === coin.assetId ? null : coin.assetId))}
                  />
                ))}
              </ul>
            ) : (
              <p className={s.empty}>Nothing by that name. Try a symbol like USDT, or a network like Tron.</p>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CoinRow(p: { id: string; chain: NearChain; coin: NearCoin; current: boolean; open: boolean; onPick: () => void; onFacts: () => void }) {
  const second = [p.chain.name, p.coin.note].filter(Boolean).join(' · ');
  return (
    <li className={s.coinItem} data-open={p.open ? '' : undefined}>
      <button type="button" className={s.coinRow} aria-current={p.current ? 'true' : undefined} onClick={p.onPick}>
        <CoinMark coin={p.coin} chain={p.chain} />
        <span className={s.coinName}>
          <b>{p.coin.symbol}</b>
          <span>{second}</span>
        </span>
        <span className={s.coinPrice}>{priceText(p.coin.price)}</span>
      </button>
      <button
        type="button"
        className={`${s.info} ${s.coinInfo}`}
        aria-expanded={p.open}
        aria-controls={`${p.id}-facts`}
        aria-label={`About ${p.coin.symbol} on ${p.chain.name}`}
        onClick={p.onFacts}
      >
        i
      </button>
      {p.open ? (
        <div className={s.coinFacts} id={`${p.id}-facts`}>
          <TokenFacts coin={p.coin} chain={p.chain} />
        </div>
      ) : null}
    </li>
  );
}
