// A testnet node in memory that serves a recording (test/recorded/*.json) in nearcore's exact JSON-RPC shapes: `block`
// headers with `timestamp_nanosec`, `view_account`, `call_function` result bytes, and HANDLER_ERROR bodies for an
// unknown account or block, a method the contract does not have, and an account without code.
import recorded from "./recorded/testnet.json" with { type: "json" };

export interface AccountState {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
}

export interface Recording {
  head: { height: number; hash: string; timestamp_nanosec: string };
  ns_per_block: string;
  day_ago_height: number;
  accounts: Record<string, { now: AccountState | null; day_ago: AccountState | null }>;
  /** contract → method → canonical JSON args (or `*` for any other) → the contract's JSON answer, or `{"$panic": …}`. */
  views: Record<string, Record<string, Record<string, unknown>>>;
}

export const NO_CODE = "11111111111111111111111111111111";

/** A deep copy of the recording, safe to change in one test. */
export function recording(): Recording {
  return structuredClone(recorded) as unknown as Recording;
}

function handlerError(cause: string, info: unknown, data: string) {
  return { name: "HANDLER_ERROR", cause: { name: cause, info }, code: -32000, message: "Server error", data };
}

export class RecordedNode {
  readonly rec: Recording;
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Answer every request with this HTTP status instead. */
  down: number | null = null;

  constructor(rec: Recording = recording()) {
    this.rec = rec;
  }

  get head(): number {
    return this.rec.head.height;
  }

  /** The recorded hash for the head; a stable stand-in for older heights. */
  hashAt(h: number): string {
    return h === this.head ? this.rec.head.hash : `H${h}`;
  }

  fetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: string; method: string; params: Record<string, unknown> };
    this.calls.push({ method: body.method, params: body.params });
    if (this.down !== null) return new Response("upstream error", { status: this.down });
    return Response.json({ jsonrpc: "2.0", id: body.id, ...this.answer(body.method, body.params) });
  };

  private answer(method: string, params: Record<string, unknown>): { result: unknown } | { error: unknown } {
    let h: number;
    if (params["finality"] === "final") h = this.head;
    else if (typeof params["block_id"] === "number") h = params["block_id"];
    else throw new Error("the recorded node takes the final block or a height");
    if (h > this.head) return { error: handlerError("UNKNOWN_BLOCK", {}, `DB Not Found Error: BLOCK HEIGHT: ${h} \n Cause: Unknown`) };
    const at = { block_hash: this.hashAt(h), block_height: h };

    if (method === "block") {
      const ts = BigInt(this.rec.head.timestamp_nanosec) - BigInt(this.head - h) * BigInt(this.rec.ns_per_block);
      return {
        result: {
          author: "node0",
          header: { height: h, prev_height: h - 1, hash: this.hashAt(h), prev_hash: this.hashAt(h - 1), timestamp: Number(ts), timestamp_nanosec: ts.toString(), epoch_id: NO_CODE },
          chunks: [],
        },
      };
    }
    if (method !== "query") return { error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND", info: { method_name: method } }, code: -32601, message: "Method not found" } };

    const id = String(params["account_id"]);
    const entry = this.rec.accounts[id];
    const state = entry ? (h <= this.rec.day_ago_height ? entry.day_ago : entry.now) : null;
    if (!state) return { error: handlerError("UNKNOWN_ACCOUNT", { ...at, requested_account_id: id }, `account ${id} does not exist while viewing`) };

    if (params["request_type"] === "view_account") return { result: { ...state, storage_paid_at: 0, ...at } };
    if (params["request_type"] !== "call_function") throw new Error(`the recorded node does not serve ${String(params["request_type"])}`);

    if (state.code_hash === NO_CODE) return { error: handlerError("NO_CONTRACT_CODE", { ...at, contract_account_id: id }, `Contract code for contract ID #${id} has never been observed on the node`) };
    const answers = this.rec.views[id]?.[String(params["method_name"])];
    if (!answers) {
      const vm = "wasm execution failed with error: MethodResolveError(MethodNotFound)";
      return { error: handlerError("CONTRACT_EXECUTION_ERROR", { ...at, vm_error: vm }, vm) };
    }
    const args = JSON.stringify(JSON.parse(Buffer.from(String(params["args_base64"]), "base64").toString() || "{}"));
    if (!(args in answers) && !("*" in answers)) throw new Error(`nothing recorded for ${id}.${String(params["method_name"])}(${args})`);
    const value = args in answers ? answers[args] : answers["*"];
    const panic = (value as { $panic?: string } | null)?.$panic;
    if (panic !== undefined) {
      const vm = `wasm execution failed with error: FunctionCallError(ExecutionError("Smart contract panicked: ${panic}"))`;
      return { error: handlerError("CONTRACT_EXECUTION_ERROR", { ...at, vm_error: vm }, vm) };
    }
    return { result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], ...at } };
  }
}
