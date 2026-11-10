/**
 * The arena over MCP, live: a real MCP client asks the race on now, the league, NOVA and every race, as an agent would.
 *
 *   pnpm --filter @maskwars/mcp live                             # this code, live on testnet
 *   pnpm --filter @maskwars/mcp live https://maskwars.xyz/mcp    # a deployed endpoint
 *
 * Exits 1 if race-0003 does not read as NOVA's paid break (1.08664 NEAR taken), 4 if the chain did not answer.
 * Without an endpoint, MASKWARS_RPC, MASKWARS_INDEXER and MASKWARS_BOUNTY_CONTRACTS point the code it runs elsewhere,
 * as they do the stdio server and the site's /mcp.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { configFromEnv, createMcpRoute } from "../src/index.ts";

type Answer = Awaited<ReturnType<Client["callTool"]>>;

const endpoint = process.argv[2];
const route = endpoint ? null : createMcpRoute({ config: configFromEnv(process.env), onerror: (e) => console.error(`mcp: ${e.message}`) });
const fetch = route
  ? (url: string | URL, init?: RequestInit) => {
      const req = new Request(url, init);
      return req.method === "GET" ? route.GET(req) : req.method === "DELETE" ? route.DELETE(req) : route.POST(req);
    }
  : undefined;

const client = new Client({ name: "maskwars-live", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint ?? "https://maskwars.xyz/mcp"), fetch ? { fetch } : {}));
console.log(`${endpoint ?? "this code, live on testnet"}: ${(await client.listTools()).tools.map((t) => t.name).join(", ")}\n`);

const text = (a: Answer) => (a.content as { text?: string }[]).map((b) => b.text ?? "").join("\n");

async function ask<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const answer = await client.callTool({ name, arguments: args });
  if (answer.isError) {
    console.error(`${name}: ${text(answer)}`);
    process.exit(/chain/.test(text(answer)) ? 4 : 1);
  }
  const data = answer.structuredContent as T & { headline: string };
  console.log(`${name.padEnd(14)} ${data.headline}`);
  return data;
}

await ask("get_live_race", {});
await ask("get_league", {});
const races = await ask<{ races: { headline: string }[] }>("list_races", { limit: 10 });
for (const r of races.races) console.log(`${"".padEnd(14)}   ${r.headline}`);
const nova = await ask<{ history: { race: string; won: boolean; took_near: string | null; broke_in: string | null }[] }>("get_mask", { name: "nova" });
await client.close();

const first = nova.history.find((h) => h.race === "race-0003");
if (!first?.won || first.took_near !== "1.08664" || first.broke_in !== "8:13") {
  console.error("\nrace-0003 does not read as NOVA's paid break: 1.08664 NEAR in 8:13");
  process.exit(1);
}
console.log("\nrace-0003 reads as it happened: NOVA broke SAFE-0001 in 8:13 and took 1.08664 NEAR.");
