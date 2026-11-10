// Which NEAR network a check reads, and where each one is read from.
//
// - testnet: FastNEAR first, the near.org node when it is down. As it always was.
// - mainnet: two independent providers, FastNEAR and dRPC, asked every read at the same block. An answer counts only
//   when both give the same one. FastNEAR's regular node keeps about 17 h of blocks, so for an older block it hands
//   over to FastNEAR's archival node; dRPC keeps about 30 h. rpc.mainnet.near.org is not used: it is deprecated, adds
//   3 s to every call and answers 429.
import { isTestnetName } from "./account.ts";
import { ChainReader, MAINNET_ARCHIVAL, MAINNET_RPCS, TESTNET_RPCS } from "./rpc.ts";

export type Network = "testnet" | "mainnet";

export const NETWORKS: readonly Network[] = ["testnet", "mainnet"];

export function isNetwork(value: unknown): value is Network {
  return value === "testnet" || value === "mainnet";
}

/**
 * The network an account id names when the caller does not say: `.testnet` reads testnet; `.near`, implicit ids (64
 * hex, `0x…`) and every other name read mainnet, where the money is.
 */
export function networkOf(accountId: string): Network {
  return isTestnetName(accountId.trim().toLowerCase()) ? "testnet" : "mainnet";
}

export interface NetworkConfig {
  rpc: readonly string[];
  /** Per endpoint, an archival node of the same provider, asked only for a block that endpoint no longer keeps. */
  archival: Readonly<Record<string, string>>;
  /** Every read goes to every endpoint and counts only when the answers match. */
  crossCheck: boolean;
  explorer: string;
  /** The environment variable that replaces `rpc`: comma-separated URLs. */
  rpcEnv: string;
}

export const NETWORK: Readonly<Record<Network, NetworkConfig>> = {
  testnet: { rpc: TESTNET_RPCS, archival: {}, crossCheck: false, explorer: "https://testnet.nearblocks.io", rpcEnv: "MASKCHECK_RPC" },
  mainnet: { rpc: MAINNET_RPCS, archival: MAINNET_ARCHIVAL, crossCheck: true, explorer: "https://nearblocks.io", rpcEnv: "MASKCHECK_MAINNET_RPC" },
};

export interface ReaderForOptions {
  /** Reads `MASKCHECK_RPC` (testnet) or `MASKCHECK_MAINNET_RPC` (mainnet) from here; pass `process.env`. */
  env?: Record<string, string | undefined>;
  endpoints?: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The endpoints a network is read from: the environment's list when it names any, else the defaults. */
export function endpointsFor(network: Network, env: Record<string, string | undefined> = {}): readonly string[] {
  const listed = env[NETWORK[network].rpcEnv]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return listed.length > 0 ? listed : NETWORK[network].rpc;
}

/** The reader for one network, as MASK CHECK reads it. */
export function readerFor(network: Network, options: ReaderForOptions = {}): ChainReader {
  const c = NETWORK[network];
  return new ChainReader({
    endpoints: options.endpoints ?? endpointsFor(network, options.env),
    archival: c.archival,
    crossCheck: c.crossCheck,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
