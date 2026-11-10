/**
 * Records what testnet RPC and the indexer answer for one full reading of the arena, into the file the tests and
 * local screenshots replay (`test/fixtures/testnet.json`):
 *
 *   pnpm --filter @maskwars/arena record [--out file] [--print]
 *
 * `--print` also writes the recording to stdout, gzipped and in base64 lines, for a CI log.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { ChainReader } from "@maskwars/check";
import { Arena, Indexer, RPCS, near } from "../src/index.ts";
import { type Recording, recordFetch } from "../src/replay.ts";

const argv = process.argv.slice(2);
const at = argv.indexOf("--out");
const out = at >= 0 && argv[at + 1] ? argv[at + 1]! : join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "testnet.json");

const rec = recordFetch();
const recordedAt = Date.now();
const arena = new Arena({
  rpc: new ChainReader({ endpoints: RPCS, fetch: rec.fetch }),
  indexer: new Indexer({ fetch: rec.fetch }),
  now: () => recordedAt,
});
const view = await arena.view();
const recording: Recording = { recordedAt, exchanges: rec.exchanges };
const text = `${JSON.stringify(recording, null, 1)}\n`;
await writeFile(out, text);

console.log(`${rec.exchanges.length} answers, ${(text.length / 1024).toFixed(0)} KB → ${out}`);
for (const r of view.races) {
  console.log(`${r.id.padEnd(10)} ${r.contract.padEnd(28)} ${r.phase.padEnd(8)} ${r.state.padEnd(9)} winner ${r.winner?.account ?? "–"} takes ${near(r.takes)} NEAR, ${r.events.length} events`);
}
if (argv.includes("--print")) {
  const blob = gzipSync(Buffer.from(text)).toString("base64");
  console.log(`RECORDING ${blob.length}`);
  for (let i = 0; i < blob.length; i += 8000) console.log(`REC:${String(i / 8000).padStart(3, "0")}:${blob.slice(i, i + 8000)}`);
  console.log("RECORDING END");
}
