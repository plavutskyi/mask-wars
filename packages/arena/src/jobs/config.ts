// Where the jobs live on chain: the jobs and crews contracts of the network this process reads (MASKWARS_NETWORK:
// packages/network). Until the jobs contract is deployed there its account holds no code, and the board is honestly
// empty.
import { NET, NETWORKS, type Network, networkOf } from "@maskwars/network";
import { MASKS } from "../config.ts";

export interface JobsConfig {
  /** `testnet` or `mainnet`; `sandbox` for a local chain. */
  readonly network: string;
  /** The jobs contract; `null` when this reader has none to read. */
  readonly contract: string | null;
  /**
   * The crews contract crews form on now. A job keeps the crews contract it opened with (`Job.crews`): that one hands
   * the job its crews.
   */
  readonly crews: string | null;
  /** JSON-RPC endpoints, the first preferred; the next is tried only when one is down. */
  readonly rpc: readonly string[];
  /** The public transactions indexer (FastNEAR explorer API shape): every job's history after its state is cleared. */
  readonly indexer: string;
  /** Where a person opens a transaction or an account; `null` for a local chain no explorer sees. */
  readonly explorer: string | null;
  /**
   * Where the judges' public storage on OutLayer is read over HTTP: `<base>?project=<owner/project>&key=<key>` gives
   * a value. The winning work sealed for the client's key lies there once delivered. `null` when no such address is
   * set: the delivery then names the project and the key to read.
   */
  readonly storage?: string | null;
  /**
   * The mask factory is on chain here (`sections.forge` of packages/network). A job open only to forged masks can be
   * taken only then: until the factory's account exists nobody has such a mask, and the job is not offered to anyone.
   */
  readonly forge?: boolean;
}

/** The jobs of one network, as packages/network places them. */
export function jobsConfigOf(net: Network = NET): JobsConfig {
  return { network: net.id, contract: net.jobs, crews: net.crews, rpc: net.rpc, indexer: net.indexer, explorer: net.explorer, forge: net.sections.forge };
}

export const TESTNET_JOBS: JobsConfig = jobsConfigOf(NETWORKS.testnet);
export const MAINNET_JOBS: JobsConfig = jobsConfigOf(NETWORKS.mainnet);

function list(value: string | undefined): string[] | null {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return items.length > 0 ? items : null;
}

/**
 * The jobs of the network `MASKWARS_NETWORK` names: its jobs and crews contracts, RPC, indexer and explorer come from
 * packages/network, so a deployed site needs no variable for them. `MASKWARS_RPC` (or `MASKCHECK_RPC`,
 * `MASKCHECK_MAINNET_RPC`) and `MASKWARS_INDEXER` point at other endpoints, and `MASKWARS_JUDGE_STORAGE` at the judges'
 * public storage. `MASKWARS_JOBS_CONTRACT` (with `MASKWARS_CREWS_CONTRACT`) names another jobs contract: only a local
 * chain has one, so the reading is then marked `sandbox` and links to no explorer. The site, the MCP server and the
 * scripts read the same variables, so they read the same contract. Nothing here is a secret.
 */
export function jobsConfigFromEnv(env: Record<string, string | undefined>): JobsConfig {
  const base = jobsConfigOf(NETWORKS[networkOf(env["MASKWARS_NETWORK"])]);
  const other = env["MASKWARS_JOBS_CONTRACT"]?.trim();
  const local = Boolean(other) && other !== base.contract;
  const checkRpc = base.network === "testnet" ? env["MASKCHECK_RPC"] : env["MASKCHECK_MAINNET_RPC"];
  return {
    network: local ? "sandbox" : base.network,
    contract: local ? other! : base.contract,
    crews: local ? env["MASKWARS_CREWS_CONTRACT"]?.trim() || null : base.crews,
    rpc: list(env["MASKWARS_RPC"]) ?? list(checkRpc) ?? base.rpc,
    indexer: env["MASKWARS_INDEXER"]?.trim() || base.indexer,
    explorer: local ? null : base.explorer,
    storage: env["MASKWARS_JUDGE_STORAGE"]?.trim() || null,
    // A local chain is the jobs world of the tests, which deploys its own factory beside the jobs contract.
    forge: local || base.forge === true,
  };
}

/** Where a delivered work can be fetched over HTTP, when the config knows the judges' storage address. */
export function deliveryUrl(config: Pick<JobsConfig, "storage">, delivery: { project: string; at: string }): string | null {
  if (!config.storage) return null;
  return `${config.storage}?project=${encodeURIComponent(delivery.project)}&key=${encodeURIComponent(delivery.at)}`;
}

/** The arena's own masks keep their names and faces on a job; any other account is read as itself. */
export const ARENA_MASKS = MASKS;

export const txUrl = (config: Pick<JobsConfig, "explorer">, hash: string | null | undefined) => (config.explorer && hash ? `${config.explorer}/txns/${hash}` : undefined);
export const accountUrl = (config: Pick<JobsConfig, "explorer">, account: string | null | undefined) => (config.explorer && account ? `${config.explorer}/address/${account}` : undefined);
