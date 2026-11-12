import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIBRARY } from "../src/index.ts";

// The library's titles are the targets' own: contracts/challenges/<id>/challenge.json.
describe("the library", () => {
  it.each(LIBRARY.map((e) => [e.id, e.title] as const))("%s is titled as its challenge.json", (id, title) => {
    const file = new URL(`../../../contracts/challenges/${id}/challenge.json`, import.meta.url);
    expect((JSON.parse(readFileSync(file, "utf8")) as { id: string; title: string }).title).toBe(title);
  });

  it("names every hole it lists in the challenges README", () => {
    const readme = readFileSync(new URL("../../../contracts/challenges/README.md", import.meta.url), "utf8");
    for (const e of LIBRARY.filter((x) => x.id !== "live-safe")) expect(readme).toContain(`\`${e.id}\``);
  });
});
