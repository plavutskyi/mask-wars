import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passing, PayError, surelyRefused, type QuoteView } from './api';
import { catalogDelay, settleOf } from './settle';
import { loadKnown, loadPendingOut, rememberKnown, savePendingOut, type PendingCashOut } from './store';

const VAULT = '0x3602b546589a8fcafdce7fad64a46f91db0e4d50';
const T = Date.parse('2026-11-08T12:00:00Z');
const job = { stage: null, now: T, until: T + 60_000, before: '3000', units: '3000' } as const;

describe('a cash-out being followed', () => {
  it('ends when 1Click says how it ended, whatever the clock', () => {
    expect(settleOf({ ...job, stage: 'done' })).toBe('done');
    expect(settleOf({ ...job, stage: 'refunded' })).toBe('back');
    expect(settleOf({ ...job, stage: 'short' })).toBe('back');
    expect(settleOf({ ...job, stage: 'failed' })).toBe('failed');
  });

  it('is followed while its intent may still move money, never longer', () => {
    for (const stage of [null, 'waiting', 'seen', 'moving'] as const) expect(settleOf({ ...job, stage })).toBeNull();
    const after = { ...job, now: job.until };
    expect(settleOf({ ...after, stage: 'waiting' })).toBe('none');
    expect(settleOf({ ...after, stage: 'moving' })).toBe('away');
    expect(settleOf({ ...after, stage: 'seen' })).toBe('away');
  });

  it('asks the vault when 1Click is silent once the intent ran out: the coin still there means nothing went out', () => {
    const after = { ...job, now: job.until + 1 };
    expect(settleOf(after)).toBe('unknown');
    expect(settleOf({ ...after, held: () => null })).toBe('unknown');
    expect(settleOf({ ...after, held: () => '3000' })).toBe('none');
    expect(settleOf({ ...after, held: () => '0' })).toBe('away');
    // «All»: the vault no longer lists the coin at all.
    expect(settleOf({ ...after, before: '3000', units: '3000', held: () => '0' })).toBe('away');
    expect(settleOf({ ...after, before: '5000', units: '3000', held: () => '2000' })).toBe('away');
  });
});

describe('a failure on the way to 1Click', () => {
  it('is a sure no only when this site or 1Click refused it', () => {
    expect(surelyRefused(new PayError('signature', 422))).toBe(true);
    expect(surelyRefused(new PayError('route', 422))).toBe(true);
    expect(surelyRefused(new PayError('busy', 429))).toBe(true);
    expect(surelyRefused(new PayError('bad', 403))).toBe(true);
    // A timeout, an outage or a lost answer: it may have gone through.
    expect(surelyRefused(new PayError('busy', 503))).toBe(false);
    expect(surelyRefused(new PayError('offline', 504))).toBe(false);
    expect(surelyRefused(new PayError('offline', 0))).toBe(false);
    expect(surelyRefused(new Error('x'))).toBe(false);
  });

  it('does not stand in the way of the real quote when only a preview was busy', () => {
    expect(passing(new PayError('busy', 429))).toBe(true);
    expect(passing(new PayError('offline', 0))).toBe(true);
    expect(passing(new PayError('small', 422))).toBe(false);
    expect(passing(new PayError('route', 422))).toBe(false);
  });
});

describe('the coins on offer', () => {
  it('are asked again with a growing pause, then the page says so and offers a retry', () => {
    expect([0, 1, 2, 3, 4].map(catalogDelay)).toEqual([1500, 3000, 6000, 12000, null]);
  });
});

describe('what this browser remembers', () => {
  const memory = new Map<string, string>();
  beforeEach(() => {
    memory.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const pending = (over: Partial<PendingCashOut> = {}): PendingCashOut => ({
    account: VAULT,
    deal: { depositAddress: 'f562a8388155164f4221534b2087010e49af1319fbcd29f0bdc33621d46b538e' } as QuoteView,
    from: { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, chain: 'near', price: 3.7, units: '3000', usd: 11 },
    chain: { id: 'base', name: 'Base' },
    coin: { assetId: 'nep141:base-usdc', symbol: 'USDC', decimals: 6, chain: 'base', price: 1 },
    recipient: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    units: '3000',
    seen: '11000000',
    sent: 'unsure',
    until: Date.now() + 15 * 60_000,
    ...over,
  });

  it('keeps a cash-out that may still go through, for this vault only, across reloads', () => {
    savePendingOut(pending());
    expect(loadPendingOut(VAULT)).toMatchObject({ sent: 'unsure', recipient: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F' });
    expect(loadPendingOut('maskfan.near')).toBeNull();
    savePendingOut(null);
    expect(loadPendingOut(VAULT)).toBeNull();
  });

  it('lets go of one a day after it could last move money', () => {
    savePendingOut(pending({ until: Date.now() - 25 * 3600_000 }));
    expect(loadPendingOut(VAULT)).toBeNull();
    expect(memory.has('maskwars:cashout')).toBe(false);
  });

  it('remembers vault passkeys, newest first, so the same authenticator never makes a second vault', () => {
    rememberKnown('AAAAAAAAAAAAAAAAAAAAAA');
    rememberKnown('BBBBBBBBBBBBBBBBBBBBBB');
    rememberKnown('AAAAAAAAAAAAAAAAAAAAAA');
    expect(loadKnown()).toEqual(['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB']);
    memory.set('maskwars:passkeys', JSON.stringify(['ok_id_0123456789abcdef', 'not an id', 7]));
    expect(loadKnown()).toEqual(['ok_id_0123456789abcdef']);
  });
});
