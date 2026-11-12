// One page, live: the arena and MASK CHECK from the network MASKWARS_NETWORK names (testnet unless it says mainnet),
// the page from a Confidential TEE model on NEAR AI Cloud.
//
//   MASKWARS_NETWORK=mainnet NEARAI_CLOUD_API_KEY=… pnpm --filter @maskwars/dossier write safe-0001.maskwars.near [out.json]
//
// Prints the standing, every fact and, when the page passed every check, the page with its attestation. With an out
// path it also saves the whole written page there, as the site stores it. ARENA_FIXTURE replays recorded chain answers.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Arena, Indexer, NETWORK, RPCS } from "@maskwars/arena";
import { near } from "@maskwars/arena/format";
import { type Recording, replayFetch } from "@maskwars/arena/replay";
import { ChainReader, InvalidAccountError, maskCheck, readerFor, sharedLists } from "@maskwars/check";
import { ARENA_TEAMS, DEFAULT_MODEL, PAGE_MODELS, collect, nearAiWriter, verifyWritten, writable, writePage, writesPages } from "../src/index.ts";

const [account, out] = process.argv.slice(2);
if (!account) {
  console.error("usage: pnpm --filter @maskwars/dossier write <account> [out.json]");
  process.exit(2);
}
const key = process.env.NEARAI_CLOUD_API_KEY || process.env.NEAR_AI_API_KEY;
const model = process.env.DOSSIER_MODEL ?? DEFAULT_MODEL;
if (!writesPages(model)) {
  console.error(`${model} does not write pages: a TEE model that answers with no reasoning is one of ${PAGE_MODELS.join(", ")}`);
  process.exit(2);
}

const fixture = process.env.ARENA_FIXTURE;
const recording = fixture ? (JSON.parse(readFileSync(resolve(process.cwd(), fixture), "utf8")) as Recording) : null;
const fetcher = recording ? replayFetch(recording) : fetch;
const now = recording ? () => recording.recordedAt : Date.now;
const arena = new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch: fetcher }), indexer: new Indexer({ fetch: fetcher }), now });

const view = await arena.view().catch((error: unknown) => {
  console.error(`arena: ${(error as Error).message}`);
  return null;
});
const reader = recording ? new ChainReader({ endpoints: RPCS, fetch: fetcher }) : readerFor(NETWORK, { env: process.env });
const check = await maskCheck(account, { network: NETWORK, reader, list: sharedLists[NETWORK] }).catch((error: unknown) => {
  if (!(error instanceof InvalidAccountError)) console.error(`MASK CHECK: ${(error as Error).message}`);
  return null;
});
const d = collect({ account, view, check, now: now() });

const h = d.headline;
console.log(`${d.account}  ${d.role}  ${h.standing}${h.amount ? `  ${near(h.amount)} NEAR ${h.amountIs}` : ""}  ${h.races} race${h.races === 1 ? "" : "s"}, ${h.masks} mask${h.masks === 1 ? "" : "s"}`);
if (d.check) console.log(`MASK CHECK ${d.check.verdict.toUpperCase()} at block ${d.check.block.height}`);
for (const e of d.evidence) console.log(`  ${e.id.padEnd(4)} ${e.fact}`);
console.log(`facts ${d.evidenceHash}`);

if (!writable(d, { teams: ARENA_TEAMS })) {
  console.log("no page: the arena has no record of this account");
  process.exit(0);
}
if (!key) {
  console.error("no page: set NEARAI_CLOUD_API_KEY (or NEAR_AI_API_KEY) to write it on NEAR AI Cloud");
  process.exit(1);
}

const writer = await nearAiWriter({ apiKey: key, model });
console.log(`attestation ${writer.tee?.outcome} at ${writer.tee?.checkedAt}, signers ${writer.tee?.signers.join(", ") || "none"}`);
const result = await writePage(d, { ...writer, teams: ARENA_TEAMS });
if (result.status !== "published") {
  console.error(`not published (${result.reason}, ${result.attempts} tries):`);
  for (const p of result.problems) console.error(`  - ${p}`);
  process.exit(1);
}
const p = result.page;
console.log(`\n${p.page.lede.text}  [${p.page.lede.refs.join(" ")}]`);
for (const s of p.page.sections) {
  console.log(`\n${s.id.toUpperCase()}`);
  for (const c of s.claims) console.log(`  ${c.text}  [${c.refs.join(" ")}]`);
}
console.log(`\n${p.model} · request ${p.attestation.requestHash} · response ${p.attestation.responseHash}`);
console.log(`signed by ${p.attestation.signature?.signingAddress} · verified ${p.attestation.signatureVerified} · $${p.usage.costUsd.toFixed(5)}`);
const again = verifyWritten(p);
console.log(`checked again as a partner would: ${again.ok ? "holds" : again.problems.join("; ")}`);
if (out) {
  writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(p, null, 2)}\n`);
  console.log(`saved ${out}`);
}
