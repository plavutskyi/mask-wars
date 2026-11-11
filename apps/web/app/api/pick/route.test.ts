// POST /api/pick over a reading of the arena: picks go only to the round the chain says is open, only before its
// close (its first seal in the server's own reading; with no seal, the end of its sealing window), only on one of its
// masks or the vault, never over a reading too old to say what happens now; one pick per person and round, the last
// one counting.
import type { ArenaView, NextRace, Race, Who } from '@maskwars/arena';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 18, 4);
const who = (name: string): Who => ({ account: `${name.toLowerCase()}.maskwars.near`, slug: name.toLowerCase(), name, mask: true, model: null });
const ORACLE = who('ORACLE');
const NOVA = who('NOVA');
const r: Race = {
  id: 'race-0002',
  network: 'testnet',
  contract: 'bounty.maskwars.near',
  season: null,
  kind: 'safe',
  phase: 'sealing',
  live: true,
  state: 'open',
  team: 'house.maskwars.near',
  official: true,
  target: 'vault.house.maskwars.near',
  targetCode: null,
  locked: '1',
  bounty: '1',
  inSafe: '1',
  safeFunded: '1',
  minLoot: '1',
  openedAt: T0,
  startsAt: T0 + 45 * MIN,
  deadline: T0 + 240 * MIN,
  sealUntil: T0 + 45 * MIN,
  revealUntil: T0 + 105 * MIN,
  masks: [NOVA, ORACLE],
  winner: null,
  brokeAt: null,
  breakMs: null,
  loot: null,
  payout: null,
  refund: null,
  takes: null,
  prize: '1',
  events: [],
  txs: { open: null, drain: null, payout: null },
  judge: null,
  runId: null,
};

const state = vi.hoisted(() => ({ view: null as ArenaView | null, old: null as number | null, now: 0 }));
vi.mock('@/lib/arena', () => ({
  readArena: async () => state.view,
  asOf: () => state.old,
  pickNow: () => state.now,
}));
const { POST } = await import('./route');
const { forget, pickStore, ROOT, settle } = await import('@/lib/picks');

const KEY = `r.${r.contract}.${r.id}`;
const SEC = 1000;
/** The round's first seal, seven minutes into its sealing window, as the arena reads it from the chain. */
const SEALED = T0 + 7 * MIN;
const sealed: Race = { ...r, events: [{ kind: 'seal', at: SEALED, tx: 'seal-0', who: ORACLE, amount: null, ok: true, seq: 0 }] };
const viewOf = (now: Race, next: NextRace | null = null, races: Race[] = [now]): ArenaView => ({ network: 'testnet', races, now, next, league: [], readAt: T0 });
let ip = 0;
function send(body: unknown, cookie = '', from = `10.0.0.${++ip}`) {
  return POST(
    new Request('https://maskwars.xyz/api/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://maskwars.xyz', 'x-real-ip': from, cookie },
      body: JSON.stringify(body),
    }),
  );
}
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

beforeEach(() => {
  state.view = { network: 'testnet', races: [r], now: r, next: null, league: [], readAt: T0 };
  state.old = null;
  state.now = T0 + 10 * MIN;
  forget();
  // A fresh record for each case.
  (globalThis as { __maskwarsPicks?: unknown }).__maskwarsPicks = undefined;
});

