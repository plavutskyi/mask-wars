import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nearCatalogOf, type Token } from '@maskwars/pay';
import type { NearQuoteView } from '@maskwars/pay';
import {
  accountBad,
  accountReady,
  accountText,
  etaText,
  feeSplit,
  mmss,
  NearError,
  OWN,
  percentText,
  priceText,
  type PendingNear,
  problemText,
  searchCoins,
  shortRest,
  shortText,
  startReceiver,
} from './flow';

// The words and choices of /near, on the token list 1Click answered with on 2026-11-11.
const tokens = JSON.parse(readFileSync(new URL('../../../../packages/pay/test/fixtures/tokens.json', import.meta.url), 'utf8')).tokens as Token[];
const chains = nearCatalogOf(tokens)!.chains;

describe('the coin picker', () => {
  it('opens on where people’s money usually sits, USDT on Arbitrum first', () => {
    const top = searchCoins(chains, '', null).map((x) => `${x.coin.symbol}·${x.chain.id}`);
    expect(top.slice(0, 4)).toEqual(['USDT·arb', 'USDT·tron', 'USDC·sol', 'USDC·base']);
    expect(top).toContain('BTC·btc');
  });

  it('finds a coin by symbol first, a network by name, and Tether’s USD₮0 as USDT', () => {
    const usdt = searchCoins(chains, 'usdt', null);
    expect(usdt.map((x) => x.chain.id)).toEqual(['eth', 'tron', 'arb', 'sol', 'bsc', 'pol', 'op', 'avax', 'ton', 'aptos']);
    expect(usdt.every((x) => x.coin.symbol === 'USDT')).toBe(true);
    // USD₮0 is USDT on Arbitrum, Polygon and Optimism: `usdt0` finds exactly those, `tether` every USDT.
    expect(searchCoins(chains, 'usdt0', null).map((x) => `${x.coin.symbol}·${x.chain.id}`)).toEqual(['USDT·arb', 'USDT·pol', 'USDT·op']);
    expect(searchCoins(chains, 'tether', null).filter((x) => x.coin.symbol === 'USDT')).toHaveLength(10);
    expect(searchCoins(chains, 'tron', null).map((x) => x.coin.symbol)).toEqual(['USDT', 'TRX']);
    expect(searchCoins(chains, 'sol', null)[0]!.coin.symbol).toBe('SOL');
    expect(searchCoins(chains, 'zzzz', null)).toEqual([]);
    // Several words narrow, and a token goes by its network's standard too.
    expect(searchCoins(chains, 'usdt tron', null).map((x) => `${x.coin.symbol}·${x.chain.id}`)).toEqual(['USDT·tron']);
    expect(searchCoins(chains, 'usdt arbitrum', null).map((x) => `${x.coin.symbol}·${x.chain.id}`)).toEqual(['USDT·arb']);
    expect(searchCoins(chains, 'trc20', null).map((x) => `${x.coin.symbol}·${x.chain.id}`)).toEqual(['USDT·tron']);
    expect(searchCoins(chains, 'erc-20', null).every((x) => x.chain.id === 'eth' && !x.coin.native)).toBe(true);
    expect(searchCoins(chains, 'erc20', null).length).toBeGreaterThan(3);
    // The network's own coin by its name comes before every wrapped one.
    expect(searchCoins(chains, 'bitcoin', null)[0]).toMatchObject({ chain: { id: 'btc' }, coin: { symbol: 'BTC' } });
  });

  it('finds ether by its symbol without every Tether, and Gram as Toncoin', () => {
    const eth = searchCoins(chains, 'eth', null);
    expect(eth.slice(0, 4).map((x) => `${x.coin.symbol}·${x.chain.id}`)).toEqual(['ETH·eth', 'ETH·arb', 'ETH·base', 'ETH·op']);
    expect(eth.filter((x) => x.coin.symbol === 'USDT').map((x) => x.chain.id)).toEqual(['eth']);
    expect(searchCoins(chains, 'toncoin', null).map((x) => x.coin.symbol)).toEqual(['GRAM']);
    expect(searchCoins(chains, 'btc', null).map((x) => `${x.coin.symbol}·${x.chain.id}`)).toEqual(['BTC·btc', 'WBTC·eth', 'cbBTC·eth', 'cbBTC·base']);
  });

  it('lists every coin of a picked network, and searches inside it', () => {
    expect(searchCoins(chains, '', 'arb').map((x) => x.coin.symbol)).toEqual(chains.find((c) => c.id === 'arb')!.coins.map((c) => c.symbol));
    expect(searchCoins(chains, 'usdc', 'eth').map((x) => x.coin.symbol)).toEqual(['USDC']);
  });
});

describe('a price in the picker', () => {
  it('never reads in scientific notation', () => {
    expect(priceText(73471)).toBe('$73,471');
    expect(priceText(3.52)).toBe('$3.52');
    expect(priceText(0.149239)).toBe('$0.15');
    expect(priceText(0.03782101)).toBe('$0.0378');
    expect(priceText(4.33e-6)).toBe('$0.00000433');
    expect(priceText(6.243e-9)).toBe('$0.00000000624');
    for (const p of [1e-7, 8.8316e-8, 1.1e-6, 5.366e-5]) expect(priceText(p)).not.toMatch(/e/i);
    expect(priceText(0)).toBe('');
  });
});

