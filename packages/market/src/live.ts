// MASK CHECK read live from NEAR, wired the way `GET /api/check` wires it: the reader and the shared list of the
// account's own network. On mainnet that is two independent RPC providers that must agree on every read.
import { type Network, type ReaderForOptions, maskCheck, readerFor, sharedLists } from "@maskwars/check";
import type { CheckFn } from "./service.ts";

/**
 * The check a paid call runs. `env` (pass `process.env`) may replace the RPC endpoints, by the same variables as
 * everywhere else: `MASKCHECK_MAINNET_RPC` and `MASKCHECK_RPC`, comma-separated.
 */
export function liveCheck(options: Pick<ReaderForOptions, "env" | "fetch" | "timeoutMs"> = {}): CheckFn {
  const readers: Record<Network, ReturnType<typeof readerFor>> = { mainnet: readerFor("mainnet", options), testnet: readerFor("testnet", options) };
  return (account, network) => maskCheck(account, { network, reader: readers[network], list: sharedLists[network] });
}
