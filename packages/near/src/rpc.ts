// Читання NEAR через JSON-RPC: баланси Intents (`mt_balance_of`, `mt_batch_balance_of` на intents.near) і view-виклики контракту.
// Два незалежних RPC: основний і запасний. Детерміновані відмови (немає акаунта, паніка контракту) не перемикають RPC.
import { INTENTS_CONTRACT } from "./assets.ts";

export const DEFAULT_RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org"] as const;

export interface NearRpcOptions {
  endpoints?: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** `final` для грошей. */
  finality?: "final" | "optimistic";
  /** Перечитати той самий блок на другому RPC і вимагати збігу. */
  crossCheck?: boolean;
}

export interface ViewResult<T> {
  value: T;
  blockHeight: number;
  endpoint: string;
}

export class RpcError extends Error {
  readonly endpoint: string;
  readonly kind: "transport" | "server" | "handler" | "contract" | "mismatch";

  constructor(endpoint: string, kind: RpcError["kind"], message: string, options?: ErrorOptions) {
    super(`${endpoint}: ${message}`, options);
    this.name = "RpcError";
    this.endpoint = endpoint;
    this.kind = kind;
  }
}

interface QueryResponse {
  result?: { result?: number[]; block_height: number; error?: string; logs?: string[] };
  error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown };
}

export class NearRpc {
  readonly endpoints: readonly string[];
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #finality: "final" | "optimistic";
  readonly #crossCheck: boolean;

  constructor(options: NearRpcOptions = {}) {
    this.endpoints = options.endpoints ?? DEFAULT_RPCS;
    if (this.endpoints.length === 0) throw new Error("at least one RPC endpoint");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#finality = options.finality ?? "final";
    this.#crossCheck = options.crossCheck ?? false;
  }

  async view<T>(contractId: string, method: string, args: unknown): Promise<ViewResult<T>> {
    const failures: RpcError[] = [];
    for (const [index, endpoint] of this.endpoints.entries()) {
      try {
        const first = await this.#query<T>(endpoint, contractId, method, args, { finality: this.#finality });
        if (this.#crossCheck) await this.#verify(first, index, contractId, method, args);
        return first;
      } catch (error) {
        if (error instanceof RpcError && (error.kind === "handler" || error.kind === "contract" || error.kind === "mismatch")) throw error;
        failures.push(error instanceof RpcError ? error : new RpcError(endpoint, "transport", String(error), { cause: error }));
      }
    }
    throw new AggregateError(failures, `all NEAR RPC endpoints failed: ${failures.map((f) => f.message).join("; ")}`);
  }

  /** Баланс одного токена акаунта в Intents, мінімальні одиниці. */
  async mtBalanceOf(accountId: string, tokenId: string, contractId = INTENTS_CONTRACT): Promise<ViewResult<string>> {
    return this.view<string>(contractId, "mt_balance_of", { account_id: accountId, token_id: tokenId });
  }

  /** Баланси кількох токенів одним викликом, у тому ж порядку. */
  async mtBatchBalanceOf(accountId: string, tokenIds: readonly string[], contractId = INTENTS_CONTRACT): Promise<ViewResult<string[]>> {
    const result = await this.view<string[]>(contractId, "mt_batch_balance_of", { account_id: accountId, token_ids: tokenIds });
    if (!Array.isArray(result.value) || result.value.length !== tokenIds.length) {
      throw new RpcError(result.endpoint, "contract", "mt_batch_balance_of returned a wrong shape");
    }
    return result;
  }

  async #verify<T>(first: ViewResult<T>, index: number, contractId: string, method: string, args: unknown): Promise<void> {
    const other = this.endpoints.find((_, i) => i !== index);
    if (!other) return;
    let second: ViewResult<T>;
    try {
      second = await this.#query<T>(other, contractId, method, args, { block_id: first.blockHeight });
    } catch (error) {
      // Другий RPC ще не має блоку або лежить: цифри першого не підтверджені, тож не віддаємо їх.
      throw new RpcError(other, "mismatch", `cross-check failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (JSON.stringify(second.value) !== JSON.stringify(first.value)) {
      throw new RpcError(other, "mismatch", `cross-check disagrees at block ${first.blockHeight}`);
    }
  }

  async #query<T>(endpoint: string, contractId: string, method: string, args: unknown, at: { finality: string } | { block_id: number }): Promise<ViewResult<T>> {
    let response: Response;
    let json: QueryResponse;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "maskwars",
          method: "query",
          params: {
            request_type: "call_function",
            ...at,
            account_id: contractId,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
          },
        }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new RpcError(endpoint, "transport", error instanceof Error ? error.message : String(error), { cause: error });
    }
    if (!response.ok) throw new RpcError(endpoint, "server", `HTTP ${response.status}`);
    try {
      json = (await response.json()) as QueryResponse;
    } catch (error) {
      throw new RpcError(endpoint, "server", "invalid JSON", { cause: error });
    }
    if (json.error) {
      const cause = json.error.cause?.name ?? json.error.name ?? "UNKNOWN";
      const kind = json.error.name === "HANDLER_ERROR" && cause !== "UNAVAILABLE_SHARD" && cause !== "NO_SYNCED_BLOCKS" && cause !== "UNKNOWN_BLOCK" ? "handler" : "server";
      throw new RpcError(endpoint, kind, `${cause}: ${json.error.message ?? ""}`.trim());
    }
    const result = json.result;
    if (!result) throw new RpcError(endpoint, "server", "empty result");
    if (result.error) throw new RpcError(endpoint, "contract", result.error);
    if (!Array.isArray(result.result)) throw new RpcError(endpoint, "server", "no result bytes");
    const text = Buffer.from(result.result).toString("utf8");
    return { value: JSON.parse(text) as T, blockHeight: result.block_height, endpoint };
  }
}
