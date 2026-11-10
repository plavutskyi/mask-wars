// The arena the agents read at /mcp and the /mcp/connect page shows: one feed for both, on the config of this
// environment (MASKWARS_BOUNTY_CONTRACTS, MASKWARS_RPC, MASKWARS_INDEXER, MASKWARS_TEAMS), the same the stdio server and
// the live check read. So the arena tools and get_race read the same contracts, and the page shows exactly what an
// agent reads. A reading that runs behind an answer already sent is kept alive with `after`, so the function is not
// frozen halfway through it. ARENA_FIXTURE (a recorded testnet answer file) replays recorded chain answers instead of
// the network, as the site's own reader does: local screenshots and checks with no RPC.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { type ArenaConfig, type ArenaFeed, arenaFeed, configFromEnv } from '@maskwars/mcp';
import { after } from 'next/server';

export interface SiteMcp {
  config: ArenaConfig;
  feed: ArenaFeed;
}

/** The config and the arena feed for an environment; `fetch` for every request to the chain, by default the network's. */
export function mcpOf(env: Record<string, string | undefined>, fetch?: typeof globalThis.fetch): SiteMcp {
  const config = configFromEnv(env);
  const fixture = env['ARENA_FIXTURE'];
  if (fixture) {
    // Development only: the path is the developer's, so the build must not trace it.
    const file = resolve(/* turbopackIgnore: true */ process.cwd(), fixture);
    const recording = JSON.parse(readFileSync(/* turbopackIgnore: true */ file, 'utf8')) as Recording;
    return { config, feed: arenaFeed(config, { fetch: replayFetch(recording), now: () => recording.recordedAt, keepAlive }) };
  }
  return { config, feed: arenaFeed(config, { keepAlive, ...(fetch ? { fetch } : {}) }) };
}

/** The reading runs on after the response; outside a request `after` throws and the feed reads on all the same. */
const keepAlive = (reading: Promise<unknown>) => after(reading);

let mcp: SiteMcp | null = null;

/** This server's one: the route and the page read through it. */
export function getMcp(): SiteMcp {
  mcp ??= mcpOf(process.env);
  return mcp;
}
