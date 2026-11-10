// Reads NEAR straight from JSON-RPC: accounts, blocks, access keys and view calls, at the latest final block or at a
// given height. Two ways to use two endpoints:
// - failover (the default): the second is tried only when the first is down or overloaded. Answers that are the same
//   on every node (no such account, a contract panic) never switch endpoints.
// - cross-check: every read goes to every endpoint at the same block, and an answer counts only when they all give
//   the same one. The block is the lowest final head any of them names, so each of them has it; heads more than
//   `MAX_LAG_BLOCKS` apart are no common head and stop the check like any other disagreement. A node that is down or
//   no longer keeps a block sits that read out, and the tally says so: the caller decides what a read one node alone
//   answered is worth (MASK CHECK warns).

export const TESTNET_RPCS = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"] as const;

/** Two independent providers, FastNEAR and dRPC. */
export const MAINNET_RPCS = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"] as const;

/** FastNEAR's regular mainnet node keeps about 17 h of blocks; its archival node answers for older ones. */
export const MAINNET_ARCHIVAL: Readonly<Record<string, string>> = {
  "https://rpc.mainnet.fastnear.com": "https://archival-rpc.mainnet.fastnear.com",
};

/**
 * In cross-check mode, how far apart the endpoints' final heads may be: about a minute of blocks. Further apart, one
 * of them is stale or one is ahead of the chain, and nothing says which, so there is no head to read at.
 */
export const MAX_LAG_BLOCKS = 100;

/** A code hash of 32 zero bytes: the account has no contract. */
export const NO_CODE = "11111111111111111111111111111111";

export type At = { finality: "final" } | { block_id: number };

export type ChainErrorKind =
  | "transport" // the endpoint did not answer
  | "server" // the endpoint answered with an error of its own: overload, not synced, 5xx
  | "unknown_account"
  | "unknown_block" // never produced, or already garbage-collected on this node
  | "unknown_key"
  | "contract" // the view call panicked, or the account has no such method or no code
  | "handler" // a request the node refuses as such
  | "disagree"; // cross-check: two endpoints gave different answers to the same read at the same block

export class ChainError extends Error {
  readonly endpoint: string;
  readonly kind: ChainErrorKind;

  constructor(endpoint: string, kind: ChainErrorKind, message: string, options?: ErrorOptions) {
    super(`${endpoint}: ${message}`, options);
    this.name = "ChainError";
    this.endpoint = endpoint;
    this.kind = kind;
  }
}

export interface AccountInfo {
  amount: string;
  locked: string;
  /** The contract's code hash; `NO_CODE` for a plain account. A global contract's hash when the account uses one. */
  codeHash: string;
  storageUsage: number;
  blockHeight: number;
  blockHash: string;
}

export interface BlockInfo {
  height: number;
  hash: string;
  /** Nanoseconds since the Unix epoch, exact. */
  timestampNs: bigint;
}

export type KeyPermission =
  | { kind: "full_access" }
  | { kind: "function_call"; receiver: string; methods: string[]; allowance: string | null };

