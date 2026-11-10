// Streamable HTTP at /mcp, stateless: every request gets a fresh server, nothing is kept between requests except the
// per-caller limits. Serves clients on the 2026-07-28 protocol and 2025-era clients from the same tools.
import type { Arena } from "@maskwars/arena";
import { ChainReader, type SharedList, mainnetList, readerFor, sharedList } from "@maskwars/check";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { type ArenaConfig, configFromEnv } from "./config.ts";
import { ArenaFeed, arenaFeed } from "./feed.ts";
import { type Budget, callerOf, createBudget } from "./limit.ts";
import { type CheckDeps, SERVER_NAME, SERVER_VERSION, TOOL_NAMES, createServer, instructionsFor } from "./server.ts";

export interface McpBudgets {
  /** Every HTTP request to the endpoint. */
  http: Budget;
  /** `check_account`: about ten RPC calls each, the same budget as /api/check. */
  check: Budget;
  /** `get_race`: three to seven RPC calls each. */
  race: Budget;
  /** `get_live_race`, `list_races`, `get_mask` and `get_league` together: one shared reading of the arena serves them. */
  arena: Budget;
}

export const BUDGETS: McpBudgets = {
  http: { perCaller: 120, perInstance: 3_000, windowMs: 60_000 },
  check: { perCaller: 30, perInstance: 600, windowMs: 60_000 },
  race: { perCaller: 60, perInstance: 1_200, windowMs: 60_000 },
  arena: { perCaller: 60, perInstance: 1_200, windowMs: 60_000 },
};

/** The tools take a few short strings; anything bigger is not a call to them. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface McpRouteOptions {
  config?: ArenaConfig;
  reader?: ChainReader;
  /**
   * The arena the tools read, as a feed: one reading in flight, the last good one served meanwhile. The site passes
   * the feed its /mcp/connect page reads too. Default: `arenaFeed(config)`, this config's contracts over its RPC and
   * indexer.
   */
  feed?: ArenaFeed;
  /**
   * An arena reader to read through a feed of its own, instead of `feed`: one only this route reads, on the same clock
   * (the feed tells a new reading from the one it has by identity).
   */
  arena?: Arena;
  list?: SharedList;
  /**
   * check_account on mainnet. Default: FastNEAR and dRPC, which must agree (`MASKCHECK_MAINNET_RPC` replaces them), and
   * the mainnet shared list.
   */
  mainnet?: CheckDeps;
  budgets?: McpBudgets;
  /** Errors outside a tool's answer and requests the server refused. Default: one line to the server log. */
  onerror?: (error: Error) => void;
  /** A page for people: a browser that opens the endpoint is sent there. Without it, a browser gets the JSON card. */
  page?: string;
}

export interface McpRoute {
  GET(req: Request): Promise<Response>;
  POST(req: Request): Promise<Response>;
  DELETE(req: Request): Promise<Response>;
  OPTIONS(): Response;
}

// Any origin may call: every tool is a public read and the server holds nothing a page could steal.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, retry-after",
};

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

/** A JSON-RPC error the client reads as "slow down", with the seconds to wait. */
function tooMany(wait: number): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Too many requests: wait ${wait} s and try again.` } },
    { status: 429, headers: { ...CORS, "retry-after": String(wait), "cache-control": "no-store" } },
  );
}

/** What a crawler or a script sees when it opens /mcp: how to connect. A client streaming events asks for SSE instead. */
function about(config: ArenaConfig, endpoint: string): Response {
  return Response.json(
    {
      name: SERVER_NAME,
      title: "MASK WARS",
      version: SERVER_VERSION,
      about: instructionsFor(config.network),
      transport: "streamable-http",
      endpoint,
      network: config.network,
      tools: TOOL_NAMES,
      connect: {
        claude_code: `claude mcp add --transport http maskwars ${endpoint}`,
        codex: `codex mcp add maskwars --url ${endpoint}`,
      },
    },
    { headers: { ...CORS, "cache-control": "public, max-age=300" } },
  );
}

export function createMcpRoute(options: McpRouteOptions = {}): McpRoute {
  const config = options.config ?? configFromEnv({ MASKWARS_NETWORK: process.env["MASKWARS_NETWORK"] });
  const reader = options.reader ?? new ChainReader({ endpoints: config.rpc });
  const list = options.list ?? sharedList;
  const mainnet = options.mainnet ?? { reader: readerFor("mainnet", { env: process.env }), list: mainnetList };
  const budgets = options.budgets ?? BUDGETS;
  const http = createBudget(budgets.http);
  const feed = options.feed ?? (options.arena ? new ArenaFeed(options.arena) : arenaFeed(config, options.reader ? { rpc: options.reader } : {}));
  const limits = { check: createBudget(budgets.check), race: createBudget(budgets.race), arena: createBudget(budgets.arena) };

  const handler = createMcpHandler(({ requestInfo }) => createServer({ config, reader, feed, list, mainnet, limits, caller: callerOf(requestInfo) }), {
    maxRequestBodySize: MAX_BODY_BYTES,
    // No push notifications (the tool list only changes with a release), so no subscription stream is ever held open.
    maxSubscriptions: 0,
    onerror: options.onerror ?? ((error) => console.error(`mcp: ${error.message}`)),
  });

  async function serve(req: Request): Promise<Response> {
    const wait = http.take(callerOf(req));
    if (wait !== null) return tooMany(wait);
    return withHeaders(await handler.fetch(req), CORS);
  }

  return {
    GET(req) {
      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("text/event-stream")) return serve(req);
      if (options.page && accept.includes("text/html")) {
        return Promise.resolve(new Response(null, { status: 307, headers: { location: options.page, "cache-control": "no-store" } }));
      }
      const url = new URL(req.url);
      return Promise.resolve(about(config, `${url.origin}${url.pathname}`));
    },
    POST: serve,
    DELETE: serve,
    OPTIONS() {
      return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-max-age": "86400" } });
    },
  };
}
