import { describe, expect, it } from 'vitest';
// @vitest-environment happy-dom
import { addressText, amountText, amountUnits, clearPendingSwap, heroAmount, rateText, refundText, swapShortText } from './flow';

const usdt = { symbol: 'USDT', price: 0.99923, decimals: 6, assetId: 'u', contract: null };
const sol = { symbol: 'SOL', price: 84.87, decimals: 9, assetId: 's', contract: null };
const meme = { symbol: 'BLACKDRAGON', price: 6.787e-9, decimals: 24, assetId: 'b', contract: null };

describe('amounts', () => {
  it('reads what a person types in the coin’s units, and nothing that is not an amount', () => {
    expect(amountUnits('25', usdt)).toBe(25_000_000n);
    expect(amountUnits('0.5', sol)).toBe(500_000_000n);
    expect(amountUnits('0', usdt)).toBeNull();
    expect(amountUnits('1.0000001', usdt)).toBeNull();
    expect(amountUnits('', usdt)).toBeNull();
  });

  it('keeps the dollars when the coin changes: whole cents for a stablecoin, four significant digits for the rest', () => {
    expect(amountText(24.97943, usdt)).toBe('24.98');
    expect(amountText(25, sol)).toBe('0.2946');
    expect(amountText(25, meme)).toBe('3684000000');
  });

  it('puts a meme coin’s billions on one line, never rounding up', () => {
    expect(heroAmount(3_683_557_422_150_000_000_000_000_000_000_000n, 24)).toBe('3.68B');
    expect(heroAmount(12_409_000n * 10n ** 18n, 18)).toBe('12.40M');
    expect(heroAmount(36_835_900_000_000_000_000_000n, 18)).toBe('36,835');
    expect(heroAmount(293_400_000n, 9)).toBe('0.2934');
    expect(heroAmount(24_910_000n, 6)).toBe('24.91');
  });

  it('gives the rate in the coin out per one coin in', () => {
    expect(rateText({ amountIn: '25000000', amountOut: '293400000' }, usdt as never, sol as never)).toBe('1 USDT ≈ 0.01174 SOL');
    expect(rateText({ amountIn: '293400000', amountOut: '25000000' }, sol as never, usdt as never)).toBe('1 SOL ≈ 85.2079 USDT');
  });
});

describe('words', () => {
  const arb = { id: 'arb', name: 'Arbitrum' };
  const ton = { id: 'ton', name: 'TON' };

  it('names a refused address for what it is, on the network it is for', () => {
    expect(addressText('other', { id: 'sol', name: 'Solana' }, 'an Ethereum')).toBe('That is an Ethereum address. This needs one on Solana.');
    expect(addressText('bad', arb)).toBe('That is not an address on Arbitrum.');
    expect(addressText('empty', arb, null, 'refund')).toBe('Your own Arbitrum address, not an exchange.');
    expect(addressText('empty', ton, null, 'refund')).toBe('Your NEAR account. A refund waits for it inside NEAR Intents.');
    expect(addressText('other', ton, 'a TON', 'refund')).toBe('That is a TON address. This needs one on NEAR.');
  });

  it('says where a refund goes by name, never as "you"', () => {
    expect(refundText({ to: 'kira.near', type: 'INTENTS' }, arb)).toBe('kira.near inside NEAR Intents');
    expect(refundText({ to: '0x71c7656ec7ab88b098defb751b7401b5f6d8976f', type: 'ORIGIN_CHAIN' }, arb)).toBe('0x71c7…976f on Arbitrum');
    expect(refundText({ to: '0x71c7656ec7ab88b098defb751b7401b5f6d8976f', type: 'ORIGIN_CHAIN' }, arb, '0x71c7656ec7ab88b098defb751b7401b5f6d8976f')).toBe('the paying wallet, 0x71c7…976f on Arbitrum');
  });
});

describe('the swap this browser remembers', () => {
  it('is forgotten only by the tab that follows it: a swap another tab opened since stays', () => {
    localStorage.setItem('maskwars:swap', JSON.stringify({ quote: { depositAddress: '0xbbbb' } }));
    clearPendingSwap('0xaaaa');
    expect(localStorage.getItem('maskwars:swap')).not.toBeNull();
    clearPendingSwap('0xbbbb');
    expect(localStorage.getItem('maskwars:swap')).toBeNull();
  });
});

describe('a deposit that came in short', () => {
  const pending = {
    from: { chain: { id: 'arb', name: 'Arbitrum' }, coin: { ...usdt, assetId: 'u' } },
    quote: { amountIn: '25000000', minAmountIn: '24750000', deadline: '2026-11-13T22:00:00.000Z' },
    refund: { to: '0x71c7656ec7ab88b098defb751b7401b5f6d8976f', type: 'ORIGIN_CHAIN' as const },
    payment: { by: 'address' as const },
  } as never;
  const clock = () => '22:00';
  const before = Date.parse('2026-11-13T21:00:00.000Z');

  it('names the rest, or no number at all while 1Click has not said how much came, and where it goes after', () => {
    expect(swapShortText({ pending, deposited: '24500000', now: before, clock })).toBe(
      '24.5 USDT arrived, less than the swap needs. Send 0.5 USDT more by 22:00, or what came goes back to 0x71c7…976f on Arbitrum.',
    );
    expect(swapShortText({ pending, deposited: null, now: before, clock })).toBe(
      'Part of the USDT arrived, less than the swap needs. How much is not known yet: wait a moment before sending more. After 22:00 what came goes back to 0x71c7…976f on Arbitrum.',
    );
    expect(swapShortText({ pending, deposited: '24500000', now: Date.parse('2026-11-13T22:00:01.000Z'), clock })).toBe('Time is up. 24.5 USDT goes back to 0x71c7…976f on Arbitrum.');
  });
});
