/**
 * Prices the race's tab of its minds, after the winning plan is sealed:
 *
 *   node packages/race/scripts/minds.ts <tab.json> <minds.json>
 *
 * The tab is what scripts/race.ts wrote with `--minds`: every answer each mask's mind got in the race, with its id on
 * NEAR AI's bill. This asks the bill what each answer cost (`NEAR_AI_API_KEY`) and 1Click what NEAR is worth, and
 * writes the race's record of its minds (src/minds.ts), which the workflow hands on as the artifact `minds-<race>`.
 * The record is for the site: a race and its seal never wait on it, and a step that fails here stops nothing.
 */
import { readFile, writeFile } from "node:fs/promises";
import { mindRecord, parseTab } from "../src/minds.ts";

const [tabFile, out] = process.argv.slice(2);
if (!tabFile || !out) {
  console.error("usage: minds.ts <tab.json> <minds.json>");
  process.exit(2);
}
let raw: unknown = null;
try {
  raw = JSON.parse(await readFile(tabFile, "utf8"));
} catch {
  console.log("no tab of the minds: the race wrote none");
  process.exit(0);
}
const tab = parseTab(raw);
if (!tab) {
  console.log("the tab of the minds is not well formed: no record");
  process.exit(0);
}
const apiKey = process.env.NEAR_AI_API_KEY || process.env.NEARAI_CLOUD_API_KEY || undefined;
try {
  const record = await mindRecord({ ...tab, ...(apiKey ? { apiKey } : {}), log: (line) => console.log(line) });
  await writeFile(out, JSON.stringify(record, null, 2));
  for (const m of record.masks) {
    const lost = m.unanswered ? `, ${m.unanswered} calls with no answer` : "";
    console.log(`${m.name.padEnd(7)} thought for $${m.usd.toFixed(5)}: ${m.answers} answers (${m.billed} on NEAR AI's bill)${lost}, ${m.model}`);
  }
  console.log(record.near ? `NEAR at $${record.near.usd}` : "no NEAR price from 1Click: the race shows its price and no ×");
} catch (e) {
  console.log(`no record of the minds: ${(e as Error).message}`);
}
