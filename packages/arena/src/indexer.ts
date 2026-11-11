// An account's transactions from the public indexer (FastNEAR explorer API, no key), each with every receipt it set
// off: calls, transfers, logs and return values. Transactions are final and never change, so each is fetched once.

import { INDEXER } from "./config.ts";

export interface Call {
  readonly method: string;
  /** The JSON arguments, or null when they are not JSON. */
  readonly args: Record<string, unknown> | null;
  readonly deposit: bigint;
}

export interface Receipt {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly at: number;
  readonly calls: readonly Call[];
  /** NEAR this receipt moved by plain transfers. */
  readonly transfer: bigint;
  readonly logs: readonly string[];
  readonly ok: boolean;
  /** The decoded JSON return value, when there is one. */
  readonly value: unknown;
}

export interface Tx {
  readonly hash: string;
  readonly signer: string;
  readonly receiver: string;
  readonly at: number;
  readonly height: number;
  readonly calls: readonly Call[];
  /** The transaction's own call went through. */
  readonly ok: boolean;
  readonly receipts: readonly Receipt[];
}

export interface AccountTx {
  readonly hash: string;
  readonly height: number;
  readonly at: number;
  /** The account received a function call in this transaction. */
  readonly call: boolean;
  /** False when the indexer says the transaction failed (`is_success`); a row without that word counts as gone through. */
  readonly ok?: boolean;
}

export class IndexerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IndexerError";
  }
}

export interface IndexerOptions {
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Hashes per `/v0/transactions` request. */
const BATCH = 20;
/** Pages of an account's history read at most. */
const MAX_PAGES = 20;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Nanoseconds as a number or a decimal string → milliseconds. */
function ms(ns: unknown): number {
  if (typeof ns === "string" && /^\d+$/.test(ns)) return Number(BigInt(ns) / 1_000_000n);
  if (typeof ns === "number" && Number.isFinite(ns)) return Math.round(ns / 1e6);
  return 0;
}

function big(v: unknown): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return 0n;
}

function decodeJson(base64: unknown): unknown {
  if (typeof base64 !== "string" || base64 === "") return undefined;
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function parseActions(actions: unknown): { calls: Call[]; transfer: bigint } {
  const calls: Call[] = [];
  let transfer = 0n;
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!isObj(a)) continue;
    const fc = a["FunctionCall"];
    if (isObj(fc)) {
      const args = decodeJson(fc["args"]);
      calls.push({ method: str(fc["method_name"]) ?? "", args: isObj(args) ? args : null, deposit: big(fc["deposit"]) });
    }
    const t = a["Transfer"];
    if (isObj(t)) transfer += big(t["deposit"]);
  }
  return { calls, transfer };
}

const failed = (status: unknown) => isObj(status) && "Failure" in status;

/** One transaction of `/v0/transactions` as the arena needs it. */
export function parseTx(raw: unknown): Tx | null {
  if (!isObj(raw)) return null;
  const t = raw["transaction"];
  const o = raw["execution_outcome"];
  if (!isObj(t) || !isObj(o)) return null;
  const hash = str(t["hash"]);
  const signer = str(t["signer_id"]);
  const receiver = str(t["receiver_id"]);
  if (!hash || !signer || !receiver) return null;
  const outcome = isObj(o["outcome"]) ? o["outcome"] : {};
  const status = outcome["status"];
  const firstReceipt = isObj(status) ? str(status["SuccessReceiptId"]) : null;

  const receipts: Receipt[] = [];
  for (const r of Array.isArray(raw["receipts"]) ? raw["receipts"] : []) {
    if (!isObj(r) || !isObj(r["receipt"]) || !isObj(r["execution_outcome"])) continue;
    const rc = r["receipt"];
    const ro = r["execution_outcome"];
    const out = isObj(ro["outcome"]) ? ro["outcome"] : {};
    const body = isObj(rc["receipt"]) && isObj(rc["receipt"]["Action"]) ? rc["receipt"]["Action"] : null;
    const { calls, transfer } = parseActions(body?.["actions"]);
    const st = out["status"];
    receipts.push({
      id: str(rc["receipt_id"]) ?? str(ro["id"]) ?? "",
      from: str(rc["predecessor_id"]) ?? "",
      to: str(rc["receiver_id"]) ?? "",
      at: ms(ro["block_timestamp"] ?? rc["block_timestamp"]),
      calls,
      transfer,
      logs: Array.isArray(out["logs"]) ? out["logs"].filter((l): l is string => typeof l === "string") : [],
      ok: !failed(st),
      value: isObj(st) ? decodeJson(st["SuccessValue"]) : undefined,
    });
  }

  // The transaction's own call: the receipt it turned into. A failed transaction never got that far.
  const own = firstReceipt ? receipts.find((r) => r.id === firstReceipt) : undefined;
  const ok = !failed(status) && (own ? own.ok : true);
  return {
    hash,
    signer,
    receiver,
    at: ms(o["block_timestamp"]),
    height: typeof o["block_height"] === "number" ? o["block_height"] : 0,
    calls: parseActions(t["actions"]).calls,
    ok,
    receipts,
  };
}

export class Indexer {
  readonly base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: IndexerOptions = {}) {
    this.base = (options.base ?? INDEXER).replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async #post(path: string, body: unknown): Promise<Json> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new IndexerError(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!res.ok) throw new IndexerError(`${path}: HTTP ${res.status}`);
    const json = (await res.json().catch(() => null)) as unknown;
    if (!isObj(json)) throw new IndexerError(`${path}: not a JSON object`);
    return json;
  }

  /** Every transaction that touched `account`, newest first. An account that does not exist has none. */
  async accountTxs(account: string): Promise<AccountTx[]> {
    const seen = new Map<string, AccountTx>();
    let before: number | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Json = { account_id: account };
      if (before !== null) body["max_block_height"] = before;
      let json: Json;
      try {
        json = await this.#post("/v0/account", body);
      } catch (error) {
        // The first page is the answer; a later page that fails only leaves the oldest history out.
        if (page === 0) throw error;
        break;
      }
      const rows = Array.isArray(json["account_txs"]) ? json["account_txs"] : [];
      let fresh = 0;
      let lowest = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        if (!isObj(r)) continue;
        const hash = str(r["transaction_hash"]);
        const height = typeof r["tx_block_height"] === "number" ? r["tx_block_height"] : 0;
        if (!hash) continue;
        lowest = Math.min(lowest, height);
        if (seen.has(hash)) continue;
        seen.set(hash, { hash, height, at: ms(r["tx_block_timestamp"]), call: r["is_function_call"] === true, ok: r["is_success"] !== false });
        fresh += 1;
      }
      const total = typeof json["txs_count"] === "number" ? json["txs_count"] : seen.size;
      if (fresh === 0 || seen.size >= total || !Number.isFinite(lowest) || lowest <= 1) break;
      before = lowest - 1;
    }
    return [...seen.values()].sort((a, b) => b.height - a.height);
  }

  /** The transactions with these hashes, in the order asked; a hash the indexer does not know is left out. */
  async transactions(hashes: readonly string[]): Promise<Tx[]> {
    const found = new Map<string, Tx>();
    for (let i = 0; i < hashes.length; i += BATCH) {
      const json = await this.#post("/v0/transactions", { tx_hashes: hashes.slice(i, i + BATCH) });
      for (const raw of Array.isArray(json["transactions"]) ? json["transactions"] : []) {
        const tx = parseTx(raw);
        if (tx) found.set(tx.hash, tx);
      }
    }
    return hashes.flatMap((h) => {
      const tx = found.get(h);
      return tx ? [tx] : [];
    });
  }
}
