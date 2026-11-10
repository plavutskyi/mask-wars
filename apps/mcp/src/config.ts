// Where the arena lives: the network of this process (MASKWARS_NETWORK, packages/network), testnet unless it says
// mainnet. The same server reads the other network by its config alone.
import { bountyContracts, NETWORKS, type NetworkId, networkOf, teams } from "@maskwars/network";

export interface ArenaConfig {
  network: NetworkId;
  /** JSON-RPC endpoints, the first preferred; the next is tried only when one is down. */
  rpc: readonly string[];
  /**
   * The bounty contracts that hold races, newest first. A race id is looked up in this order. The contract moved to
   * its own account without a key; the races before the move stay where they were opened.
   */
  contracts: readonly string[];
  /**
   * The arena's own teams: the accounts that open its races, the team and its season treasury. A race they opened is
   * the arena's; their safes `safe-0001.<team>` read as SAFE-0001. Anyone may open a race on the contract: such a race
   * reads as another team's, its safe by its whole account.
   */
  teams: readonly string[];
  /** The public transactions indexer the arena lists races and every move from (FastNEAR explorer API, no key). */
  indexer: string;
  explorer: string;
  site: string;
}

function arenaOf(id: NetworkId): ArenaConfig {
  const n = NETWORKS[id];
  return {
    network: id,
    rpc: n.rpc,
    contracts: bountyContracts(n),
    teams: teams(n),
    indexer: n.indexer,
    explorer: n.explorer,
    site: "https://maskwars.xyz",
  };
}

export const TESTNET: ArenaConfig = arenaOf("testnet");
export const MAINNET: ArenaConfig = arenaOf("mainnet");

function list(value: string | undefined): string[] | null {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return items.length > 0 ? items : null;
}

/**
 * The config of the network `MASKWARS_NETWORK` names, with overrides from the environment: `MASKWARS_RPC` (or
 * `MASKCHECK_RPC`, which the check endpoint reads for testnet), `MASKWARS_BOUNTY_CONTRACTS` and `MASKWARS_TEAMS`, all
 * comma-separated, and `MASKWARS_INDEXER`. The stdio server, the live check and the site's /mcp all read it, so the arena
 * tools and get_race read the same contracts. Nothing here is a secret.
 */
export function configFromEnv(env: Record<string, string | undefined>): ArenaConfig {
  const base = arenaOf(networkOf(env["MASKWARS_NETWORK"]));
  const checkRpc = base.network === "testnet" ? env["MASKCHECK_RPC"] : env["MASKCHECK_MAINNET_RPC"];
  return {
    ...base,
    rpc: list(env["MASKWARS_RPC"]) ?? list(checkRpc) ?? base.rpc,
    contracts: list(env["MASKWARS_BOUNTY_CONTRACTS"]) ?? base.contracts,
    teams: list(env["MASKWARS_TEAMS"]) ?? base.teams,
    indexer: env["MASKWARS_INDEXER"]?.trim() || base.indexer,
  };
}
