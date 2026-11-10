import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXAMPLES = join(import.meta.dirname, "../examples");

export function examples(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of readdirSync(EXAMPLES).filter((f) => f.endsWith(".json"))) out[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(EXAMPLES, f), "utf8"));
  return out;
}

/** The same event with real (LIVE) numbers, for the queue paths that SIMULATED never reaches. */
export const live = <T extends { source: string }>(e: T): T => ({ ...structuredClone(e), source: "LIVE" });
