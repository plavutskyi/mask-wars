// Writes packages/core/vectors/*.json from the core itself. Run: pnpm --filter @maskwars/core vectors
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllVectors, serializeVectors } from "../src/vectors.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
mkdirSync(dir, { recursive: true });
for (const [name, content] of Object.entries(buildAllVectors())) {
  writeFileSync(join(dir, name), serializeVectors(content));
  console.log(`vectors/${name}`);
}
