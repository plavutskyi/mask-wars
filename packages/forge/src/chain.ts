/**
 * The factory as the site reads it: JSON views over NEAR's public JSON-RPC, the first endpoint that answers. Amounts
 * are yoctoNEAR in decimal strings, times nanoseconds, as the contract gives them.
 */

export interface Network {
  readonly id: "testnet" | "mainnet";
  readonly factory: string;
  readonly rpcs: readonly string[];
  readonly explorer: string;
}

/** Where the forge lives. The factory's account holds no key: it changes only through its own code. */
export const TESTNET: Network = {
  id: "testnet",
  factory: "masks.tinygif8324.testnet",
  rpcs: ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"],
  explorer: "https://testnet.nearblocks.io",
};

export interface Catalog {
  readonly models: readonly string[];
  readonly looks: readonly string[];
  readonly styles: readonly string[];
}

export interface FactoryConfig {
  readonly admin: string;
  readonly keeper: string;
  readonly treasury: string;
  readonly arena: string;
  readonly mask_code: { readonly sha256: string; readonly published: boolean };
  readonly strategy_key: string | null;
  readonly catalog: Catalog;
  readonly release_minutes: number;
  readonly masks: number;
  readonly total_brain: string;
  readonly total_held: string;
  readonly min_fuel: string;
  readonly mask_fund: string;
  readonly min_refuel: string;
  readonly race_limit: { readonly default: string; readonly min: string; readonly max: string };
  readonly arena_methods: readonly string[];
  /** A change the admin proposed and anyone applies once its wait is over (`owner.ts`, `waitingChange`). */
  readonly pending?: import("./owner.ts").PendingChange | null;
}

export interface MaskView {
  readonly name: string;
  readonly account: string;
  readonly owner: string;
  readonly look: string;
  readonly model: string;
  readonly style: string;
  readonly strategy: boolean;
  readonly born_ns: string;
  readonly fuel: string;
  readonly brain: string;
  readonly spent: string;
  readonly race_limit: string;
  readonly races: number;
  readonly state: "forging" | "ready" | "racing" | "paused";
  readonly race: { readonly race: string; readonly held: string; readonly armed_ns: string; readonly keys: readonly string[] } | null;
  readonly code: string;
  /** This mask lets others copy its sealed strategy, for `author_bps` of what each copy wins. */
  readonly copyable: boolean;
  readonly author_bps: number;
  /** How many masks copy this one. */
  readonly copies: number;
  /** The mask this one copies (its author's name), and the share it owes, fixed at its forging. */
  readonly copy_of: string | null;
  readonly copy_bps: number;
}

/** A mask that copies another, as `copies_of` lists it. */
export interface CopyChild {
  readonly name: string;
  readonly account: string;
  readonly owner: string;
  readonly bps: number;
}

export class ChainError extends Error {}

/** A view call on the factory: the first RPC that answers decides. A contract that refuses is not retried. */
export async function view<T>(net: Network, method: string, args: object = {}, timeoutMs = 8000): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "maskwars-forge",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "optimistic",
      account_id: net.factory,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  });
  let last: unknown = null;
  for (const url of net.rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      const out = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { cause?: { name?: string } } };
      if (out.error) throw new ChainError(out.error.cause?.name ?? "the factory refused");
      if (out.result?.error) throw new ChainError(out.result.error);
      if (!out.result?.result) throw new Error("no result");
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(out.result.result))) as T;
    } catch (e) {
      if (e instanceof ChainError) throw e;
      last = e;
    }
  }
  throw new Error(`no RPC answered: ${String(last)}`);
}

export const config = (net: Network) => view<FactoryConfig>(net, "config");
export const nameFree = (net: Network, name: string) => view<boolean>(net, "name_free", { name });
export const getMask = (net: Network, name: string) => view<MaskView | null>(net, "get_mask", { name });
export const masksOf = (net: Network, owner: string) => view<MaskView[]>(net, "masks_of", { owner });
/** One page of the masks that copy `name`, in forging order, read from the author's own list on the factory. */
export const copiesOf = (net: Network, name: string, fromIndex = 0, limit = 50) =>
  view<CopyChild[]>(net, "copies_of", { name, from_index: fromIndex, limit });

/** Every mask that copies `name`: its `copies` count, read page by page. */
export async function allCopiesOf(net: Network, name: string, copies: number): Promise<CopyChild[]> {
  const pages = await Promise.all(Array.from({ length: Math.ceil(copies / 50) }, (_, i) => copiesOf(net, name, i * 50, 50)));
  return pages.flat();
}
