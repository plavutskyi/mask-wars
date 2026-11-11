// The one arena reader of this server: every page and every API route reads the chain through it, so one reading of
// the arena serves them all for a few seconds. A good reading is also kept where every instance of the server finds it
// (lib/snapshot.ts): an instance that has just started and gets no answer from the chain shows that one, not an error.
// ARENA_FIXTURE (a recorded testnet answer file) replays recorded chain answers instead of the network: local
// screenshots and checks with no RPC.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Arena, type ArenaView, Indexer, NETWORK, RPCS } from '@maskwars/arena';
import { FRESH_MS } from '@maskwars/arena/jobs';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';
import { after } from 'next/server';
import { FORGE_NET } from './forge';
import { type Keeper, keeper, memoryStore, runtimeStore } from './snapshot';

let arena: Arena | null = null;
/** The clock the readings are taken by: a recording's own moment when one is replayed. */
let clock: () => number = Date.now;
/** The site's own reader of the real chain: only its readings are kept where other instances find them. */
let real = false;

export function getArena(): Arena {
  if (arena) return arena;
  const fixture = process.env.ARENA_FIXTURE;
  if (fixture) {
    // Development only: the path is the developer's, so the build must not trace it.
    const file = resolve(/* turbopackIgnore: true */ process.cwd(), fixture);
    const recording = JSON.parse(readFileSync(/* turbopackIgnore: true */ file, 'utf8')) as Recording;
    const fetch = replayFetch(recording);
    clock = () => recording.recordedAt;
    arena = new Arena({
      rpc: new ChainReader({ endpoints: RPCS, fetch }),
      indexer: new Indexer({ fetch }),
      now: clock,
    });
  } else if (process.env.ARENA_RPC && process.env.ARENA_INDEXER && process.env.ARENA_CONTRACTS) {
    // Development only: the arena on a local NEAR sandbox (apps/web/scripts/sandbox-indexer.mjs serves its history).
    arena = new Arena({
      rpc: new ChainReader({ endpoints: [process.env.ARENA_RPC] }),
      indexer: new Indexer({ base: process.env.ARENA_INDEXER }),
      contracts: process.env.ARENA_CONTRACTS.split(','),
      seasons: [],
      factory: FORGE_NET.factory,
    });
  } else {
    real = true;
    arena = new Arena();
  }
  return arena;
}

export interface ArenaReader {
  /**
   * The arena: read from the chain now, or the last good reading when the chain does not answer, this instance's own
   * or the one any instance kept. It throws the chain's error only when there has never been a good reading.
   */
  read(): Promise<ArenaView>;
  /**
   * When `view` was read, if that is too long ago to show it as happening now (over `FRESH_MS`, the jobs board's own
   * line); null for a fresh reading. A page that gets a time shows it, and no LIVE and no running clock.
   */
  asOf(view: Pick<ArenaView, 'readAt'>): number | null;
}

/** A reading too old to say what happens now: nothing in it is LIVE. The rest stands as it was read. */
function quiet(view: ArenaView): ArenaView {
  if (!view.races.some((r) => r.live)) return view;
  const races = view.races.map((r) => (r.live ? { ...r, live: false } : r));
  const shown = view.now;
  const now = shown && (races.find((r) => r.id === shown.id && r.contract === shown.contract) ?? { ...shown, live: false });
  return { ...view, races, now };
}

/**
 * A reader over one arena and one keeper: an instance of the server. `background` keeps a write alive behind the
 * response it must not slow down.
 */
export function arenaReader(o: { arena: Pick<Arena, 'view'>; keeper: Keeper; now?: () => number; background?: (work: Promise<void>) => void }): ArenaReader {
  const now = o.now ?? Date.now;
  const asOf = (view: Pick<ArenaView, 'readAt'>) => (now() - view.readAt > FRESH_MS ? view.readAt : null);
  const honest = (view: ArenaView) => (asOf(view) === null ? view : quiet(view));
  return {
    async read() {
      let view: ArenaView;
      try {
        view = await o.arena.view();
      } catch (error) {
        const kept = await o.keeper.recall();
        if (!kept) throw error;
        return honest(kept);
      }
      const keeping = o.keeper.keep(view);
      o.background?.(keeping);
      return honest(view);
    },
    asOf,
  };
}

/** The write runs on after the response; outside a request `after` throws and the write runs on all the same. */
function behind(work: Promise<void>): void {
  try {
    after(work);
  } catch {
    /* no request to outlive: a test, a script */
  }
}

let reader: ArenaReader | null = null;

function getReader(): ArenaReader {
  if (reader) return reader;
  const chain = getArena();
  // A recording and a local sandbox keep to this process, and so does a run outside Vercel: memory, as before.
  const store = real && process.env.VERCEL ? runtimeStore() : memoryStore();
  // A recording looked at later than it was made (ARENA_FIXTURE_LATE_MS, local runs only): the reading it replays is that
  // old, as when the chain stops answering and the last good reading is all there is.
  const late = real ? 0 : Number(process.env.ARENA_FIXTURE_LATE_MS) || 0;
  reader = arenaReader({ arena: chain, keeper: keeper({ store, network: NETWORK }), now: () => clock() + late, background: behind });
  return reader;
}

/**
 * The arena for a page or a route: read from the chain now, or the last good reading when the chain does not answer
 * (`ArenaReader.read`). A reading that is no longer fresh comes with nothing LIVE in it; `asOf` says when it was taken.
 */
export async function readArena() {
  return getReader().read();
}

/**
 * The time picks are taken by: the server's clock, or, over a replayed recording, the recording's own moment running on
 * from when this server started, so a window the recording shows open stays open while it is looked at.
 */
export function pickNow(): number {
  getArena();
  return real || clock === Date.now ? Date.now() : clock() + (Date.now() - started);
}
const started = Date.now();

/** When a reading too old to be shown as happening now was taken; null for a fresh one (`ArenaReader.asOf`). */
export function asOf(view: Pick<ArenaView, 'readAt'>): number | null {
  return getReader().asOf(view);
}
