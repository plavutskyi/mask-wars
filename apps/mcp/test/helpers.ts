import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Arena, Indexer } from "@maskwars/arena";
import { type Recording as ArenaRecording, replayFetch } from "@maskwars/arena/replay";
import { ChainReader, mainnetList, readerFor } from "@maskwars/check";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type ArenaFeed, BUDGETS, type McpBudgets, TESTNET, createMcpRoute } from "../src/index.ts";
import { RecordedNode, type Recording } from "./node.ts";

export const ENDPOINT = "https://maskwars.xyz/mcp";

/**
 * What testnet RPC and the indexer answered for one full reading of the arena (7.11.2026), byte for byte, as
 * `pnpm --filter @maskwars/mcp record:arena` records it. The arena tools replay it.
 */
export const arenaRecording = JSON.parse(readFileSync(new URL("./recorded/arena.json", import.meta.url), "utf8")) as ArenaRecording;

/** The arena reader over the recorded answers, at the moment they were recorded. Every request goes through `fetch`. */
export function recordedArena(options: { fetch?: typeof fetch; now?: () => number; ttlMs?: number } = {}) {
  const replay = replayFetch(arenaRecording);
  const requests: string[] = [];
  const state = { down: false };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input instanceof Request ? input.url : input));
    if (state.down) throw new TypeError("fetch failed");
    return (options.fetch ?? replay)(input, init);
  }) as typeof globalThis.fetch;
  const arena = new Arena({
    rpc: new ChainReader({ endpoints: TESTNET.rpc, fetch }),
    indexer: new Indexer({ base: TESTNET.indexer, fetch }),
    contracts: TESTNET.contracts,
    now: options.now ?? (() => arenaRecording.recordedAt),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  return { arena, requests, state };
}

type Exchange = { url: string; method: string; params: unknown; status: number; response: unknown };

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]));
  return v;
}

/**
 * What mainnet RPC (FastNEAR and dRPC) answered MASK CHECK about intents.near, usdt.tether-token.near,
 * treasury.intents.near and an unused implicit id (packages/check/test/recorded/mainnet.json), as a fetch.
 */
export function recordedMainnet() {
  const rec = JSON.parse(readFileSync(new URL("../../../packages/check/test/recorded/mainnet.json", import.meta.url), "utf8")) as { exchanges: Exchange[] };
  const keyOf = (url: string, method: string, params: unknown) => `${url} ${method} ${JSON.stringify(sorted(params))}`;
  const answers = new Map(rec.exchanges.map((e) => [keyOf(e.url, e.method, e.params), e]));
  const requests: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    requests.push(String(input));
    const hit = answers.get(keyOf(String(input), method, params));
    if (!hit) throw new TypeError("fetch failed (not recorded)");
    return new Response(JSON.stringify(hit.response), { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { reader: readerFor("mainnet", { fetch }), requests };
}

/** The route over a recorded chain, and an MCP client of either protocol era that talks to it in memory. */
export function setup(options: { rec?: Recording; budgets?: McpBudgets; page?: string; arena?: Arena; feed?: ArenaFeed } = {}) {
  const node = new RecordedNode(options.rec);
  const errors: Error[] = [];
  const recorded = options.arena || options.feed ? null : recordedArena();
  const mainnet = recordedMainnet();
  const route = createMcpRoute({
    reader: new ChainReader({ endpoints: ["https://rpc.testnet.example"], fetch: node.fetch }),
    mainnet: { reader: mainnet.reader, list: mainnetList },
    ...(options.feed ? { feed: options.feed } : { arena: options.arena ?? recorded!.arena }),
    budgets: options.budgets ?? BUDGETS,
    onerror: (e) => errors.push(e),
    ...(options.page ? { page: options.page } : {}),
  });
  const serve = (req: Request): Promise<Response> => {
    if (req.method === "GET") return route.GET(req);
    if (req.method === "POST") return route.POST(req);
    if (req.method === "DELETE") return route.DELETE(req);
    return Promise.resolve(route.OPTIONS());
  };
  const fetch = (url: string | URL, init?: RequestInit) => serve(new Request(url, init));

  async function connect(era: "legacy" | "modern" = "legacy", ip = "203.0.113.7"): Promise<Client> {
    const client = new Client({ name: "test-agent", version: "1.0.0" }, era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
    await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { fetch, requestInit: { headers: { "x-real-ip": ip } } }));
    return client;
  }

  /** A raw JSON-RPC POST, as a 2025-era client sends it. */
  function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return serve(
      new Request(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }

  return { node, route, connect, post, serve, errors, arena: recorded, mainnet };
}

export type Tool = Awaited<ReturnType<Client["callTool"]>>;

/** The JSON text block of a successful structured result. */
export function data<T = Record<string, unknown>>(result: Tool): T {
  if (result.isError) throw new Error(`tool error: ${text(result)}`);
  return result.structuredContent as T;
}

export function text(result: Tool): string {
  const blocks = result.content as { type: string; text?: string }[];
  return blocks.map((b) => b.text ?? "").join("\n");
}

/**
 * The recorded chain behind a real HTTP port, for code that runs in its own process: JSON-RPC at `/` and the indexer
 * at `/v0/…`. A request the arena recording holds is answered from it; any other RPC request from the recorded node.
 */
export async function listen(node: RecordedNode, arena: ArenaRecording | null = null): Promise<{ url: string; close: () => Promise<void> }> {
  const replay = arena ? replayFetch(arena) : null;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const path = req.url ?? "/";
    const recordedAt = path.startsWith("/v0/") ? `${TESTNET.indexer}${path}` : TESTNET.rpc[0]!;
    const fromArena = replay ? await replay(recordedAt, { method: "POST", body }).catch(() => null) : null;
    const answer = fromArena ?? (await node.fetch("http://rpc", { method: "POST", body }));
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(await answer.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
