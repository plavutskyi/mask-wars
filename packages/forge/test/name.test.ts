import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accountOf, cleanName, nameOk, RESERVED, reserved } from "../src/name.ts";

describe("names", () => {
  it("follows the factory's rule", () => {
    for (const ok of ["kira", "k1r", "a2345678901234bc"]) expect(nameOk(ok), ok).toBe(true);
    for (const bad of ["ki", "Kira", "9kira", "ki.ra", "ki-ra", "a2345678901234bcd", ""]) expect(nameOk(bad), bad).toBe(false);
  });

  it("keeps the arena's names, the same list as the contract", () => {
    const rust = readFileSync(new URL("../../../contracts/masks/factory/src/lib.rs", import.meta.url), "utf8");
    const list = /pub const RESERVED: \[&str; \d+\] = \[([^\]]+)\]/.exec(rust)![1]!;
    expect(RESERVED).toEqual([...list.matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
    expect(reserved("nova") && !reserved("kira")).toBe(true);
  });

  it("cleans what a person types", () => {
    expect(cleanName("  Kira-99 ")).toBe("kira99");
    expect(cleanName("A".repeat(20))).toHaveLength(16);
    expect(accountOf("kira", "masks.tinygif8324.testnet")).toBe("kira.masks.tinygif8324.testnet");
  });
});
