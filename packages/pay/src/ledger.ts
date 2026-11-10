import { base64, utf8 } from "./codec.ts";
import { INTENTS } from "./intent.ts";

/**
 * A vault's money, read straight from NEAR Intents (`intents.near` on NEAR mainnet) over public JSON-RPC: balances are
 * NEP-245 multi-token balances of the vault's account. There is no NEAR Intents on testnet.
 */

export const MAINNET_RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org"] as const;

export class LedgerError extends Error {
  override name = "LedgerError";
}

export interface LedgerOptions {
  readonly rpcs?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class Ledger {
  private readonly rpcs: readonly string[];
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: LedgerOptions = {}) {
    this.rpcs = o.rpcs?.length ? o.rpcs : MAINNET_RPCS;
    this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = o.timeoutMs ?? 8_000;
  }

  /** Units of each of `assets` the account holds, in the same order. */
  async balances(account: string, assets: readonly string[]): Promise<bigint[]> {
    if (assets.length === 0) return [];
    const out = await this.view<string[]>("mt_batch_balance_of", { account_id: account, token_ids: assets });
    if (!Array.isArray(out) || out.length !== assets.length || !out.every((v) => typeof v === "string" && /^\d+$/.test(v))) {
      throw new LedgerError("unexpected balances");
    }
    return out.map((v) => BigInt(v));
  }

  /** Whether `publicKey` (`ed25519:…`) may sign intents for `account`: a named NEAR account adds its key once. */
  async hasKey(account: string, publicKey: string): Promise<boolean> {
    const out = await this.view<boolean>("has_public_key", { account_id: account, public_key: publicKey });
    if (typeof out !== "boolean") throw new LedgerError("unexpected answer");
    return out;
  }

  private async view<T>(method: string, args: unknown): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "maskwars",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: INTENTS, method_name: method, args_base64: base64(utf8(JSON.stringify(args))) },
    });
    let last: unknown = null;
    for (const rpc of this.rpcs) {
      try {
        const res = await this.doFetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new LedgerError(`${rpc} answered ${res.status}`);
        const json = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; cause?: { name?: string } } };
        if (json.error) throw new LedgerError(json.error.cause?.name ?? json.error.message ?? "rpc error");
        if (json.result?.error) throw new LedgerError(json.result.error);
        const raw = json.result?.result;
        if (!Array.isArray(raw)) throw new LedgerError("no result");
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw))) as T;
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new LedgerError("no RPC answered");
  }
}

/** For tests: the bytes a view call returns, as NEAR's RPC encodes them. */
export function viewResult(value: unknown): number[] {
  return [...utf8(JSON.stringify(value))];
}
