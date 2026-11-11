// The last good reading of the arena, kept where every instance of this server finds it. One instance's memory dies
// with it: a new instance whose first reading of the chain fails would have nothing to show (lib/arena.ts). On Vercel
// the reading is kept in the Runtime Cache: shared by every instance in the region, kept across deployments, with no
// key and nothing to set up. Anywhere else it is kept in this process's memory. It is a cache, never the record: the
// chain is the record, and a reading that is kept says when it was taken (`readAt`).
import type { ArenaView, EventKind, MaskRace, MaskStats, NextRace, Phase, Race, RaceEvent, State, Who } from '@maskwars/arena';
import { getCache } from '@vercel/functions';

/** What is kept is written this way. A reading kept under another number is never read as this one. */
export const SNAPSHOT_VERSION = 1;

/** A reading that changed is kept again once it is this much newer than the kept one, ms: a round in motion. */
export const CHANGED_MS = 30_000;
/** A reading that says the same is kept again once it is this much newer, ms: the kept one never grows old in vain. */
export const UNCHANGED_MS = 10 * 60_000;
/** How long the store holds a reading nobody replaced, seconds. */
const HOLD_S = 30 * 24 * 3_600;
/** The store takes one item of 2 MB: a reading longer than this is not kept. */
const MAX_CHARS = 1_500_000;
/** A page waits this long for the store, ms; a write behind a response, a little longer. */
const LOAD_MS = 1_500;
const SAVE_MS = 5_000;

// ---- What a kept reading must look like ----

type Check = (x: unknown) => boolean;
/** Every field of `T` has its check: a field added to the arena's types stops the build here until it has one. */
type Spec<T> = { readonly [K in keyof T]-?: Check };

const str: Check = (x) => typeof x === 'string';
const num: Check = (x) => typeof x === 'number' && Number.isFinite(x);
const bool: Check = (x) => typeof x === 'boolean';
const orNull = (c: Check): Check => (x) => x === null || c(x);
const maybe = (c: Check): Check => (x) => x === undefined || c(x);
const listOf = (c: Check): Check => (x) => Array.isArray(x) && x.every(c);
/** One of a union's words; a word added to the union stops the build here until it is listed. */
const wordOf = <K extends string>(all: Readonly<Record<K, true>>): Check => (x) => typeof x === 'string' && Object.hasOwn(all, x);
const shape = <T>(spec: Spec<T>): Check => {
  const fields = Object.entries(spec as Record<string, Check>);
  return (x) => typeof x === 'object' && x !== null && !Array.isArray(x) && fields.every(([k, c]) => c((x as Record<string, unknown>)[k]));
};

const phase = wordOf<Phase>({ sealing: true, racing: true, broken: true, held: true });
const state = wordOf<State>({ open: true, judging: true, paid: true, drained: true, refunded: true });
const who = shape<Who>({ account: str, slug: orNull(str), name: str, mask: bool, model: orNull(str) });
const sum = shape<NonNullable<Race['payout']>>({ amount: str, at: orNull(num), tx: orNull(str) });
const event = shape<RaceEvent>({
  kind: wordOf<EventKind>({ open: true, fund: true, seal: true, move: true, drain: true, reveal: true, claim: true, paid: true, refund: true }),
  at: num,
  tx: str,
  who: orNull(who),
  amount: orNull(str),
  ok: bool,
  method: maybe(str),
  verdict: maybe(wordOf<NonNullable<RaceEvent['verdict']>>({ paid: true, no: true, waiting: true })),
  seq: maybe(num),
  early: maybe(bool),
});
const maskRace = shape<MaskRace>({ id: str, at: orNull(num), phase, won: bool, takes: orNull(str), breakMs: orNull(num), target: str, targetCode: orNull(str) });
const stats = shape<MaskStats>({ who, races: num, breaks: num, earned: str, fastestMs: orNull(num), fastestRace: orNull(str), history: listOf(maskRace) });
const nextRace = shape<NextRace>({
  season: str,
  at: num,
  n: num,
  target: str,
  targetCode: str,
  inSafe: str,
  locked: str,
  prize: str,
  minLoot: str,
  masks: listOf(who),
  sealMinutes: num,
  hours: num,
  funded: bool,
});

/** The whole reading, on `network` and no other. */
function viewOn(network: string): Check {
  const here: Check = (x) => x === network;
  const race = shape<Race>({
    id: str,
    network: here,
    contract: str,
    season: orNull(str),
    kind: wordOf<Race['kind']>({ safe: true, sandbox: true }),
    phase,
    live: bool,
    state,
    team: str,
    official: bool,
    target: str,
    targetCode: orNull(str),
    locked: orNull(str),
    bounty: str,
    inSafe: orNull(str),
    safeFunded: orNull(str),
    minLoot: orNull(str),
    openedAt: orNull(num),
    startsAt: orNull(num),
    deadline: num,
    sealUntil: orNull(num),
    revealUntil: orNull(num),
    masks: listOf(who),
    winner: orNull(who),
    brokeAt: orNull(num),
    breakMs: orNull(num),
    loot: orNull(str),
    payout: orNull(sum),
    refund: orNull(sum),
    takes: orNull(str),
    prize: str,
    events: listOf(event),
    txs: shape<Race['txs']>({ open: orNull(str), drain: orNull(str), payout: orNull(str) }),
    judge: orNull(str),
    runId: orNull(str),
  });
  return shape<ArenaView>({ network: here, races: listOf(race), now: orNull(race), next: orNull(nextRace), league: listOf(stats), readAt: num });
}

