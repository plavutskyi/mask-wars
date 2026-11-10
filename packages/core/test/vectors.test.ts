import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAllVectors, serializeVectors, type BookVector } from "../src/index.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");

describe("shared vectors", () => {
  const built = buildAllVectors();

  it("are exactly what the generator writes (run `pnpm --filter @maskwars/core vectors` after a change)", () => {
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).sort()).toEqual(Object.keys(built).sort());
    for (const [name, content] of Object.entries(built)) {
      expect(readFileSync(join(dir, name), "utf8"), name).toBe(serializeVectors(content));
    }
  });

  it("books keep Σ payouts + rake + dust = T and pay every winner at least the stake", () => {
    const books = (built["books.json"] as { vectors: BookVector[] }).vectors;
    expect(books.length).toBeGreaterThanOrEqual(50);
    for (const v of books) {
      if (v.expect.kind === "void") {
        expect(v.expect.refunds.length).toBe(v.backs.length);
        continue;
      }
      const sum = v.expect.payouts.reduce((a, p) => a + BigInt(p.amount), 0n);
      expect(sum + BigInt(v.expect.rake) + BigInt(v.expect.dust)).toBe(BigInt(v.expect.T));
      for (const p of v.expect.payouts) {
        const stake = BigInt(v.backs.find((b) => b.op_id === p.op_id)!.amount);
        expect(BigInt(p.amount) >= stake).toBe(true);
      }
    }
  });
});
