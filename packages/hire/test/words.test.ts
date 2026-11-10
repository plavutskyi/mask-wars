import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// What the button and its checkout say: only what the code does today. No bid exists yet and nobody is hired by a
// payment (the job contract is still being built), so no screen may say otherwise; and a host page must be told plainly
// that the events it hears are no proof of payment.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(join(ROOT, p)).isDirectory()) return files(p);
    return /\.(tsx?|json)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });
const shown = [...files("apps/web/app/hire"), ...files("packages/hire/src")];

describe("the words on the hire screens", () => {
  // The finding: «Back it», «Masks take it once the bid opens», «until the bid opens» — promises the code does not keep.
  it("promise no bid, no backing and no masks taking the money: they fund the team's own vault", () => {
    for (const f of shown) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect([f, text.match(/bid opens|until the bid|back it with|backs it|masks take it/i)?.[0] ?? null]).toEqual([f, null]);
    }
    expect(readFileSync(join(ROOT, "apps/web/app/hire/page.tsx"), "utf8")).toContain("funds its own vault for it");
  });

  // The finding: `hire:funded` could be dispatched by any script, and nothing said not to trust it.
  it("tell a host page to check the chain, never to grant access on an event", () => {
    expect(readFileSync(join(ROOT, "packages/hire/README.md"), "utf8")).toContain("Never grant access on an event");
    expect(readFileSync(join(ROOT, "packages/hire/src/element.ts"), "utf8")).toContain("never grants access on an event alone");
    expect(readFileSync(join(ROOT, "apps/web/app/hire/Embed.tsx"), "utf8")).toContain("check it on chain");
  });
});
