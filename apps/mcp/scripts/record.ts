// Records NEAR testnet as the MCP tools read it into test/recorded/testnet.json: the final block, every account the
// tools touch (now and a day before) and every view answer of the bounty contracts and the arena's safes. The tests
// replay it through test/node.ts, so they never need the network. Run it where testnet RPC is reachable:
//   pnpm --filter @maskwars/mcp record [out.json]
// MASKWARS_RPC and MASKWARS_BOUNTY_CONTRACTS point it elsewhere, as they do the server.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type BlockInfo, ChainError, ChainReader, sharedList } from "@maskwars/check";
import { configFromEnv } from "../src/config.ts";

const OUT = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL("../test/recorded/testnet.json", import.meta.url);
const config = configFromEnv(process.env);
const RACE_VIEWS = ["get", "get_safe", "get_round"] as const;
/** Race ids are race-0001, race-0002, …; the scan stops after this many missing in a row. */
const GAP = 3;

const reader = new ChainReader({ endpoints: config.rpc });
const head = await reader.head();
const at = { block_id: head.height };

async function blockAtOrBelow(height: number): Promise<BlockInfo> {
  for (let h = height; h > height - 4; h--) {
    const b = await reader.block(h);
    if (b) return b;
  }
  throw new Error(`no block near ${height}`);
}

// The same arithmetic MASK CHECK does for its 24 h window, so the replayed chain asks for the same heights.
const sample = await blockAtOrBelow(head.height - 10_000);
const nsPerBlock = (head.timestampNs - sample.timestampNs) / BigInt(head.height - sample.height);
const dayAgo = head.height - Math.ceil((24 * 3_600e9) / Number(nsPerBlock));

type Answer = unknown;
const views: Record<string, Record<string, Record<string, Answer>>> = {};
const accounts = new Set<string>(config.contracts);

/** A view's answer, or `undefined` when the contract has no such method (or no code, or no account). */
async function view(contract: string, method: string, args: Record<string, unknown>): Promise<Answer | undefined> {
  try {
    return await reader.view<Answer>(contract, method, args, at);
  } catch (error) {
    if (error instanceof ChainError && (error.kind === "contract" || error.kind === "unknown_account")) return undefined;
    throw error;
  }
}

function put(contract: string, method: string, args: Record<string, unknown>, answer: Answer): void {
  ((views[contract] ??= {})[method] ??= {})[JSON.stringify(args)] = answer;
}

for (const contract of config.contracts) {
  let missing = 0;
  for (let n = 1; missing < GAP && n < 1_000; n++) {
    const id = `race-${String(n).padStart(4, "0")}`;
    const bounty = await view(contract, "get", { id });
    if (bounty === undefined) break; // no contract here (yet)
    if (bounty === null) {
      missing++;
      continue;
    }
    missing = 0;
    put(contract, "get", { id }, bounty);
    const b = bounty as { owner: string; status: { winner?: string; tx_hash?: string } };
    accounts.add(b.owner);
    if (b.status.winner) accounts.add(b.status.winner);
    for (const method of RACE_VIEWS.slice(1)) {
      const answer = await view(contract, method, { id });
      if (answer !== undefined) put(contract, method, { id }, answer);
    }
    const safe = views[contract]?.["get_safe"]?.[JSON.stringify({ id })] as { safe: string; masks: string[] } | null | undefined;
    if (safe) for (const a of [safe.safe, ...safe.masks]) accounts.add(a);
    if (b.status.tx_hash) {
      const claimed = await view(contract, "drain_claimed", { tx_hash: b.status.tx_hash });
      if (claimed !== undefined) put(contract, "drain_claimed", { tx_hash: b.status.tx_hash }, claimed);
    }
  }
  // Any other id or transaction: the contract answers null for what it does not hold.
  for (const answers of Object.values(views[contract] ?? {})) answers["*"] = null;
}

for (const entry of sharedList.arena) accounts.add(entry.safe);
for (const safe of [...accounts]) {
  const owner = await view(safe, "get_owner", {});
  if (owner !== undefined) put(safe, "get_owner", {}, owner);
}

async function state(id: string, blockId: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await reader.rpc("query", { request_type: "view_account", account_id: id, block_id: blockId });
    const keep = ["amount", "locked", "code_hash", "storage_usage", "global_contract_hash"];
    return Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k)));
  } catch (error) {
    if (error instanceof ChainError && error.kind === "unknown_account") return null;
    throw error;
  }
}

const recordedAccounts: Record<string, { now: unknown; day_ago: unknown }> = {};
for (const id of [...accounts].sort()) recordedAccounts[id] = { now: await state(id, head.height), day_ago: await state(id, dayAgo) };

const recording = {
  about:
    "NEAR testnet as the MCP tools read it: the final block, the accounts now and a day before, and every view answer of the bounty contracts and the safes. test/node.ts serves it back in nearcore's exact JSON-RPC shapes. Refresh it from the chain with: pnpm --filter @maskwars/mcp record",
  recorded: { by: "scripts/record.ts", at: new Date().toISOString(), exact: "everything", approximate: "nothing", rpc: [...reader.endpoints] },
  head: { height: head.height, hash: head.hash, timestamp_nanosec: head.timestampNs.toString() },
  ns_per_block: nsPerBlock.toString(),
  day_ago_height: dayAgo,
  accounts: recordedAccounts,
  views,
};
await writeFile(OUT, `${JSON.stringify(recording, null, 2)}\n`);
const races = config.contracts.map((c) => `${c}: ${Object.keys(views[c]?.["get"] ?? {}).filter((k) => k !== "*").length} races`);
console.log(`recorded block ${head.height}: ${races.join("; ") || "no races"}; ${accounts.size} accounts → ${fileURLToPath(OUT)}`);