describe('the account line', () => {
  it('says what to type, what is wrong, and when it is ready', () => {
    expect(accountText(null)).toBe('Your own NEAR wallet, not an exchange deposit address.');
    expect(accountText({ ok: false, why: 'empty' })).toBe(OWN);
    expect(accountText({ ok: false, why: 'eth' })).toMatch(/Ethereum address/);
    expect(accountText({ ok: false, why: 'testnet' })).toMatch(/testnet/);
    expect(accountText({ ok: true, id: 'maskwars.near', kind: 'named', exists: true })).toBe('On NEAR. Your own wallet, not an exchange.');
    expect(accountText({ ok: true, id: 'nobody.near', kind: 'named', exists: false })).toBe('No such account on NEAR.');
    expect(accountText({ ok: true, id: 'ab'.repeat(32), kind: 'implicit', exists: false })).toBe('New account: the NEAR opens it. Your own wallet only.');
  });

  it('is ready for a name on NEAR or any implicit address, and wrong for a missing name', () => {
    expect(accountReady({ ok: true, id: 'a.near', kind: 'named', exists: true })).toBe(true);
    expect(accountReady({ ok: true, id: 'a.near', kind: 'named', exists: null })).toBe(false);
    expect(accountReady({ ok: true, id: 'ab'.repeat(32), kind: 'implicit', exists: null })).toBe(true);
    expect(accountBad({ ok: true, id: 'a.near', kind: 'named', exists: false })).toBe(true);
    expect(accountBad({ ok: false, why: 'empty' })).toBe(false);
    expect(accountBad(null)).toBe(false);
  });
});

describe('who receives, when a link names someone', () => {
  it('keeps the account this browser used over the one a link names', () => {
    expect(startReceiver({ saved: 'mine.near', link: 'scam.near' })).toEqual({ text: 'mine.near', fromLink: false });
  });

  it('takes a link’s account only marked as from the link, to be confirmed', () => {
    expect(startReceiver({ saved: null, link: ' friend.near ' })).toEqual({ text: 'friend.near', fromLink: true });
    expect(startReceiver({ saved: '', link: 'x'.repeat(90) }).text).toHaveLength(64);
    expect(startReceiver({})).toEqual({ text: '', fromLink: false });
  });
});

describe('a deposit that came in short', () => {
  const pending: PendingNear = {
    recipient: 'maskwars.near',
    chain: { id: 'arb', name: 'Arbitrum' },
    coin: { assetId: 'nep141:arb-usdt', symbol: 'USDT', decimals: 6, price: 1, contract: null },
    usd: 10,
    quote: { amountIn: '10000000', minAmountIn: '9900000', deadline: '2026-11-11T22:00:00.000Z' } as NearQuoteView,
  };
  const clock = () => '22:00';

  it('says how much more to send, and by when, to the same address', () => {
    // Binance took its 0.20 USDT fee out of the 10: 9.80 arrived against a 9.90 minimum.
    const t = shortText({ pending, deposited: '9800000', now: Date.parse('2026-11-11T21:30:00.000Z'), clock });
    expect(t).toBe('9.8 USDT arrived, less than the swap needs. Send 0.2 USDT more by 22:00, or it goes to maskwars.near inside NEAR Intents.');
    // Up to the amount quoted, not just the minimum: one more transfer of exactly this clears it.
    expect(shortRest(pending, '9800000')).toBe(200_000n);
    expect(shortRest(pending, null)).toBeNull();
  });

  it('gives no number while 1Click has not said how much came, so the whole amount is never asked twice', () => {
    const t = shortText({ pending, deposited: null, now: Date.parse('2026-11-11T21:30:00.000Z'), clock });
    expect(t).toBe('Part of the USDT arrived, less than the swap needs. How much is not known yet: wait a moment before sending more. After 22:00 what came goes to maskwars.near inside NEAR Intents.');
    expect(t).not.toMatch(/Send \d|the rest more/);
  });

  it('after the deadline says where what came goes, never "for you"', () => {
    const t = shortText({ pending, deposited: '9800000', now: Date.parse('2026-11-11T22:00:01.000Z'), clock });
    expect(t).toBe('Time is up. 9.8 USDT goes to maskwars.near inside NEAR Intents.');
    expect(t).not.toMatch(/for you/);
  });
});

describe('the words for a failure', () => {
  it('names the least a route takes, and a paused network by name', () => {
    expect(problemText(new NearError('small', 422, { min: 100 }), 'Tron', 100)).toBe('Tron takes $100 or more right now.');
    expect(problemText(new NearError('small', 422, { min: 1000 }), 'BNB Chain', 100)).toBe('BNB Chain takes $1,000 or more right now. Pick another network.');
    expect(problemText(new NearError('route', 422), 'BNB Chain', 100)).toBe('BNB Chain is paused right now. Pick another network.');
    expect(problemText(new NearError('account', 422, { why: 'missing' }), 'Arbitrum', 100)).toBe('No such account on NEAR.');
    expect(problemText(new Error('boom'), 'Arbitrum', 100)).toBe('That did not work. Try again.');
  });
});

describe('numbers', () => {
  it('reads fees, times and countdowns', () => {
    expect(feeSplit([{ recipient: 'maskwars.near', fee: 13 }, { recipient: '5880ad2b', fee: 20 }], 'maskwars.near')).toEqual({ ours: 13, intents: 20 });
    expect(percentText(33)).toBe('0.33%');
    expect(percentText(20)).toBe('0.2%');
    expect(etaText(25)).toBe('~25 s');
    expect(etaText(805)).toBe('~13 min');
    expect(mmss(59 * 60_000 + 41_000)).toBe('59:41');
    expect(mmss(3_600_000)).toBe('1:00:00');
  });
});
