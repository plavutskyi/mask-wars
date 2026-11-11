// The arena's last good reading outlives the instance that took it. Every reader here is one instance of the server:
// its own arena (the recorded testnet, or a chain that answers 429 to everything) over a store they all share.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Arena, type ArenaView, Indexer, NETWORK, type NextRace, type Race, RPCS } from '@maskwars/arena';
import { FRESH_MS } from '@maskwars/arena/jobs';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';
import { describe, expect, it, vi } from 'vitest';
import { arenaReader } from './arena';
import { CHANGED_MS, keeper, memoryStore, readSnapshot, runtimeStore, SNAPSHOT_VERSION, type SnapshotStore, UNCHANGED_MS } from './snapshot';

const recording = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/arena/test/fixtures/testnet.json'), 'utf8')) as Recording;
const T0 = recording.recordedAt;

/** A chain that answers: the recorded testnet, read at `now()`. */
function answering(now: () => number = () => T0): Arena {
  const fetch = replayFetch(recording);
  return new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer: new Indexer({ fetch }), now });
}

/** A chain that answers nobody: every RPC and the indexer say 429, as a public RPC does under load. */
function busy(): Arena {
  const fetch = (async () => new Response('Too Many Requests', { status: 429 })) as typeof globalThis.fetch;
  return new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer: new Indexer({ fetch }) });
}

/** What the page gets today when the chain answers nobody and nothing was kept: the chain's own error. */
async function chainError(): Promise<Error> {
  const why = await busy()
    .view()
    .then(
      () => null,
      (e: unknown) => e,
    );
  if (!(why instanceof Error)) throw new Error('a chain that answers 429 to everything must fail the reading');
  return why;
}

/** A store every instance shares, with every read and write of it counted. */
function shared(inner: SnapshotStore = memoryStore()) {
  const loads: string[] = [];
  const saves: { key: string; value: unknown }[] = [];
  const store: SnapshotStore = {
    load(key) {
      loads.push(key);
      return inner.load(key);
    },
    save(key, value) {
      saves.push({ key, value });
      return inner.save(key, value);
    },
  };
  return { store, loads, saves };
}

/** One instance of the server; `settle()` waits for what it writes behind its responses. */
function instance(o: { arena: Pick<Arena, 'view'>; store: SnapshotStore; now?: () => number }) {
  const behind: Promise<void>[] = [];
  const reader = arenaReader({ arena: o.arena, keeper: keeper({ store: o.store, network: NETWORK }), now: o.now ?? (() => T0), background: (w) => behind.push(w) });
  return { ...reader, behind, settle: () => Promise.all(behind) };
}

/** The key the first write went under: where a test plants what it wants a new instance to find. */
async function keptKey(store: SnapshotStore): Promise<string> {
  const s = shared(store);
  const first = instance({ arena: answering(), store: s.store });
  await first.read();
  await first.settle();
  return s.saves[0]!.key;
}

/** race-0003 as it stood while the masks raced: the safe open, LIVE. */
function racing(view: ArenaView): ArenaView {
  const r = view.races.find((x) => x.id === 'race-0003')!;
  const live: Race = { ...r, phase: 'racing', live: true, state: 'open', winner: null, brokeAt: null, breakMs: null, loot: null, payout: null, takes: null, inSafe: r.safeFunded };
  return { ...view, races: view.races.map((x) => (x === r ? live : x)), now: live };
}

/** Throws at the first value JSON would lose or change: a bigint, a Date, a Map, a number that is not finite. */
function jsonOnly(x: unknown, path = 'view'): void {
  if (x === null || x === undefined || typeof x === 'string' || typeof x === 'boolean') return;
  if (typeof x === 'number' && Number.isFinite(x)) return;
  if (Array.isArray(x)) return x.forEach((v, i) => jsonOnly(v, `${path}[${i}]`));
  if (typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) return Object.entries(x).forEach(([k, v]) => jsonOnly(v, `${path}.${k}`));
  throw new Error(`${path}: JSON does not keep ${typeof x === 'object' ? x.constructor.name : typeof x} ${String(x)}`);
}

