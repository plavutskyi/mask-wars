/**
 * Writes what mainnet answers before season 0 is deployed, in the format the tests and local screenshots replay
 * (`test/fixtures/mainnet-empty.json`): the indexer knows no transaction of the arena's accounts, and RPC says the season
 * treasury does not exist, in nearcore's exact error shape. Nothing here is read from the network: it is the honest empty
 * arena the site shows with MASKWARS_NETWORK=mainnet until the first round opens.
 *
 *   node scripts/empty.ts [--out file]
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChainReader } from "@maskwars/check";
import { NETWORKS, bountyContracts, teams } from "@maskwars/network";
import { Arena, Indexer, type MaskProfile } from "../src/index.ts";
import { type Recording, recordFetch } from "../src/replay.ts";

const argv = process.argv.slice(2);
const at = argv.indexOf("--out");
const out = at >= 0 && argv[at + 1] ? argv[at + 1]! : join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "mainnet-empty.json");

/** The moment the empty arena is read at: 9.11.2026 18:00 UTC. */
export const EMPTY_AT = Date.UTC(2026, 10, 9, 18, 0, 0);
const HEIGHT = 230_000_000;

/** Mainnet before maskwars.near holds anything: no transactions, no accounts. */
export function emptyMainnet(): typeof fetch {
  const net = NETWORKS.mainnet;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, any>) : {};
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url === `${net.indexer}/v0/account`) return json({ account_txs: [], txs_count: 0 });
    if (url === `${net.indexer}/v0/transactions`) return json({ transactions: [] });
    if (net.rpc.includes(url)) {
      const id = String(body["params"]?.["account_id"] ?? "");
      return json({
        jsonrpc: "2.0",
        id: body["id"] ?? "x",
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: id, block_height: HEIGHT, block_hash: "HxEmptyMainnetBeforeSeasonZeroAAAAAAAAAAAAAA" } },
          code: -32000,
          message: "Server error",
          data: `account ${id} does not exist while viewing`,
        },
      });
    }
    throw new TypeError(`fetch failed (not mainnet: ${url})`);
  }) as typeof fetch;
}

/** The arena of mainnet, as the site reads it with MASKWARS_NETWORK=mainnet. */
export function mainnetArena(fetch: typeof globalThis.fetch, now: number): Arena {
  const net = NETWORKS.mainnet;
  const models: Record<string, string> = { NOVA: "deepseek-ai/DeepSeek-V4.1-Flash-1017", ONYX: "z-ai/glm-5.3-flash", ORACLE: "Qwen/Qwen3.8-27B" };
  const masks: MaskProfile[] = Object.entries(net.masks).map(([name, account]) => ({ slug: name.toLowerCase(), name, account, model: models[name] ?? "" }));
  return new Arena({
    network: "mainnet",
    rpc: new ChainReader({ endpoints: net.rpc, fetch }),
    indexer: new Indexer({ base: net.indexer, fetch }),
    contracts: bountyContracts(net),
    seasons: [net.season],
    teams: teams(net),
    masks,
    factory: net.factory,
    now: () => now,
  });
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (main) {
  const rec = recordFetch(emptyMainnet());
  const view = await mainnetArena(rec.fetch, EMPTY_AT).view();
  const recording: Recording = { recordedAt: EMPTY_AT, exchanges: rec.exchanges };
  await writeFile(out, `${JSON.stringify(recording, null, 1)}\n`);
  console.log(`${rec.exchanges.length} answers → ${out}: ${view.races.length} races, next ${view.next === null ? "none" : "set"}`);
}