describe('POST /api/pick', () => {
  it('takes a pick on the round that seals now, and remembers the person', async () => {
    const res = await send({ key: KEY, choice: ORACLE.account });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pick: { choice: string } }).pick.choice).toBe(ORACLE.account);
    const set = res.headers.getSetCookie();
    expect(set.some((c) => c.startsWith('mw_who=') && /HttpOnly/.test(c) && /Secure/.test(c))).toBe(true);
    expect(set.some((c) => c.startsWith('mw_picks='))).toBe(true);
  });

  it('refuses a reading too old to say the window is still open', async () => {
    state.old = T0;
    const res = await send({ key: KEY, choice: ORACLE.account });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'old' });
  });

  it('refuses once the sealing window has closed', async () => {
    state.now = T0 + 45 * MIN;
    expect((await send({ key: KEY, choice: ORACLE.account })).status).toBe(409);
  });

  it('takes a pick a second before the round’s first seal, and refuses one a second after it, with the reason', async () => {
    state.now = SEALED - SEC;
    const before = await send({ key: KEY, choice: NOVA.account });
    expect(before.status).toBe(200);
    expect(((await before.json()) as { pick: { at: number } }).pick.at).toBe(SEALED - SEC);

    // The seal is in the server's reading of the arena: the window is shut, with 38 minutes of sealing still to run.
    state.view = viewOf(sealed);
    state.now = SEALED + SEC;
    const after = await send({ key: KEY, choice: ORACLE.account }, cookieOf(before));
    expect(after.status).toBe(409);
    expect(await after.json()).toEqual({ error: 'closed', why: 'seal', at: SEALED });
    expect(after.headers.getSetCookie()).toEqual([]);
    // Nothing was filed, and the pick made in time is the one on record.
    const names = await pickStore().names(`${ROOT}round/${KEY}/`);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain(`~${NOVA.account}~`);
  });

  it('refuses every pick from the first seal on: a newcomer, a change of mind, the mask that sealed, the vault', async () => {
    state.view = viewOf(sealed);
    for (const now of [SEALED, SEALED + SEC, T0 + 44 * MIN]) {
      state.now = now;
      for (const choice of [ORACLE.account, NOVA.account, 'held']) {
        const res = await send({ key: KEY, choice });
        expect(res.status).toBe(409);
        expect(((await res.json()) as { why?: string }).why).toBe('seal');
      }
    }
    expect(await pickStore().names(`${ROOT}round/${KEY}/`)).toEqual([]);
  });

  it('a round with no seal takes picks to the last second of its sealing window, and says no plain reason after', async () => {
    state.now = T0 + 45 * MIN - SEC;
    expect((await send({ key: KEY, choice: 'held' })).status).toBe(200);
    state.now = T0 + 45 * MIN;
    const res = await send({ key: KEY, choice: 'held' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'closed' });
  });

  it('a pick the store took after the first seal, between two readings, is not counted when the round is settled', async () => {
    // The mask sealed at SEALED; the server's reading still showed no seal two seconds later, and took the pick.
    state.now = SEALED - 3 * MIN;
    const early = await send({ key: KEY, choice: NOVA.account });
    state.now = SEALED + 2 * SEC;
    const late = await send({ key: KEY, choice: ORACLE.account });
    expect([early.status, late.status]).toEqual([200, 200]);
    const done: Race = { ...sealed, phase: 'broken', live: false, state: 'paid', winner: ORACLE };
    const board = await settle({ races: [done] }, pickStore(), T0 + 300 * MIN);
    // Only the pick made before the seal is in the round: the one that read the stage is not, right as it was.
    expect(board.rounds).toEqual([{ key: KEY, race: r.id, outcome: ORACLE.account, picks: 1 }]);
    expect(Object.values(board.callers)).toEqual([expect.objectContaining({ calls: 1, right: 0, streak: 0 })]);
  });

  describe('the next round, between rounds', () => {
    const last: Race = { ...r, id: 'race-0001', openedAt: T0 - 24 * 60 * MIN, startsAt: T0 - 24 * 60 * MIN + 45 * MIN, deadline: T0 - 20 * 60 * MIN, sealUntil: T0 - 24 * 60 * MIN + 45 * MIN, revealUntil: T0 - 22 * 60 * MIN, phase: 'held', live: false, state: 'refunded' };
    /** The schedule names the round for T0 − 2 minutes; the chain opens it at T0. */
    const DUE = T0 - 2 * MIN;
    const due: NextRace = { season: 'house.maskwars.near', at: DUE, n: 2, target: 'live-safe', targetCode: 'x', inSafe: '1', locked: '1', prize: '2', minLoot: '1', masks: [NOVA, ORACLE], sealMinutes: 45, hours: 4, funded: true };
    const T_KEY = `t.${DUE}`;

    it('takes a pick before the round opens, files it under the scheduled time, and counts it on the round that opens', async () => {
      state.view = viewOf(last, due);
      state.now = DUE - 3 * 60 * MIN;
      const res = await send({ key: T_KEY, choice: ORACLE.account });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { pick: { key: string } }).pick.key).toBe(T_KEY);
      expect(await pickStore().names(`${ROOT}round/${T_KEY}/`)).toHaveLength(1);
      // The round opens on chain, is sealed, is broken by ORACLE: the pick made hours before is on its record.
      const done: Race = { ...sealed, phase: 'broken', live: false, state: 'paid', winner: ORACLE };
      const board = await settle({ races: [done, last] }, pickStore(), T0 + 300 * MIN);
      expect(board.rounds.find((x) => x.race === r.id)).toEqual({ key: KEY, race: r.id, outcome: ORACLE.account, picks: 1 });
      expect(Object.values(board.callers)).toEqual([expect.objectContaining({ calls: 1, right: 1, streak: 1 })]);
    });

    it('a page still on the scheduled round picks on the round it became, until that round’s first seal', async () => {
      // The round is open on chain, nobody sealed yet; the page has not read again and sends the scheduled time.
      state.view = viewOf(r, null, [r, last]);
      state.now = T0 + MIN;
      const res = await send({ key: T_KEY, choice: NOVA.account });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { pick: { key: string } }).pick.key).toBe(KEY);
      expect(await pickStore().names(`${ROOT}round/${KEY}/`)).toHaveLength(1);
      // After the first seal the same page gets the same no as everyone.
      state.view = viewOf(sealed, null, [sealed, last]);
      state.now = SEALED + SEC;
      const late = await send({ key: T_KEY, choice: ORACLE.account }, cookieOf(res));
      expect(await late.json()).toEqual({ error: 'closed', why: 'seal', at: SEALED });
    });

    it('over a reading too old to say what happens now, takes no pick on the next round either', async () => {
      state.view = viewOf(last, due);
      state.now = DUE - 3 * 60 * MIN;
      state.old = T0 - 4 * 60 * MIN;
      const res = await send({ key: T_KEY, choice: ORACLE.account });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'old' });
      expect(await pickStore().names(`${ROOT}round/${T_KEY}/`)).toEqual([]);
    });
  });

  it('refuses a reading too old to say the window is still open, sealed or not', async () => {
    state.old = T0;
    for (const now of [r, sealed]) {
      state.view = viewOf(now);
      const res = await send({ key: KEY, choice: ORACLE.account });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'old' });
    }
  });

  it('refuses a round the chain does not say is open, and a choice that is not in it', async () => {
    const moved = await send({ key: 't.1794335495048', choice: ORACLE.account });
    expect(await moved.json()).toEqual({ error: 'moved', key: KEY });
    expect((await send({ key: KEY, choice: 'kira.masks.maskwars.near' })).status).toBe(400);
    expect((await send({ key: KEY, choice: 'held', extra: 'x'.repeat(600) })).status).toBe(400);
  });

  it('refuses a request that is not from the site’s own page', async () => {
    const res = await POST(new Request('https://maskwars.xyz/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, choice: 'held' }) }));
    expect(res.status).toBe(403);
  });

  it('one person, one pick a round: a change of mind is filed under the same person, the last one counts', async () => {
    const first = await send({ key: KEY, choice: NOVA.account });
    const cookie = cookieOf(first);
    state.now += MIN;
    const second = await send({ key: KEY, choice: 'held' }, cookie);
    expect(second.status).toBe(200);
    const names = await pickStore().names(`${ROOT}round/${KEY}/`);
    const people = new Set(names.map((n) => n.split('~')[0]));
    expect(names).toHaveLength(2);
    expect(people.size).toBe(1);
  });
});