export interface ChainReaderOptions {
  endpoints?: readonly string[];
  /** Per endpoint, an archival node of the same provider: asked only for a block that endpoint no longer keeps. */
  archival?: Readonly<Record<string, string>>;
  /** Ask every endpoint each read, at one block, and take the answer only when they all match. Default: failover. */
  crossCheck?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** How one check's reads were answered in cross-check mode (`ChainReader.tracked()`). */
export interface ReadTally {
  /** Reads that got an answer. */
  reads: number;
  /** Reads every endpoint answered, all alike. */
  agreed: number;
  /** An endpoint that sat a read out → what it said, the latest. */
  missing: Map<string, string>;
  /** Endpoints that were down → why: not asked again during this check, so one hung node costs one timeout, not ten. */
  down: Map<string, string>;
}

type Outcome = { endpoint: string; result: Record<string, unknown>; print: string } | { endpoint: string; error: ChainError };

interface RpcErrorBody {
  name?: string;
  cause?: { name?: string; info?: unknown };
  code?: number;
  message?: string;
  data?: unknown;
}

/** Errors the next endpoint may not have: it may be synced, archival or less busy. */
const RETRY_ELSEWHERE: readonly ChainErrorKind[] = ["transport", "server", "unknown_block"];

const SERVER_CAUSES = new Set(["NO_SYNCED_BLOCKS", "UNAVAILABLE_SHARD", "INTERNAL_ERROR", "TIMEOUT_ERROR", "NOT_SYNCED_YET"]);

function classify(error: RpcErrorBody): { kind: ChainErrorKind; detail: string } {
  const cause = error.cause?.name ?? error.name ?? "UNKNOWN";
  const detail = `${cause}${typeof error.data === "string" ? `: ${error.data}` : ""}`;
  if (cause === "UNKNOWN_ACCOUNT") return { kind: "unknown_account", detail };
  if (cause === "UNKNOWN_BLOCK" || cause === "GARBAGE_COLLECTED_BLOCK") return { kind: "unknown_block", detail };
  if (cause === "UNKNOWN_ACCESS_KEY") return { kind: "unknown_key", detail };
  if (cause === "CONTRACT_EXECUTION_ERROR" || cause === "NO_CONTRACT_CODE") return { kind: "contract", detail };
  if (SERVER_CAUSES.has(cause) || error.name === "INTERNAL_ERROR") return { kind: "server", detail };
  return { kind: "handler", detail };
}

/** Older nodes answer a failed `query` with a result that only carries an `error` string. */
function classifyLegacy(message: string): ChainErrorKind {
  if (/^account .* does not exist while viewing/.test(message)) return "unknown_account";
  if (/^access key .* does not exist while viewing/.test(message)) return "unknown_key";
  return "contract";
}

function decodeBytes(bytes: number[]): string {
  return Buffer.from(bytes).toString("utf8");
}

export class ChainReader {
  readonly endpoints: readonly string[];
  readonly crossCheck: boolean;
  readonly #options: ChainReaderOptions;
  readonly #archival: Readonly<Record<string, string>>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #tally: ReadTally | null = null;

  constructor(options: ChainReaderOptions = {}) {
    this.endpoints = options.endpoints ?? TESTNET_RPCS;
    if (this.endpoints.length === 0) throw new Error("at least one RPC endpoint");
    this.crossCheck = options.crossCheck ?? false;
    this.#options = options;
    this.#archival = options.archival ?? {};
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 8_000;
  }

  /** The same reader with a tally of its own: one check's reads, counted apart from every other check's. */
  tracked(): ChainReader {
    const r = new ChainReader(this.#options);
    r.#tally = { reads: 0, agreed: 0, missing: new Map(), down: new Map() };
    return r;
  }

  /** How this reader's reads were answered; `null` unless it came from `tracked()`. */
  get tally(): ReadTally | null {
    return this.#tally;
  }

  /** One JSON-RPC call: failover, or every endpoint at one block in cross-check mode. */
  async rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    if (!this.crossCheck) return this.#failover(method, params);
    if (isFinal(params)) {
      // Two nodes rarely sit on the same final head: pin the read to one height both of them have.
      const { finality: _final, ...rest } = params;
      return this.#agreed(method, { ...rest, block_id: await this.#finalHeight() });
    }
    return this.#agreed(method, params);
  }

  /** Moves to the next endpoint only on errors another node may not have. */
  async #failover(method: string, params: unknown): Promise<Record<string, unknown>> {
    const failures: ChainError[] = [];
    for (const endpoint of this.endpoints) {
      try {
        return await this.#ask(endpoint, method, params);
      } catch (error) {
        const e = asChainError(endpoint, error);
        if (!RETRY_ELSEWHERE.includes(e.kind)) throw e;
        failures.push(e);
      }
    }
    throw allFailed(failures);
  }

