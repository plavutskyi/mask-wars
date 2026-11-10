/**
 * Records what the chain's RPC and the indexer answer for one full reading of the jobs board, into the file the tests,
 * the MCP tests and local screenshots replay:
 *
 *   MASKWARS_JOBS_CONTRACT=jobs.test.near MASKWARS_CREWS_CONTRACT=crews.test.near MASKWARS_RPC=http://127.0.0.1:<port> \
 *   MASKWARS_INDEXER=http://127.0.0.1:3031 pnpm --filter @maskwars/arena jobs:record [--out file]
 *
 * Against the sandbox world (`jobs-world/`) it writes `test/fixtures/jobs-sandbox.json`. Its `recordedAt` is the chain's own
 * clock at the block it read, so a replay reads every job in the phase it had then.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Indexer } from "../src/index.ts";
import { near } from "../src/format.ts";
import { type Recording, recordFetch } from "../src/replay.ts";
import { ChainReader } from "@maskwars/check";
import { Jobs, jobsConfigFromEnv } from "../src/jobs/index.ts";

const argv = process.argv.slice(2);
const at = argv.indexOf("--out");
const out = at >= 0 && argv[at + 1] ? argv[at + 1]! : join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "jobs-sandbox.json");

const config = jobsConfigFromEnv(process.env);
if (!config.contract) throw new Error("no jobs contract to record");
const rec = recordFetch();
const jobs = new Jobs({ config, rpc: new ChainReader({ endpoints: config.rpc, fetch: rec.fetch }), indexer: new Indexer({ base: config.indexer, fetch: rec.fetch }) });
const board = await jobs.board();
// Every crew the board names, as the crews contract holds it now, and one id no crew has: the crew tools replay both.
const crews = new Map<string, string>();
for (const j of board.jobs) for (const e of j.entrants) if (e.crew) crews.set(`${j.crews}/${e.crew}`, j.crews);
const read: string[] = [];
for (const [key, contract] of crews) {
  const id = key.slice(contract.length + 1);
  const crew = await jobs.crew(id, contract);
  read.push(`${id} v${crew?.version ?? "-"} ${crew ? (crew.ready ? "ready" : "not ready") : "gone"}`);
}
if (config.crews) await jobs.crew("nobody-0000", config.crews);
const recording: Recording & { network: string; contract: string; crews?: string; rpc: string; indexer: string } = {
  recordedAt: board.readAt,
  network: config.network,
  contract: config.contract,
  ...(config.crews ? { crews: config.crews } : {}),
  rpc: config.rpc[0]!,
  indexer: config.indexer,
  exchanges: rec.exchanges,
};
const text = `${JSON.stringify(recording)}\n`;
await writeFile(out, text);

console.log(`${rec.exchanges.length} answers, ${(text.length / 1024).toFixed(0)} KB → ${out}`);
console.log(`${config.network} ${config.contract} at block ${board.block?.height}: ${board.open} open, ${near(board.waiting)} NEAR waiting, ${near(board.paid)} NEAR paid to masks`);
console.log(`crews: ${read.join(", ") || "none"}`);
for (const j of board.jobs) {
  console.log(`${j.id.padEnd(12)} ${j.kind.padEnd(10)} ${j.phase.padEnd(10)} reward ${near(j.reward).padStart(6)} NEAR, ${j.entrants.length} entrants, ${j.steps.length} steps, ${j.events.length} events`);
}
