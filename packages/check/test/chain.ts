// A testnet node in memory. Every answer has the exact shape nearcore's JSON-RPC gives: `block` headers with
// `timestamp_nanosec`, `view_account`, `call_function` result bytes, `view_access_key` permissions, and HANDLER_ERROR
// bodies for an unknown account, an unknown or garbage-collected block, a missing key and a contract panic.

export const HEAD = 230_000_000;
/** Testnet makes a block about every 0.6 s. */
export const NS_PER_BLOCK = 600_000_000n;
export const HEAD_TS = 1_793_984_400_000_000_000n; // 2026-11-06T17:00:00Z

export type View = (args: Record<string, unknown>, height: number) => unknown;

export interface AccountState {
  amount: string;
  code_hash: string;
  storage_usage: number;
}

export class FakeNode {
  /** The node's final head. Every node in a test shares one chain: a block's hash and time depend on its height only. */
  head = HEAD;
  /** Heights the node never produced (skipped by the block producer). */
  readonly skipped = new Set<number>();
  /** The oldest height the node still keeps; older ones are garbage-collected. */
  gcBelow = HEAD - 300_000;
  /** Account → states, each from a height on; `null` means it does not exist from that height. */
  readonly accounts = new Map<string, { from: number; state: AccountState | null }[]>();
  readonly views = new Map<string, View>();
  readonly keys = new Map<string, unknown>();
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Answer every request with an HTTP error instead. */
  down: number | null = null;
  /** Answer `call_function` failures the way older nodes did: a result that holds only an `error` string. */
  legacyErrors = false;

  setAccount(id: string, from: number, state: AccountState | null): this {
    const list = this.accounts.get(id) ?? [];
    list.push({ from, state });
    list.sort((a, b) => a.from - b.from);
    this.accounts.set(id, list);
    return this;
  }

  view(contract: string, method: string, fn: View): this {
    this.views.set(`${contract}/${method}`, fn);
    return this;
  }

  fetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> };
    this.calls.push(body);
    if (this.down !== null) return new Response("upstream error", { status: this.down });
    return Response.json(this.answer(body.method, body.params));
  };

  private height(params: Record<string, unknown>): number | { error: unknown } {
    if (params["finality"] === "final") return this.head;
    const h = params["block_id"];
    if (typeof h !== "number") throw new Error("test node takes heights only");
    if (h > this.head || this.skipped.has(h)) return { error: handlerError("UNKNOWN_BLOCK", {}, `DB Not Found Error: BLOCK HEIGHT: ${h} \n Cause: Unknown`) };
    if (h < this.gcBelow) return { error: handlerError("GARBAGE_COLLECTED_BLOCK", { block_height: h, block_hash: hash(h) }, `The data for block #${h} is garbage collected on this node, use an archival node to fetch historical data`) };
    return h;
  }

  private stateAt(id: string, h: number): AccountState | null {
    let state: AccountState | null = null;
    for (const s of this.accounts.get(id) ?? []) if (s.from <= h) state = s.state;
    return state;
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    const h = this.height(params);
    if (typeof h !== "number") return { jsonrpc: "2.0", id: "maskwars-check", ...h };
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: "maskwars-check", result });
    const err = (error: unknown) => ({ jsonrpc: "2.0", id: "maskwars-check", error });
    const at = { block_hash: hash(h), block_height: h };

    if (method === "block") {
      const ts = HEAD_TS - BigInt(HEAD - h) * NS_PER_BLOCK;
      return ok({
        author: "node0",
        header: { height: h, prev_height: h - 1, hash: hash(h), prev_hash: hash(h - 1), timestamp: Number(ts), timestamp_nanosec: ts.toString(), epoch_id: "11111111111111111111111111111111" },
        chunks: [],
      });
    }
    if (method !== "query") return err({ name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND", info: { method_name: method } }, code: -32601, message: "Method not found" });

    const id = String(params["account_id"]);
    const state = this.stateAt(id, h);
    const kind = params["request_type"];
    if (!state) return err(handlerError("UNKNOWN_ACCOUNT", { ...at, requested_account_id: id }, `account ${id} does not exist while viewing`));

    if (kind === "view_account") return ok({ ...state, locked: "0", storage_paid_at: 0, ...at });
    if (kind === "view_access_key") {
      const key = this.keys.get(`${id}/${String(params["public_key"])}`);
      if (!key) return err(handlerError("UNKNOWN_ACCESS_KEY", { ...at, public_key: params["public_key"] }, `access key ${String(params["public_key"])} does not exist while viewing`));
      return ok({ nonce: 85, permission: key, ...at });
    }
    if (kind === "call_function") {
      const fn = this.views.get(`${id}/${String(params["method_name"])}`);
      const panic = (vm: string) =>
        this.legacyErrors
          ? ok({ ...at, error: `wasm execution failed with error: ${vm}`, logs: [] })
          : err(handlerError("CONTRACT_EXECUTION_ERROR", { ...at, vm_error: `wasm execution failed with error: ${vm}` }, `wasm execution failed with error: ${vm}`));
      if (!fn) return panic("MethodResolveError(MethodNotFound)");
      const args = JSON.parse(Buffer.from(String(params["args_base64"]), "base64").toString()) as Record<string, unknown>;
      let value: unknown;
      try {
        value = fn(args, h);
      } catch (e) {
        return panic(`FunctionCallError(ExecutionError("Smart contract panicked: ${e instanceof Error ? e.message : String(e)}"))`);
      }
      return ok({ result: [...Buffer.from(JSON.stringify(value))], logs: [], ...at });
    }
    return err({ name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR" }, code: -32700, message: "Parse error" });
  }
}

function handlerError(cause: string, info: unknown, data: string) {
  return { name: "HANDLER_ERROR", cause: { name: cause, info }, code: -32000, message: "Server error", data };
}

/** A stable fake base58 block hash per height. */
export function hash(h: number): string {
  return `Hx${h.toString(36)}`.padEnd(44, "A").replace(/[0OIl]/g, "z");
}

export const CODE_A = "8JLoDp5bYW3HbvwdjqLM6QiXEeNs7fWkuAHMCw3D7Xyn";
export const CODE_B = "5ZJ4yaKm3n6WkRSvE5hGTmFyHPvoYWwmCU2aU5mHhXWT";
export const NEAR = 10n ** 24n;
