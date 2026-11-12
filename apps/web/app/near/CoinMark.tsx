'use client';

import { listedOf, ownCoinHere, tokenLink, type NearCoin } from '@maskwars/pay';
import { useState } from 'react';
import { shortId } from './flow';
import { CopyGlyph, useCopy } from './parts';
import s from './near.module.css';

type Coin = Pick<NearCoin, 'symbol' | 'logo' | 'native'> & { readonly assetId?: string };
type Chain = { readonly id: string; readonly name: string };

/**
 * A coin with its name, logo and native flag: a swap this browser saved before they existed has none, so they come
 * from the list by asset id. A coin no longer listed keeps what it has.
 */
function filled<T extends { readonly assetId?: string; readonly logo?: string }>(coin: T): T & Partial<Pick<NearCoin, 'name' | 'note' | 'native'>> {
  if (coin.logo || !coin.assetId) return coin;
  const l = listedOf(coin.assetId);
  return l ? { ...coin, name: l.name, ...(l.note ? { note: l.note } : {}), logo: l.logo, native: l.native === true || l.contract === null } : coin;
}

/**
 * A coin's own logo with its network's logo at the corner, so USDT on Arbitrum never looks like USDT on Tron. A network's
 * own coin on its own network (ETH on Ethereum, NEAR on NEAR) carries no badge. Logos are local files (public/coins,
 * public/chains); a swap a browser remembers from before them shows the symbol's first letter instead.
 */
export function CoinMark({ coin: given, chain, size = 36, badge = true }: { coin: Coin; chain: Chain; size?: number; badge?: boolean }) {
  const [broken, setBroken] = useState(false);
  const coin = filled(given);
  const corner = badge && !ownCoinHere(chain.id, coin);
  const dot = Math.round(size * 0.44);
  // The size is a CSS variable, so a place like the hero can size the mark with its text (`--mark: 1.1em`).
  return (
    <span className={s.mark} style={{ ['--mark' as string]: `${size}px` }} aria-hidden>
      {coin.logo && !broken ? (
        <img className={s.markCoin} src={`/coins/${coin.logo}`} alt="" width={size} height={size} decoding="async" draggable={false} onError={() => setBroken(true)} />
      ) : (
        <span className={s.markCoin} data-letter="">
          {coin.symbol.slice(0, 1)}
        </span>
      )}
      {corner ? <img className={s.markChain} src={`/chains/${chain.id}.svg`} alt="" width={dot} height={dot} decoding="async" draggable={false} /> : null}
    </span>
  );
}

/** `Send only USDT on Arbitrum`, or `More, only USDT on Arbitrum` after a short deposit: under the amount to send. */
export const sendOnlyText = (coin: Pick<NearCoin, 'symbol'>, chain: Chain, more = false) => `${more ? 'More, only' : 'Send only'} ${coin.symbol} on ${chain.name}`;

/** The contract of the coin to send, on the network's explorer, under the deposit address: the exact token, one tap away. */
export function ContractLink({ coin: given, chain }: { coin: Pick<NearCoin, 'symbol' | 'contract' | 'native'> & { readonly assetId?: string; readonly logo?: string }; chain: Chain }) {
  const coin = filled(given);
  const link = coin.native ? null : tokenLink(chain.id, coin.contract);
  if (!link || !coin.contract) return null;
  return (
    <a className={s.sendCoinLink} href={link.href} target="_blank" rel="noopener noreferrer" aria-label={`${coin.symbol} contract ${coin.contract}, view on ${link.name}`}>
      <span className={s.sendCoinWhat}>Token contract</span>
      <span>View on {link.name}</span>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M6 3.5h6.5V10M12.5 3.5 4 12" />
      </svg>
    </a>
  );
}

/** A network's own logo, for the network rail. */
export function ChainMark({ id, size = 22 }: { id: string; size?: number }) {
  return <img className={s.chainMark} src={`/chains/${id}.svg`} alt="" width={size} height={size} decoding="async" draggable={false} aria-hidden />;
}

/** `Tether USD · USD₮0`: the coin in full, with what its quiet second line adds (never `Tether` twice). */
export function coinFullName(coin: Pick<NearCoin, 'symbol' | 'name' | 'note'>): string {
  const name = coin.name ?? coin.symbol;
  const more = (coin.note ?? '').split(' · ').filter((part) => part && !name.toLowerCase().includes(part.toLowerCase()));
  return [name, ...more].join(' · ');
}

/**
 * Which coin it is, exactly: the full name, the network, and the contract, shortened in the middle, with a copy button and
 * the token's page on the network's explorer. A network's own coin has no contract to open.
 */
export function TokenFacts({
  coin: given,
  chain,
  compact = false,
  withSymbol = false,
  copyable = true,
}: {
  coin: Pick<NearCoin, 'symbol' | 'name' | 'note' | 'contract' | 'native'> & { readonly assetId?: string; readonly logo?: string };
  chain: Chain;
  /** Only the contract line, for a card that already names the coin. */
  compact?: boolean;
  /** The symbol before the name, for a list that does not show it elsewhere. */
  withSymbol?: boolean;
  /** Off beside a deposit address: there the only thing to copy is the address to pay, never the token's contract. */
  copyable?: boolean;
}) {
  const [copied, copy] = useCopy();
  const coin = filled(given);
  const link = coin.native ? null : tokenLink(chain.id, coin.contract);
  return (
    <span className={s.facts} data-compact={compact ? '' : undefined}>
      {compact ? null : (
        <span className={s.factsName}>
          {withSymbol ? `${coin.symbol} · ` : ''}
          {coinFullName(coin)} <span className={s.factsOn}>on {chain.name}</span>
        </span>
      )}
      {coin.native || !coin.contract ? (
        <span className={s.factsNative}>Native coin of {chain.name}</span>
      ) : (
        <span className={s.factsRow}>
          {copyable ? (
            <button type="button" className={s.factsCopy} onClick={() => copy('contract', coin.contract!)} aria-label={`Copy the ${coin.symbol} contract on ${chain.name}, ${coin.contract}`} title={coin.contract}>
              <span className={s.factsId}>{copied === 'contract' ? 'Copied' : shortId(coin.contract)}</span>
              <CopyGlyph />
            </button>
          ) : (
            <span className={s.factsNative}>Token contract</span>
          )}
          {link ? (
            <a className={s.factsLink} href={link.href} target="_blank" rel="noopener noreferrer">
              View on {link.name}
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <path d="M6 3.5h6.5V10M12.5 3.5 4 12" />
              </svg>
            </a>
          ) : null}
        </span>
      )}
    </span>
  );
}
