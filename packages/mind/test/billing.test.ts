import { describe, expect, it } from "vitest";
import { NearAiProvider, nearAiCosts } from "../src/near-ai.ts";
import { ProviderError } from "../src/provider.ts";

const ID_A = "a8852c36-e02a-5853-95de-20964f56ecaa";
const ID_B = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

describe("the answer's id on NEAR AI's bill", () => {
  it("keeps the inference-id header of a chat answer, and nothing that is not a UUID", async () => {
    const answer = (id: string | null) =>
      (async (url: string | URL) =>
        String(url).endsWith("/chat/completions")
          ? new Response(JSON.stringify({ id: "c1", model: "z-ai/glm-5.3-flash", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 18, completion_tokens: 92 } }), {
              status: 200,
              headers: id ? { "inference-id": id, "x-request-id": "ce355002-0901-47b2-9575-5bd9e9664894" } : {},
            })
          : new Response("no", { status: 404 })) as typeof fetch;
    const ask = { model: "z-ai/glm-5.3-flash", messages: [{ role: "user" as const, content: "Say ok." }], maxTokens: 300, temperature: 0.4, timeoutMs: 600 };
    expect((await new NearAiProvider({ apiKey: "k", fetch: answer(ID_A.toUpperCase()) }).complete(ask)).inferenceId).toBe(ID_A);
    expect((await new NearAiProvider({ apiKey: "k", fetch: answer("not-an-id") }).complete(ask)).inferenceId).toBeUndefined();
    expect((await new NearAiProvider({ apiKey: "k", fetch: answer(null) }).complete(ask)).inferenceId).toBeUndefined();
  });
});

describe("an answer of no use", () => {
  it("carries what NEAR AI counted for it and its bill id, since it is billed all the same", async () => {
    const cut = (async () =>
      new Response(JSON.stringify({ id: "c1", model: "Qwen/Qwen3.8-27B-abliterated", choices: [{ message: { content: null }, finish_reason: "length" }], usage: { prompt_tokens: 16_378, completion_tokens: 24_000 } }), {
        status: 200,
        headers: { "inference-id": ID_A },
      })) as typeof fetch;
    const ask = { model: "Qwen/Qwen3.8-27B-abliterated", messages: [{ role: "user" as const, content: "plan" }], maxTokens: 24_000, temperature: 0.4, timeoutMs: 600 };
    const e = await new NearAiProvider({ apiKey: "k", fetch: cut }).complete(ask).catch((x: unknown) => x as ProviderError);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).message).toBe("the model spent all 24000 tokens before it answered");
    expect((e as ProviderError).billed).toMatchObject({ model: "Qwen/Qwen3.8-27B-abliterated", usage: { promptTokens: 16_378, completionTokens: 24_000, cachedTokens: 0 }, inferenceId: ID_A });
    expect((e as ProviderError).billed?.costUsd).toBeCloseTo((16_378 * 0.04 + 24_000 * 1.35) / 1e6, 12);
  });
});

describe("an answer cut off on its way", () => {
  const ask = { model: "z-ai/glm-5.3-flash", messages: [{ role: "user" as const, content: "plan" }], maxTokens: 300, temperature: 0.4, timeoutMs: 80 };
  /** NEAR AI takes the call and names it in the headers, and the body never comes before the deadline. */
  const slow = (id: string | null) =>
    (async (_url: string | URL, init: RequestInit = {}) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200, headers: id ? { "inference-id": id } : {} });
    }) as typeof fetch;

  it("keeps its id on the bill, marked cut, since NEAR AI bills it all the same", async () => {
    const e = await new NearAiProvider({ apiKey: "k", fetch: slow(ID_A) }).complete(ask).catch((x: unknown) => x as ProviderError);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).code).toBe("timeout");
    expect((e as ProviderError).billed).toEqual({ model: ask.model, usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }, costUsd: 0, inferenceId: ID_A, cut: true });
  });

  it("with no id there is nothing to price it by: a plain timeout", async () => {
    const e = await new NearAiProvider({ apiKey: "k", fetch: slow(null) }).complete(ask).catch((x: unknown) => x as ProviderError);
    expect((e as ProviderError).code).toBe("timeout");
    expect((e as ProviderError).billed).toBeUndefined();
  });
});

describe("nearAiCosts", () => {
  it("asks the bill by requestIds and keeps each answer it priced, in nano-dollars", async () => {
    const asked: unknown[] = [];
    const bill = (async (url: string | URL, init: RequestInit = {}) => {
      expect(String(url)).toBe("https://cloud-api.near.ai/v1/billing/costs");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
      const body = JSON.parse(String(init.body)) as { requestIds: string[] };
      asked.push(body.requestIds);
      // As NEAR AI answers: a known id with its cost, an unknown one at 0 with a warning, an id nobody asked about.
      return new Response(
        JSON.stringify({
          requests: [
            { requestId: ID_A, costNanoUsd: 51_700 },
            { requestId: ID_B, costNanoUsd: 0 },
            { requestId: "11111111-2222-3333-4444-555555555555", costNanoUsd: 9_000_000 },
          ],
          warning: "1 of 2 request IDs matched no usage record for this organization and report costNanoUsd 0.",
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const got = await nearAiCosts([ID_A, ID_B, ID_A, "x-request-id"], { apiKey: "k", fetch: bill });
    expect(asked).toEqual([[ID_A, ID_B]]);
    expect([...got]).toEqual([[ID_A, 51_700n]]);
  });

  it("asks in batches of 50 and leaves out a batch the bill did not answer", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
    let calls = 0;
    const bill = (async (_url: string | URL, init: RequestInit = {}) => {
      calls += 1;
      const body = JSON.parse(String(init.body)) as { requestIds: string[] };
      expect(body.requestIds.length).toBeLessThanOrEqual(50);
      if (calls === 2) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ requests: body.requestIds.map((requestId) => ({ requestId, costNanoUsd: 1_000 })) }), { status: 200 });
    }) as typeof fetch;
    const got = await nearAiCosts(ids, { apiKey: "k", fetch: bill });
    expect(calls).toBe(3);
    expect(got.size).toBe(70);
  });
});