/** A reading as it is kept: under its version and its network. */
interface Kept {
  readonly v: number;
  readonly network: string;
  readonly view: ArenaView;
}

/**
 * The reading inside what the store gave back, or null: nothing kept, another version, another network, or anything
 * that is not a whole reading of the arena. What is not one is ignored, never shown and never thrown.
 */
export function readSnapshot(kept: unknown, network: string): ArenaView | null {
  if (typeof kept !== 'object' || kept === null) return null;
  const k = kept as Partial<Kept>;
  if (k.v !== SNAPSHOT_VERSION || k.network !== network || !viewOn(network)(k.view)) return null;
  return k.view as ArenaView;
}

/** What a reading says, apart from when it was taken: two readings that say the same are kept once. */
const said = (view: ArenaView) => JSON.stringify({ ...view, readAt: 0 });

// ---- Where it is kept ----

export interface SnapshotStore {
  /** What is kept under `key`; null or undefined when nothing is. */
  load(key: string): Promise<unknown>;
  save(key: string, value: unknown): Promise<void>;
}

/** This process's memory: a local run, a recording, a test. As plain JSON, like the store every instance shares. */
export function memoryStore(): SnapshotStore {
  const kept = new Map<string, string>();
  return {
    async load(key) {
      const body = kept.get(key);
      return body === undefined ? null : (JSON.parse(body) as unknown);
    },
    async save(key, value) {
      kept.set(key, JSON.stringify(value));
    },
  };
}

/** Vercel's Runtime Cache: every instance of the deployment's environment in the region reads and writes the same. */
export function runtimeStore(): SnapshotStore {
  const cache = getCache({ namespace: 'maskwars' });
  return {
    load: (key) => cache.get(key),
    save: (key, value) => cache.set(key, value, { ttl: HOLD_S }),
  };
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('the snapshot store did not answer')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        done(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        fail(error);
      },
    );
  });
}

export interface Keeper {
  /** Keeps a good reading for the instances to come, when it is worth a write. Never rejects. */
  keep(view: ArenaView): Promise<void>;
  /** The last reading any instance kept, or null. Never rejects. */
  recall(): Promise<ArenaView | null>;
}

/**
 * The keeper of one network's last good reading. It writes only what is worth a write: a reading newer than the kept
 * one that says something else (at most every `CHANGED_MS`), or the same again after `UNCHANGED_MS`. A new instance
 * first asks the store what is kept already, so a cold start costs one read and no write. A store that is slow, down
 * or full costs nothing but the snapshot.
 */
export function keeper(o: { store: SnapshotStore; network: string }): Keeper {
  const key = `arena/last-good/v${SNAPSHOT_VERSION}/${o.network}`;
  const fits = viewOn(o.network);
  /** The reading the store holds, as far as this instance knows; `undefined` until it has asked. */
  let known: { readAt: number; said: string } | null | undefined;
  /** The reading this instance last tried to keep: a store that fails is not asked again at every reading. */
  let triedAt = Number.NEGATIVE_INFINITY;
  let offered: ArenaView | null = null;
  let queue: Promise<void> = Promise.resolve();
  let warned = false;

  const recall = async (): Promise<ArenaView | null> => {
    try {
      return readSnapshot(await within(o.store.load(key), LOAD_MS), o.network);
    } catch {
      return null;
    }
  };

  const consider = async (view: ArenaView): Promise<void> => {
    if (known === undefined) {
      const kept = await recall();
      known = kept ? { readAt: kept.readAt, said: said(kept) } : null;
    }
    // Never an older reading over a newer one: an instance whose chain stopped answering holds an old one for long.
    if (known && view.readAt <= known.readAt) return;
    if (view.readAt - Math.max(known?.readAt ?? Number.NEGATIVE_INFINITY, triedAt) < CHANGED_MS) return;
    const body = said(view);
    if (known && body === known.said && view.readAt - known.readAt < UNCHANGED_MS) return;
    triedAt = view.readAt;
    if (body.length > MAX_CHARS || !fits(view)) {
      // A reading that could not be read back is not kept; said once, so the logs show the snapshot is not working.
      if (!warned) console.warn(`arena snapshot: a reading of ${body.length} characters is not kept (too long, or not the shape lib/snapshot.ts reads)`);
      warned = true;
      return;
    }
    await within(o.store.save(key, { v: SNAPSHOT_VERSION, network: o.network, view } satisfies Kept), SAVE_MS);
    known = { readAt: view.readAt, said: body };
  };

  return {
    keep(view) {
      // The reader hands out one reading for a few seconds: the same one is considered once.
      if (view === offered) return queue;
      offered = view;
      queue = queue.then(() => consider(view)).catch(() => {});
      return queue;
    },
    recall,
  };
}
