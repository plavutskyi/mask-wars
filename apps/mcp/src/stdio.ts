// The same server over stdio, for an agent that runs it from a clone:
//   claude mcp add maskwars -- node apps/mcp/src/stdio.ts
// stdout carries the protocol, so nothing here prints to it.
import { ChainReader, mainnetList, readerFor, sharedList } from "@maskwars/check";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { configFromEnv } from "./config.ts";
import { arenaFeed } from "./feed.ts";
import { BUDGETS } from "./http.ts";
import { createBudget } from "./limit.ts";
import { createServer } from "./server.ts";

const config = configFromEnv(process.env);
const reader = new ChainReader({ endpoints: config.rpc });
const mainnet = { reader: readerFor("mainnet", { env: process.env }), list: mainnetList };
const feed = arenaFeed(config);
const limits = { check: createBudget(BUDGETS.check), race: createBudget(BUDGETS.race), arena: createBudget(BUDGETS.arena) };

serveStdio(() => createServer({ config, reader, feed, list: sharedList, mainnet, limits, caller: "local" }));
console.error(`maskwars MCP on stdio, NEAR ${config.network} via ${config.rpc.join(", ")}; check_account on mainnet via ${mainnet.reader.endpoints.join(", ")}`);
