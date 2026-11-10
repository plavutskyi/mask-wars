// MASK CHECK: a question before an agent pays. allow, warn or block, with reasons read from the chain and the arena.
import listJson from "../list.json" with { type: "json" };
import mainnetListJson from "../list.mainnet.json" with { type: "json" };
import { type SharedList, parseList } from "./list.ts";
import type { Network } from "./network.ts";

export * from "./account.ts";
export * from "./agent.ts";
export * from "./check.ts";
export * from "./list.ts";
export * from "./network.ts";
export * from "./rpc.ts";

/** The testnet shared list as it is in this repo (`list.json`). */
export const sharedList = parseList(listJson);

/** The mainnet shared list as it is in this repo (`list.mainnet.json`). */
export const mainnetList = parseList(mainnetListJson);

/** The shared list of each network. */
export const sharedLists: Readonly<Record<Network, SharedList>> = { testnet: sharedList, mainnet: mainnetList };