  /** The endpoints still worth asking in this check. */
  #live(): readonly string[] {
    const down = this.#tally?.down;
    return down ? this.endpoints.filter((e) => !down.has(e)) : this.endpoints;
  }

  #noteDown(e: ChainError, endpoint: string): void {
    if (e.kind === "transport" || e.kind === "server") this.#tally?.down.set(endpoint, e.message);
  }

  /** The endpoints that went down earlier in this check, as the errors they gave. */
  #earlier(live: readonly string[]): ChainError[] {
    return this.endpoints.filter((e) => !live.includes(e)).map((e) => new ChainError("rpc", "transport", this.#tally?.down.get(e) ?? `${e}: down`));
  }

  /**
   * The lowest final head among the endpoints that answer: every one of them has that block, so none can pull the
   * check to a height the others have not reached. Heads more than `MAX_LAG_BLOCKS` apart are a disagreement: the
   * endpoint ahead may have made its head up, the one behind may serve an old chain, and one answer cannot tell.
   */
  async #finalHeight(): Promise<number> {
    const live = this.#live();
    const heads = await Promise.all(
      live.map(async (endpoint) => {
        try {
          return { endpoint, height: parseBlock(await this.#call(endpoint, "block", { finality: "final" })).height };
        } catch (error) {
          const e = asChainError(endpoint, error);
          this.#noteDown(e, endpoint);
          return { endpoint, error: e };
        }
      }),
    );
    const known = heads.flatMap((h) => (typeof h.height === "number" ? [{ endpoint: h.endpoint, height: h.height }] : []));
    if (known.length === 0) throw allFailed([...heads.flatMap((h) => ("error" in h ? [h.error] : [])), ...this.#earlier(live)]);
    const heights = known.map((h) => h.height);
    const low = Math.min(...heights);
    const top = Math.max(...heights);
    if (top - low > MAX_LAG_BLOCKS) {
      const said = known.map((h) => `${hostOf(h.endpoint)} ${h.height}`).join(" vs ");
      throw new ChainError("rpc", "disagree", `final head: ${said}, ${top - low} blocks apart`);
    }
    return low;
  }

  /** Every endpoint, the same read: the answer when all that answer agree, a `disagree` error when they do not. */
  async #agreed(method: string, params: unknown): Promise<Record<string, unknown>> {
    const live = this.#live();
    const outcomes: Outcome[] = await Promise.all(
      live.map(async (endpoint): Promise<Outcome> => {
        try {
          const result = await this.#ask(endpoint, method, params);
          return { endpoint, result, print: fingerprint(method, params, result) };
        } catch (error) {
          const e = asChainError(endpoint, error);
          this.#noteDown(e, endpoint);
          return { endpoint, error: e };
        }
      }),
    );
    const answers = outcomes.filter((o) => !("error" in o) || !RETRY_ELSEWHERE.includes(o.error.kind));
    const sat = outcomes.filter((o) => !answers.includes(o));
    if (answers.length === 0) {
      throw allFailed([...sat.flatMap((o) => ("error" in o ? [o.error] : [])), ...this.#earlier(live)]);
    }
    const prints = answers.map((o) => ("error" in o ? `error ${o.error.kind}` : o.print));
    if (new Set(prints).size > 1) {
      const said = answers.map((o, i) => `${hostOf(o.endpoint)} ${short(prints[i]!)}`).join(" vs ");
      throw new ChainError("rpc", "disagree", `${describe(method, params)}: ${said}`);
    }
    const t = this.#tally;
    if (t) {
      t.reads++;
      if (answers.length === this.endpoints.length && this.endpoints.length > 1) t.agreed++;
      for (const o of sat) if ("error" in o) t.missing.set(o.endpoint, o.error.message);
      for (const e of this.endpoints) if (!live.includes(e)) t.missing.set(e, t.down.get(e) ?? `${e}: down`);
    }
    const first = answers[0]!;
    if ("error" in first) throw first.error;
    return first.result;
  }

  /** One endpoint; for a block it no longer keeps, the same provider's archival node. */
  async #ask(endpoint: string, method: string, params: unknown): Promise<Record<string, unknown>> {
    try {
      return await this.#call(endpoint, method, params);
    } catch (error) {
      const archive = this.#archival[endpoint];
      if (!archive || !(error instanceof ChainError) || error.kind !== "unknown_block") throw error;
      return await this.#call(archive, method, params);
    }
  }

  /** The latest final block. */
  async head(): Promise<BlockInfo> {
    return parseBlock(await this.rpc("block", { finality: "final" }));
  }

  /** A block by height; `null` when no node has it (skipped height or garbage-collected). */
  async block(height: number): Promise<BlockInfo | null> {
    try {
      return parseBlock(await this.rpc("block", { block_id: height }));
    } catch (error) {
      if (error instanceof ChainError && error.kind === "unknown_block") return null;
      throw error;
    }
  }

  /** The account at `at`; `null` when it does not exist there. */
  async account(accountId: string, at: At = { finality: "final" }): Promise<AccountInfo | null> {
    let r: Record<string, unknown>;
    try {
      r = await this.rpc("query", { request_type: "view_account", account_id: accountId, ...at });
    } catch (error) {
      if (error instanceof ChainError && error.kind === "unknown_account") return null;
      throw error;
    }
    if (typeof r["amount"] !== "string" || typeof r["code_hash"] !== "string" || typeof r["block_height"] !== "number") {
      throw new ChainError("rpc", "server", "view_account returned a wrong shape");
    }
    const global = typeof r["global_contract_hash"] === "string" ? (r["global_contract_hash"] as string) : null;
    return {
      amount: r["amount"],
      locked: typeof r["locked"] === "string" ? r["locked"] : "0",
      codeHash: global ?? r["code_hash"],
      storageUsage: typeof r["storage_usage"] === "number" ? r["storage_usage"] : 0,
      blockHeight: r["block_height"],
      blockHash: typeof r["block_hash"] === "string" ? r["block_hash"] : "",
    };
  }

  /** A view call; the contract's JSON answer. */
  async view<T>(contractId: string, method: string, args: unknown, at: At = { finality: "final" }): Promise<T> {
    const r = await this.rpc("query", {
      request_type: "call_function",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      ...at,
    });
    if (!Array.isArray(r["result"])) throw new ChainError("rpc", "server", `${method}: no result bytes`);
    const text = decodeBytes(r["result"] as number[]);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ChainError("rpc", "contract", `${method}: the answer is not JSON`, { cause: error });
    }
  }

  /** What one access key may do; `null` when the account has no such key. */
  async accessKey(accountId: string, publicKey: string, at: At = { finality: "final" }): Promise<KeyPermission | null> {
    let r: Record<string, unknown>;
    try {
      r = await this.rpc("query", { request_type: "view_access_key", account_id: accountId, public_key: publicKey, ...at });
    } catch (error) {
      if (error instanceof ChainError && (error.kind === "unknown_key" || error.kind === "unknown_account")) return null;
      throw error;
    }
    const p = r["permission"];
    if (p === "FullAccess") return { kind: "full_access" };
    const fc = (p as { FunctionCall?: { receiver_id?: unknown; method_names?: unknown; allowance?: unknown } } | null)?.FunctionCall;
    if (!fc || typeof fc.receiver_id !== "string" || !Array.isArray(fc.method_names)) {
      throw new ChainError("rpc", "server", "view_access_key returned a wrong shape");
    }
    return {
      kind: "function_call",
      receiver: fc.receiver_id,
      methods: fc.method_names.filter((m): m is string => typeof m === "string"),
      allowance: typeof fc.allowance === "string" ? fc.allowance : null,
    };
  }

  async #call(endpoint: string, method: string, params: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "maskwars-check", method, params }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ChainError(endpoint, "transport", transportMessage(error), { cause: error });
    }
    let json: { result?: Record<string, unknown>; error?: RpcErrorBody };
    try {
      // A body of `null` is JSON and no answer: it reads as an empty result below, like any body without one.
      json = ((await response.json()) ?? {}) as typeof json;
    } catch (error) {
      throw new ChainError(endpoint, "server", `HTTP ${response.status}, invalid JSON`, { cause: error });
    }
    if (json.error) {
      // nearcore names every error it gives; an error without a name is the provider's own (a rate limit, a plan
      // limit, a deprecation notice), not an answer about the chain.
      if (typeof json.error.name !== "string") {
        throw new ChainError(endpoint, "server", `HTTP ${response.status}: ${String(json.error.message ?? json.error.code ?? "error").slice(0, 160)}`);
      }
      const { kind, detail } = classify(json.error);
      throw new ChainError(endpoint, kind, detail);
    }
    if (!response.ok) throw new ChainError(endpoint, "server", `HTTP ${response.status}`);
    const result = json.result;
    if (!result || typeof result !== "object") throw new ChainError(endpoint, "server", "empty result");
    if (typeof result["error"] === "string") {
      const message = result["error"];
      throw new ChainError(endpoint, classifyLegacy(message), message);
    }
    return result;
  }
}

