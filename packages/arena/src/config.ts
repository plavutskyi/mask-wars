// Where the arena lives on chain and who races in it, on the network this process reads (MASKWARS_NETWORK:
// packages/network). Everything else is read from the chain.
import { bountyContracts, type HouseRound, NET, type NetworkId, teams } from "@maskwars/network";

export type Network = NetworkId;
export const NETWORK: Network = NET.id;

/**
 * The bounty contracts, newest first. The keyless contract (`bounty.tinygif8324.testnet`, `bounty.maskwars.near`) takes
 * every new race once it is deployed; on testnet the races before it stay on the first contract (`tinygif8324.testnet`).
 * A race id on the newer contract hides the same id on an older one.
 */
export const CONTRACTS: readonly string[] = bountyContracts(NET);

/**
 * The season treasuries (contracts/season): each opens a round on schedule on one of the bounty contracts above, and
 * knows the next one. A treasury that is not on chain yet is simply skipped.
 */
export const SEASONS: readonly string[] = [NET.season];

/**
 * The house as the arena reads it: the plain account that opens one round a day on one safe, the vault, which retires
 * once its round is over and is made again under the same name (packages/race `house.ts`). From it the arena tells
 * when the next round opens, and only when it really will.
 */
export interface House {
  readonly account: string;
  readonly vault: string;
  /** The bounty contract its rounds open on. */
  readonly bounty: string;
  /** The library target every round of it runs, and the vault's code hash; `null` while that code is not known. */
  readonly target: string;
  readonly safeCode: string | null;
  readonly round: HouseRound;
  readonly masks: readonly string[];
}

export const HOUSE: House = {
  account: NET.house,
  vault: NET.vault,
  bounty: NET.bounty,
  target: "live-safe",
  safeCode: NET.safe_code,
  round: NET.round,
  masks: Object.values(NET.masks),
};

/**
 * The arena's own teams: the accounts that open its races, the team, its season treasuries and the house. The home page shows
 * their races first; a race anyone else opened on the arena's contract carries `official: false`.
 */
export const TEAMS: readonly string[] = teams(NET);

/** JSON-RPC for state: the first endpoint, the next only when it is down. */
export const RPCS: readonly string[] = NET.rpc;

/** The public transactions indexer (FastNEAR explorer API): an account's transactions with their receipts. */
export const INDEXER = NET.indexer;

/** Where a person opens a transaction or an account. */
export const EXPLORER = NET.explorer;

export interface MaskProfile {
  /** The page: /mask/<slug>. */
  readonly slug: string;
  readonly name: string;
  readonly account: string;
  /** The model the mask thinks with on NEAR AI Cloud, Private TEE. */
  readonly model: string;
}

/**
 * The model each of the arena's own masks thinks with, as `packages/race/scripts/race.ts` hands them out
 * (`ARENA_MODELS` in `@maskwars/mind`; a test holds the two tables together). ORACLE thought with the base
 * `Qwen/Qwen3.8-27B` until 11.11.2026; a race's own record names the model that really ran it (`MindCost`).
 */
export const MODELS: Readonly<Record<string, string>> = {
  NOVA: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  ONYX: "z-ai/glm-5.3-flash",
  ORACLE: "Qwen/Qwen3.8-27B-abliterated",
};

/**
 * The arena's own masks. Accounts as in the repository variable `MASK_ACCOUNTS` (packages/network: `masks`); models as
 * `packages/race/scripts/race.ts` hands them out (`MODELS`).
 */
export const MASKS: readonly MaskProfile[] = Object.entries(NET.masks).map(([name, account]) => ({
  slug: name.toLowerCase(),
  name,
  account,
  model: MODELS[name] ?? "",
}));

/** A race with mask moves this recent is happening now: LIVE. */
export const ACTIVE_MS = 15 * 60 * 1000;

/** The mask factory (contracts/masks): a person's mask is its direct sub-account, `<name>.<factory>`, and goes on the
 * arena by its name, `KIRA`, with its own page at `/mask/<name>`. */
export const FACTORY = NET.factory;
const PERSON = /^[a-z][a-z0-9]{2,15}$/;

/** The mask's name when `account` is a person's mask from the factory, else null. */
export function personOf(account: string, factory: string = FACTORY): string | null {
  if (!account.endsWith(`.${factory}`)) return null;
  const name = account.slice(0, -factory.length - 1);
  return PERSON.test(name) ? name : null;
}

export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (account: string) => `${EXPLORER}/address/${account}`;
