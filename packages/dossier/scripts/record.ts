/**
 * Records what the chain answers for one full reading of the arena and for MASK CHECK on each account named, into the
 * file the tests and local screenshots replay. The network is MASKWARS_NETWORK's (testnet unless it says mainnet):
 *
 *   MASKWARS_NETWORK=mainnet pnpm --filter @maskwars/dossier record test/fixtures/mainnet.json \
 *     safe-0001.maskwars.near vault.house.maskwars.near
 *
 * The readers are the ones the site replays a recording with: the arena's RPC list, no cross-check, so every request
 * a replay makes was recorded.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Arena, Indexer, NETWORK, RPCS } from "@maskwars/arena";
import { near } from "@maskwars/arena/format";
import { type Recording, recordFetch, replayFetch } from "@maskwars/arena/replay";
import { ChainReader, maskCheck, sharedLists } from "@maskwars/check";
import { collect } from "../src/index.ts";

const [out, ...accounts] = process.argv.slice(2);
if (!out) {
  console.error("usage: pnpm --filter @maskwars/dossier record <out.json> [account …]");
  process.exit(2);
}

const rec = recordFetch();
const recordedAt = Date.now();
const rpc = new ChainReader({ endpoints: RPCS, fetch: rec.fetch });
const arena = new Arena({ rpc, indexer: new Indexer({ fetch: rec.fetch }), now: () => recordedAt });
const view = await arena.view();
console.log(`${NETWORK}: ${view.races.length} races`);
for (const r of view.races) console.log(`  ${r.id} ${r.target} ${r.phase} ${r.state} ${near(r.takes)} NEAR taken, ${r.events.length} steps`);

// MASK CHECK reads through a reader of its own, as the site's does: nothing it asks is answered from the arena's cache
// and so left out of the recording. A replay answers every account from the one final block it recorded first, so each
// account is read at that block: what was recorded already is answered from the recording, the rest from the chain.
const replayFirst = (async (input: string | URL | Request, init?: RequestInit) => {
  try {
    return await replayFetch({ recordedAt, exchanges: rec.exchanges })(input, init);
  } catch {
    return rec.fetch(input, init);
  }
}) as typeof fetch;
for (const account of accounts) {
  const checks = new ChainReader({ endpoints: RPCS, fetch: replayFirst });
  const check = await maskCheck(account, { network: NETWORK, reader: checks, list: sharedLists[NETWORK] }).catch((error: unknown) => {
    console.error(`MASK CHECK ${account}: ${(error as Error).message}`);
    return null;
  });
  const d = collect({ account, view, check, now: recordedAt });
  console.log(`${account}: ${d.role} ${d.headline.standing}, ${d.evidence.length} facts, MASK CHECK ${check?.verdict ?? "none"} (${check?.reasons.map((r) => r.code).join(", ") ?? ""})`);
}

const recording: Recording = { recordedAt, exchanges: rec.exchanges };
const text = `${JSON.stringify(recording, null, 1)}\n`;
await writeFile(resolve(process.cwd(), out), text);
console.log(`${rec.exchanges.length} answers, ${(text.length / 1024).toFixed(0)} KB → ${out}`);