describe('the last good reading of the arena', () => {
  it('is kept once a reading succeeds, behind the response and for every instance', async () => {
    const { store, saves } = shared();
    const first = instance({ arena: answering(), store });
    const view = await first.read();
    expect(view.races[0]?.id).toBe('race-0003');
    // The write is handed to the response's background, never awaited by the page.
    expect(first.behind).toHaveLength(1);
    await first.settle();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.key).toContain(NETWORK);
    expect(readSnapshot(await store.load(saves[0]!.key), NETWORK)).toEqual(view);
  });

  it('comes back from the store whole: a reading is plain JSON, and nothing in it is lost', async () => {
    const view = await answering().view();
    jsonOnly(view);
    const back = readSnapshot(JSON.parse(JSON.stringify({ v: SNAPSHOT_VERSION, network: NETWORK, view })), NETWORK);
    expect(back).toEqual(view);
    expect(JSON.stringify(back)).toBe(JSON.stringify(view));
    // A race in motion and a season's next round, as its treasury words it (U128 in strings, u64 in numbers), which
    // the recording does not hold, read back whole as well.
    const nova = view.league.find((m) => m.who.slug === 'nova')!.who;
    const next: NextRace = {
      season: `season.${view.races[0]!.team}`,
      at: T0 + 3_600_000,
      n: 7,
      target: 'live-safe',
      targetCode: '7u1QBYjTPhXZhFHzJ4qdhuJdB33y3GfLEiXHAZFrbdZx',
      inSafe: '2200000000000000000000000',
      locked: '350000000000000000000000',
      prize: '2550000000000000000000000',
      minLoot: '500000000000000000000000',
      masks: [nova],
      sealMinutes: 45,
      hours: 4,
      funded: true,
    };
    const moving: ArenaView = { ...racing(view), next };
    expect(readSnapshot(JSON.parse(JSON.stringify({ v: SNAPSHOT_VERSION, network: NETWORK, view: moving })), NETWORK)).toEqual(moving);
  });

  it('a new instance the chain does not answer shows the reading another instance kept', async () => {
    const { store } = shared();
    const first = instance({ arena: answering(), store });
    const view = await first.read();
    await first.settle();

    const cold = instance({ arena: busy(), store });
    const shown = await cold.read();
    expect(shown).toEqual(view);
    expect(shown.now?.id).toBe(view.now?.id);
    // Read a moment ago by the clock both share: it is still a reading of now.
    expect(cold.asOf(shown)).toBeNull();
  });

  it('with no reading ever kept, a new instance the chain does not answer says so, as before', async () => {
    const { store, loads, saves } = shared();
    const why = await chainError();
    const cold = instance({ arena: busy(), store });
    await expect(cold.read()).rejects.toThrow(why.message);
    // It looked for a kept reading once, and kept nothing of a reading that failed.
    expect(loads).toHaveLength(1);
    expect(saves).toHaveLength(0);
  });

  it('never waits for the store, and a store that is down takes nothing but the snapshot', async () => {
    // A store that answers only when told to: the page has its reading long before.
    let open!: () => void;
    const gate = new Promise<void>((done) => (open = done));
    const inner = memoryStore();
    const slow = shared({ load: (k) => gate.then(() => inner.load(k)), save: (k, v) => gate.then(() => inner.save(k, v)) });
    const first = instance({ arena: answering(), store: slow.store });
    const view = await first.read();
    expect(view.races.length).toBeGreaterThan(0);
    expect(slow.saves).toHaveLength(0);
    open();
    await first.settle();
    expect(slow.saves).toHaveLength(1);

    // A store that throws: a good reading is shown all the same, and a failed one fails with the chain's own error.
    const down: SnapshotStore = { load: () => Promise.reject(new Error('store down')), save: () => Promise.reject(new Error('store down')) };
    const lucky = instance({ arena: answering(), store: down });
    expect(await lucky.read()).toEqual(view);
    await expect(lucky.settle()).resolves.toBeDefined();
    const unlucky = instance({ arena: busy(), store: down });
    await expect(unlucky.read()).rejects.toThrow((await chainError()).message);
  });

  it('ignores what is not a whole reading of this network and this version', async () => {
    const inner = memoryStore();
    const key = await keptKey(inner);
    const view = readSnapshot(await inner.load(key), NETWORK)!;
    const kept = { v: SNAPSHOT_VERSION, network: NETWORK, view };
    const elsewhere = NETWORK === 'mainnet' ? 'testnet' : 'mainnet';
    const { events: _events, ...noEvents } = view.races[0]!;
    const spoiled: unknown[] = [
      'not a reading at all',
      42,
      [],
      {},
      { ...kept, v: SNAPSHOT_VERSION + 1 },
      { ...kept, network: elsewhere },
      { ...kept, view: null },
      { ...kept, view: { ...view, network: elsewhere } },
      { ...kept, view: { ...view, races: 'race-0003' } },
      { ...kept, view: { ...view, races: [noEvents, ...view.races.slice(1)] } },
      { ...kept, view: { ...view, races: [{ ...view.races[0]!, phase: 'exploded' }] } },
      { ...kept, view: { ...view, races: [{ ...view.races[0]!, network: elsewhere }] } },
      { ...kept, view: { ...view, now: { id: 'race-0003' } } },
      { ...kept, view: { ...view, league: [{ who: 'nova' }] } },
      { ...kept, view: { ...view, readAt: '2026-11-11' } },
    ];
    const why = await chainError();
    for (const bad of spoiled) {
      expect(readSnapshot(bad, NETWORK), JSON.stringify(bad).slice(0, 80)).toBeNull();
      await inner.save(key, bad);
      // The page fails as it does with nothing kept: with the chain's error, never with the snapshot's.
      await expect(instance({ arena: busy(), store: inner }).read()).rejects.toThrow(why.message);
    }
    // The next good reading takes its place.
    const next = instance({ arena: answering(), store: inner });
    await next.read();
    await next.settle();
    expect(readSnapshot(await inner.load(key), NETWORK)).toEqual(view);
  });

  it('an old reading is never LIVE: past the fresh line it says when it was taken, and nothing in it runs now', async () => {
    const { store } = shared();
    const view = racing(await answering().view());
    expect(view.now?.live).toBe(true);
    const first = instance({ arena: { view: async () => view }, store });
    await first.read();
    await first.settle();

    // Another instance, the chain silent, within the fresh line: the race another instance read seconds ago is LIVE.
    const soon = instance({ arena: busy(), store, now: () => T0 + FRESH_MS });
    const fresh = await soon.read();
    expect(fresh.now?.live).toBe(true);
    expect(soon.asOf(fresh)).toBeNull();

    // Past it: the same race, the same numbers, the time it was read at, and no LIVE anywhere.
    const late = instance({ arena: busy(), store, now: () => T0 + FRESH_MS + 1 });
    const old = await late.read();
    expect(late.asOf(old)).toBe(T0);
    expect(old.races.some((r) => r.live)).toBe(false);
    expect(old.now).toEqual({ ...view.now!, live: false });
    expect(old.races.map((r) => ({ ...r, live: true }))).toEqual(view.races.map((r) => ({ ...r, live: true })));
    expect(old.readAt).toBe(T0);

    // The same holds for an instance's own last reading, which its arena hands back when a new one fails.
    const own = instance({ arena: { view: async () => view }, store: memoryStore(), now: () => T0 + FRESH_MS + 1 });
    const stale = await own.read();
    expect(stale.now?.live).toBe(false);
    expect(stale.races.some((r) => r.live)).toBe(false);
    expect(own.asOf(stale)).toBe(T0);
  });
});

