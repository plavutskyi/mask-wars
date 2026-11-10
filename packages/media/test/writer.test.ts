import { describe, expect, it } from "vitest";
import type { Writer } from "../src/index.ts";
import { keepsFacts, openRouterWriter, safeVariants } from "../src/index.ts";

const text = "@kaito_trades put $5 on ronin and left with $41.";
const fake = (out: string[]): Writer => ({ variants: async () => out });

describe("writer port", () => {
  it("keeps only variants with the same facts that pass lintPost", async () => {
    const v = await safeVariants(
      fake([
        "@kaito_trades backed ronin with $5 and walked out with $41.",
        "@kaito_trades put $5 on ronin and left with $410.", // changed number
        "@kaito_trades unleashed $5 on ronin, $41 out.", // AI word
        "ronin turned $5 into $41.", // lost the handle
      ]),
      text,
    );
    expect(v).toEqual(["@kaito_trades backed ronin with $5 and walked out with $41."]);
  });

  it("a writer that fails gives nothing, never an error", async () => {
    expect(await safeVariants({ variants: () => Promise.reject(new Error("down")) }, text)).toEqual([]);
  });

  it("facts", () => {
    expect(keepsFacts("$5 → $41 ×8.2", "×8.2: $5 then $41")).toBe(true);
    expect(keepsFacts("$5 and $41", "$5 and $42")).toBe(false);
  });

  it("OpenRouter goes through the injected fetch with the owner's key", async () => {
    let seen: { url: string; auth: string } | null = null;
    const w = openRouterWriter({
      apiKey: "test-key",
      model: "some/model",
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, auth: (init.headers as Record<string, string>).authorization! };
        return new Response(JSON.stringify({ choices: [{ message: { content: "1. one\n2. two" } }] }));
      }) as unknown as typeof fetch,
    });
    expect(await w.variants(text, 2)).toEqual(["one", "two"]);
    expect(seen).toEqual({ url: "https://openrouter.ai/api/v1/chat/completions", auth: "Bearer test-key" });
  });
});
