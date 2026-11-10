/**
 * Writes test/vectors.json: every scenario of test/vectors.ts run once, with the RPC answers it read and what the
 * check said. Run it after the check changes; the TEE module (services/check) must then give the same answers.
 *
 *   pnpm --filter @maskwars/check vectors
 */
import { writeFile } from "node:fs/promises";
import { VECTORS_FILE, buildVectors, format } from "../test/vectors.ts";

const file = await buildVectors();
await writeFile(VECTORS_FILE, format(file));
console.log(`${file.vectors.length} vectors → ${VECTORS_FILE.pathname}`);
