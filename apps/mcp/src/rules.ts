// The rules of a sealed round: RULES.md at the root of the repository, the same text anyone who races or judges reads.
import { readFile } from "node:fs/promises";

/** RULES.md, referenced so that a bundler ships the file with the server. */
const RULES_FILE = new URL("../../../RULES.md", import.meta.url);

let cached: Promise<string> | null = null;

/** The rules as Markdown, read once per server instance. */
export function loadRules(): Promise<string> {
  cached ??= readFile(RULES_FILE, "utf8").catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}
