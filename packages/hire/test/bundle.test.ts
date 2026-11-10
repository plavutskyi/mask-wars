import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bundle, fonts, OUT, RELEASE, release } from "../scripts/bundle.ts";

// What maskwars.xyz serves to host pages is generated from this package: it must be what the source builds today.
describe("the files host pages load", () => {
  it("/hire/v1.js is the element as built from source (pnpm --filter @maskwars/hire build)", async () => {
    const built = await bundle();
    expect(readFileSync(new URL("v1.js", OUT), "utf8")).toBe(built);
    // One script with no imports and no secrets: it runs on someone else's page.
    expect(built).not.toMatch(/\bimport\s*[({"']|ONE_CLICK|authorization|Bearer/i);
    expect(built.length).toBeLessThan(16_000);
  }, 20_000);

  // The finding: hosts loaded a script that could change under them, with nothing to pin it by.
  it("is also published under a name that never changes, with the integrity hash /hire gives hosts", async () => {
    const built = await bundle();
    const r = JSON.parse(readFileSync(RELEASE, "utf8")) as { file: string; integrity: string };
    expect(r).toEqual(release(built));
    expect(r.file).toMatch(/^v1\.[0-9a-f]{10}\.js$/);
    const pinned = readFileSync(new URL(r.file, OUT));
    expect(pinned.toString("utf8")).toBe(built);
    // What a browser checks against `integrity=`: sha384 of the bytes it got.
    expect(`sha384-${createHash("sha384").update(pinned).digest("base64")}`).toBe(r.integrity);
  }, 20_000);

  it("the brand faces beside it are packages/brand's, byte for byte", () => {
    for (const [name, bytes] of fonts()) expect(Buffer.compare(readFileSync(new URL(name, OUT)), Buffer.from(bytes))).toBe(0);
  });
});