function parseBlock(r: Record<string, unknown>): BlockInfo {
  const h = r["header"] as { height?: unknown; hash?: unknown; timestamp_nanosec?: unknown } | undefined;
  if (!h || typeof h.height !== "number" || typeof h.hash !== "string" || typeof h.timestamp_nanosec !== "string") {
    throw new ChainError("rpc", "server", "block returned a wrong shape");
  }
  return { height: h.height, hash: h.hash, timestampNs: BigInt(h.timestamp_nanosec) };
}

function isFinal(params: unknown): params is Record<string, unknown> & { finality: "final" } {
  return typeof params === "object" && params !== null && (params as Record<string, unknown>)["finality"] === "final";
}

function asChainError(endpoint: string, error: unknown): ChainError {
  return error instanceof ChainError ? error : new ChainError(endpoint, "transport", String(error), { cause: error });
}

/** What every endpoint failing means: an answer when none of them has the block, an outage otherwise. */
function allFailed(failures: readonly ChainError[]): ChainError {
  if (failures.length > 0 && failures.every((f) => f.kind === "unknown_block")) return failures[failures.length - 1]!;
  const outage = failures.find((f) => f.kind !== "unknown_block") ?? failures[0];
  if (!outage) return new ChainError("rpc", "transport", "no endpoint to ask");
  return new ChainError("rpc", outage.kind, `every endpoint failed: ${failures.map((f) => f.message).join("; ")}`);
}