describe('the store every instance shares', () => {
  it('is the Runtime Cache of @vercel/functions: outside Vercel it keeps to this process, plain JSON in and out', async () => {
    // Off Vercel the package says once that it falls back to memory; the site itself uses `memoryStore` there.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = runtimeStore();
      expect(await store.load('arena/nothing-kept')).toBeNull();
      const view = await answering().view();
      await store.save('arena/kept', { v: SNAPSHOT_VERSION, network: NETWORK, view });
      expect(readSnapshot(await store.load('arena/kept'), NETWORK)).toEqual(view);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('what keeping costs', () => {
  it('a new instance asks the store once and writes nothing while the kept reading says the same', async () => {
    const { store, loads, saves } = shared();
    const first = instance({ arena: answering(), store });
    await first.read();
    await first.read();
    await first.settle();
    expect(saves).toHaveLength(1);

    let now = T0 + 60_000;
    const second = instance({ arena: answering(() => now), store, now: () => now });
    const before = loads.length;
    await second.read();
    await second.settle();
    expect(loads.length - before).toBe(1);
    expect(saves).toHaveLength(1);

    // The same reading again, ten minutes on: kept again, so the kept one is never older than that in vain.
    now = T0 + UNCHANGED_MS;
    const third = instance({ arena: answering(() => now), store, now: () => now });
    await third.read();
    await third.settle();
    expect(saves).toHaveLength(2);
    expect((saves[1]!.value as { view: ArenaView }).view.readAt).toBe(now);
  });

  it('a reading that changed is kept again, at most every CHANGED_MS, and never an older one over a newer', async () => {
    const { store, saves } = shared();
    const base = await answering().view();
    let current = base;
    const one = instance({ arena: { view: async () => current }, store });
    await one.read();
    await one.settle();
    expect(saves).toHaveLength(1);

    // The race moves a few seconds later: too soon for another write.
    current = { ...racing(base), readAt: T0 + 5_000 };
    await one.read();
    await one.settle();
    expect(saves).toHaveLength(1);

    current = { ...racing(base), readAt: T0 + CHANGED_MS };
    await one.read();
    await one.settle();
    expect(saves).toHaveLength(2);

    // An instance still holding the first reading does not put it back over the newer one.
    const behindTheTimes = instance({ arena: { view: async () => base }, store });
    await behindTheTimes.read();
    await behindTheTimes.settle();
    expect(saves).toHaveLength(2);
    expect(readSnapshot(await store.load(saves[0]!.key), NETWORK)?.readAt).toBe(T0 + CHANGED_MS);
  });
});
