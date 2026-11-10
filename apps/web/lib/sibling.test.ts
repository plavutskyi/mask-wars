import { describe, expect, it, vi } from 'vitest';
import { siblingReader } from './sibling';

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const AT_18 = Date.UTC(2026, 10, 10, 18, 0, 0);
const answer = (next: unknown) => async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ next });

describe('the time of the other network’s next round', () => {
  it('is what the other site’s /api/races says, for a round its treasury can open', async () => {
    const fetch = vi.fn(answer({ at: AT_18, funded: true }));
    const r = siblingReader({ origin: 'https://testnet.maskwars.xyz', fetch });
    expect(await r.nextRound(NOW)).toBe(AT_18);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://testnet.maskwars.xyz/api/races');
  });

  it('is nothing for a round the treasury cannot open, a round already due, one more than a day away, or no season', async () => {
    for (const next of [{ at: AT_18, funded: false }, { at: NOW - 60_000, funded: true }, { at: NOW + 25 * 3_600_000, funded: true }, null, { funded: true }]) {
      const r = siblingReader({ origin: 'https://testnet.maskwars.xyz', fetch: answer(next) });
      expect(await r.nextRound(NOW), JSON.stringify(next)).toBeNull();
    }
  });

  it('asks the other site once a minute, however many visitors come', async () => {
    const fetch = vi.fn(answer({ at: AT_18, funded: true }));
    const r = siblingReader({ origin: 'https://testnet.maskwars.xyz', fetch });
    await r.nextRound(NOW);
    await r.nextRound(NOW + 5_000);
    await r.nextRound(NOW + 59_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await r.nextRound(NOW + 61_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives no time when the other site does not answer, and does not hold the page for it', async () => {
    const down = siblingReader({ origin: 'https://testnet.maskwars.xyz', fetch: async () => new Response('no', { status: 503 }) });
    expect(await down.nextRound(NOW)).toBeNull();
    const slow = siblingReader({ origin: 'https://testnet.maskwars.xyz', fetch: () => new Promise<Response>(() => {}), waitMs: 20 });
    const started = Date.now();
    expect(await slow.nextRound(NOW)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('keeps the last time for ten minutes while the other site is down, then drops it', async () => {
    let up = true;
    const fetch = async () => (up ? Response.json({ next: { at: AT_18, funded: true } }) : new Response('no', { status: 503 }));
    const r = siblingReader({ origin: 'https://testnet.maskwars.xyz', fetch });
    expect(await r.nextRound(NOW)).toBe(AT_18);
    up = false;
    // The answer is read in the background: the next visitor sees what came of it.
    await r.nextRound(NOW + 2 * 60_000);
    await new Promise((done) => setTimeout(done, 0));
    expect(await r.nextRound(NOW + 2 * 60_000 + 1)).toBe(AT_18);
    await r.nextRound(NOW + 11 * 60_000);
    await new Promise((done) => setTimeout(done, 0));
    expect(await r.nextRound(NOW + 11 * 60_000 + 1)).toBeNull();
  });

  it('never asks anyone when there is no other site', async () => {
    const fetch = vi.fn(answer(null));
    expect(await siblingReader({ origin: null, fetch }).nextRound(NOW)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
