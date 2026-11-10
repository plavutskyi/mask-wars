// A jobs reader that answers from a recording instead of the network: the tests, the MCP tests and local screenshots
// replay what the chain answered (`scripts/jobs-record.ts`), byte for byte, at the moment it was recorded.
import { readFileSync } from "node:fs";
import { Indexer } from "../indexer.ts";
import { type Recording, replayFetch } from "../replay.ts";
import { ChainReader } from "@maskwars/check";
import { NETWORKS } from "@maskwars/network";
import { type JobsConfig, jobsConfigOf } from "./config.ts";
import { Jobs } from "./read.ts";

export interface JobsRecording extends Recording {
  readonly network: string;
  readonly contract: string;
  /** The crews contract of the recorded chain, when the recording names it. */
  readonly crews?: string;
  readonly rpc: string;
  readonly indexer: string;
}

/** A recording by its path, or by a `file:` URL (`new URL("./x.json", import.meta.url)`), which reads the same on every system. */
export function readRecording(path: string | URL): JobsRecording {
  return JSON.parse(readFileSync(path, "utf8")) as JobsRecording;
}

/** The config the recording was made with: the same contract, RPC and indexer, so every request finds its answer. */
export function recordedConfig(r: JobsRecording): JobsConfig {
  return { network: r.network, contract: r.contract, crews: r.crews ?? null, rpc: [r.rpc], indexer: r.indexer, explorer: null };
}

/**
 * A reader over a recording, on the recording's clock. `fetch` wraps the replay, to count or break requests; `storage`
 * is the judges' storage address the recording's world served (`MASKWARS_JUDGE_STORAGE`).
 */
export function replayJobs(r: JobsRecording, options: { wrap?: (f: typeof fetch) => typeof fetch; ttlMs?: number; now?: () => number; storage?: string } = {}): Jobs {
  const base = replayFetch(r);
  const fetch = options.wrap ? options.wrap(base) : base;
  return new Jobs({
    config: { ...recordedConfig(r), storage: options.storage ?? null },
    rpc: new ChainReader({ endpoints: [r.rpc], fetch }),
    indexer: new Indexer({ base: r.indexer, fetch }),
    now: options.now ?? (() => r.recordedAt),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
}

/** The moment an empty board is read at: 10.11.2026 12:00 UTC. */
export const EMPTY_AT = Date.UTC(2026, 10, 10, 12, 0, 0);
const EMPTY_HEIGHT = 240_000_000;
const EMPTY_HASH = "EmptyJobsBoardAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * What a chain answers while its board holds no job, in nearcore's own shapes, with no network. `undeployed`: the jobs
 * account does not exist, as on a network before the contract is deployed. `deployed`: the contract is there with its
 * settings and no job, as right after its deployment: it follows the network's bounty contract and has no judge yet, so
 * it opens a drain job and no other kind. Nothing here is read from a chain: it is what the tests and local screenshots
 * show the empty board on.
 */
export function emptyJobsFetch(state: "undeployed" | "deployed", config: JobsConfig = jobsConfigOf(), at = EMPTY_AT): typeof fetch {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const bounty = config.network === "testnet" || config.network === "mainnet" ? NETWORKS[config.network].bounty : null;
  const settings = {
    admin: "admin",
    meter: "admin",
    treasury: "admin",
    outlayer: "outlayer",
    crews: config.crews ?? "crews",
    judges: [],
    bounties: bounty ? [bounty] : [],
    factories: [],
    fee_bps: 500,
    fee_to: "admin",
    jobs: 0,
    live: 0,
    pending: null,
    judge_fee: "10000000000000000000000",
    appeal_bond: "200000000000000000000000",
    max_slots: 16,
    max_steps: 4,
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(config.indexer)) return json(url.endsWith("/v0/account") ? { account_txs: [], txs_count: 0 } : { transactions: [] });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: unknown; method?: string; params?: Record<string, unknown> }) : {};
    const ok = (result: unknown) => json({ jsonrpc: "2.0", id: body.id ?? "x", result });
    if (body.method === "block") return ok({ header: { height: EMPTY_HEIGHT, hash: EMPTY_HASH, timestamp_nanosec: `${BigInt(at) * 1_000_000n}` } });
    const params = body.params ?? {};
    const account = String(params["account_id"] ?? "");
    if (state === "deployed" && account === config.contract) {
      if (params["request_type"] === "view_account") {
        return ok({ amount: "10000000000000000000000000", locked: "0", code_hash: "7oJRkGfNcAkz5ZnzBnDiKaeNAYA6k28TF7UFWcoPkGCG", storage_usage: 570_000, storage_paid_at: 0, block_height: EMPTY_HEIGHT, block_hash: EMPTY_HASH });
      }
      if (params["request_type"] === "call_function" && params["method_name"] === "config") {
        return ok({ result: [...Buffer.from(JSON.stringify(settings))], logs: [], block_height: EMPTY_HEIGHT, block_hash: EMPTY_HASH });
      }
      if (params["request_type"] === "call_function" && params["method_name"] === "list") {
        return ok({ result: [...Buffer.from("[]")], logs: [], block_height: EMPTY_HEIGHT, block_hash: EMPTY_HASH });
      }
    }
    return json({
      jsonrpc: "2.0",
      id: body.id ?? "x",
      error: {
        name: "HANDLER_ERROR",
        cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: account, block_height: EMPTY_HEIGHT, block_hash: EMPTY_HASH } },
        code: -32000,
        message: "Server error",
        data: `account ${account} does not exist while viewing`,
      },
    });
  }) as typeof fetch;
}

/** A reader over an empty board (`emptyJobsFetch`), on that moment's clock. */
export function emptyJobs(state: "undeployed" | "deployed", config: JobsConfig = jobsConfigOf(), at = EMPTY_AT): Jobs {
  const fetch = emptyJobsFetch(state, config, at);
  return new Jobs({ config, rpc: new ChainReader({ endpoints: config.rpc, fetch }), indexer: new Indexer({ base: config.indexer, fetch }), now: () => at });
}