/**
 * What two honest nodes must say alike about one read at one block: the fields the reader uses, plus the block hash,
 * so a node on another fork or another height cannot pass. Fields a newer node adds do not count.
 */
function fingerprint(method: string, params: unknown, r: Record<string, unknown>): string {
  const kind = method === "query" ? String((params as Record<string, unknown> | null)?.["request_type"]) : method;
  const pick = (...keys: string[]) => JSON.stringify(keys.map((k) => r[k] ?? null));
  if (kind === "block") {
    const b = parseBlock(r);
    return JSON.stringify([b.height, b.hash, b.timestampNs.toString()]);
  }
  if (kind === "view_account") {
    return JSON.stringify([r["block_hash"], r["amount"], r["locked"], r["global_contract_hash"] ?? r["code_hash"], r["storage_usage"]]);
  }
  if (kind === "call_function") return pick("block_hash", "result");
  if (kind === "view_access_key") return pick("block_hash", "permission");
  return JSON.stringify(r);
}

function describe(method: string, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  const at = typeof p["block_id"] === "number" ? ` at block ${p["block_id"]}` : "";
  if (method === "block") return `block${at}`;
  const what = [p["request_type"], p["account_id"], p["method_name"]].filter((x) => typeof x === "string").join(" ");
  return `${what || method}${at}`;
}

export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

function short(print: string): string {
  return print.length > 120 ? `${print.slice(0, 117)}...` : print;
}

/** `fetch failed` says nothing; the cause says what happened (refused, reset, DNS, proxy). */
function transportMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : null;
  return cause ? `${error.message} (${cause})` : error.message;
}

export function blockTime(block: BlockInfo): Date {
  return new Date(Number(block.timestampNs / 1_000_000n));
}
