// The one arena reader of this server: every page and every API route reads the chain through it, so one reading of
// the arena serves them all for a few seconds. ARENA_FIXTURE (a recorded testnet answer file) replays recorded chain
// answers instead of the network: local screenshots and checks with no RPC.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Arena, Indexer, RPCS } from '@maskwars/arena';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';
import { FORGE_NET } from './forge';

let arena: Arena | null = null;

export function getArena(): Arena {
  if (arena) return arena;
  const fixture = process.env.ARENA_FIXTURE;
  if (fixture) {
    // Development only: the path is the developer's, so the build must not trace it.
    const file = resolve(/* turbopackIgnore: true */ process.cwd(), fixture);
    const recording = JSON.parse(readFileSync(/* turbopackIgnore: true */ file, 'utf8')) as Recording;
    const fetch = replayFetch(recording);
    arena = new Arena({
      rpc: new ChainReader({ endpoints: RPCS, fetch }),
      indexer: new Indexer({ fetch }),
      now: () => recording.recordedAt,
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
    arena = new Arena();
  }
  return arena;
}

/** A page or route that reads the arena answers at once with what it has; the chain may be slow, never the page. */
export async function readArena() {
  return getArena().view();
}
