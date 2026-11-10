import { readFileSync } from "node:fs";
import { TEE_MODELS } from "@maskwars/mind";
import { describe, expect, it } from "vitest";
import { LOOKS, MINDS, STYLES } from "../src/catalog.ts";

const root = new URL("../../../", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("contracts/masks/catalog.json", root), "utf8")) as Record<string, string[]>;

describe("catalog", () => {
  it("lists what the factory lists, in the same order", () => {
    expect(LOOKS.map((l) => l.id)).toEqual(catalog.looks);
    expect(MINDS.map((m) => m.id)).toEqual(catalog.models);
    expect(STYLES.map((s) => s.id)).toEqual(catalog.styles);
  });

  it("offers only the TEE models the masks think with, at their prices", () => {
    expect(MINDS.map((m) => m.id).sort()).toEqual(Object.keys(TEE_MODELS).sort());
    for (const m of MINDS) {
      const p = TEE_MODELS[m.id as keyof typeof TEE_MODELS];
      expect([m.input, m.output]).toEqual([p.input, p.output]);
    }
  });

  it("shows only art that is on the site", () => {
    for (const l of LOOKS) {
      expect(() => readFileSync(new URL(`apps/web/public${l.art}`, root))).not.toThrow();
    }
  });
});
