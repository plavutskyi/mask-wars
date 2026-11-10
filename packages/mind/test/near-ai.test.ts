import { describe, expect, it } from "vitest";
import { addressOfSecret, recoverAddress, signPersonal } from "../src/eth.ts";
import { NearAiProvider, checkSignature } from "../src/near-ai.ts";
import { costUsd } from "../src/models.ts";
import { ProviderError, sha256Hex } from "../src/provider.ts";

const SECRET = new Uint8Array(32).fill(7);
const SIGNER = addressOfSecret(SECRET);
const MODEL = "z-ai/glm-5.3-flash";

interface Seen {
  url: string;
  init: RequestInit;
}

/** A NEAR AI stand-in: answers chat and signature calls the way the docs describe. */
function fakeCloud(opts: { answerModel?: string; delayMs?: number; signatureStatus?: number[] } = {}) {
  const seen: Seen[] = [];
  let requestBody = "";
  let responseBody = "";
  const statuses = [...(opts.signatureStatus ?? [])];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    seen.push({ url: String(url), init });
    if (opts.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
    }
    if (String(url).endsWith("/chat/completions")) {
      requestBody = String(init.body);
      responseBody = JSON.stringify({
        id: "chatcmpl-1",
        model: opts.answerModel ?? MODEL,
        choices: [{ message: { content: '{"action":"HOLD"}' } }],
        usage: { prompt_tokens: 2000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1000 } },
      });
      return new Response(responseBody, { status: 200 });
    }
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response("not here", { status });
    const text = `${MODEL}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
    return new Response(
      JSON.stringify({ text, signature: signPersonal(text, SECRET), signing_address: SIGNER, signing_algo: "ecdsa", signature_kind: "provider_tee" }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetch: f, seen };
}

const ask = { model: MODEL, messages: [{ role: "user" as const, content: "hi" }], maxTokens: 60, temperature: 0.4, timeoutMs: 2_000 };

describe("NearAiProvider", () => {
  it("sends canonical model, no stream, x-no-aliasing, and verifies the TEE signature", async () => {
    const cloud = fakeCloud();
    const p = new NearAiProvider({ apiKey: "k", fetch: cloud.fetch, trustedSigners: [SIGNER] });
    const c = await p.complete(ask);
    const chat = cloud.seen[0]!;
    expect(chat.url).toBe("https://cloud-api.near.ai/v1/chat/completions");
    const headers = chat.init.headers as Record<string, string>;
    expect(headers["x-no-aliasing"]).toBe("true");
    expect(headers.authorization).toBe("Bearer k");
    const body = JSON.parse(String(chat.init.body));
    expect(body).toMatchObject({ model: MODEL, stream: false, max_tokens: 60 });
    expect(c.text).toBe('{"action":"HOLD"}');
    expect(c.signature?.kind).toBe("provider_tee");
    expect(c.signatureVerified).toBe(true);
    expect(c.requestHash).toBe(sha256Hex(String(chat.init.body)));
    expect(c.costUsd).toBeCloseTo(costUsd(MODEL, { promptTokens: 2000, completionTokens: 300, cachedTokens: 1000 }));
  });

  it("logs but does not trust a signature from an unknown signer", async () => {
    const p = new NearAiProvider({ apiKey: "k", fetch: fakeCloud().fetch, trustedSigners: ["0x" + "1".repeat(40)] });
    const c = await p.complete(ask);
    expect(c.signature).not.toBeNull();
    expect(c.signatureVerified).toBe(false);
  });

  it("retries a signature that lands on another node", async () => {
    const p = new NearAiProvider({ apiKey: "k", fetch: fakeCloud({ signatureStatus: [404] }).fetch, trustedSigners: [SIGNER] });
    expect((await p.complete(ask)).signatureVerified).toBe(true);
  });

  it("refuses models off the Private TEE list and answers from an alias", async () => {
    const p = new NearAiProvider({ apiKey: "k", fetch: fakeCloud().fetch });
    await expect(p.complete({ ...ask, model: "anthropic/claude-haiku-5-5" })).rejects.toBeInstanceOf(ProviderError);
    const aliased = new NearAiProvider({ apiKey: "k", fetch: fakeCloud({ answerModel: "zai-org/GLM-5.1-FP8" }).fetch });
    await expect(aliased.complete(ask)).rejects.toThrow(/answered by/);
  });

  it("times out instead of hanging", async () => {
    const p = new NearAiProvider({ apiKey: "k", fetch: fakeCloud({ delayMs: 5_000 }).fetch });
    await expect(p.complete({ ...ask, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("signatures", () => {
  it("recovers the EIP-191 signer", () => {
    expect(recoverAddress("hello", signPersonal("hello", SECRET))).toBe(SIGNER);
    expect(recoverAddress("hello", "0x1234")).toBeNull();
  });

  it("rejects a gateway signature, a swapped hash or another model", () => {
    const req = sha256Hex("req");
    const res = sha256Hex("res");
    const text = `${MODEL}:${req}:${res}`;
    const sig = { text, signature: signPersonal(text, SECRET), signingAddress: SIGNER, signingAlgo: "ecdsa", kind: "provider_tee" as const };
    const signers = new Set([SIGNER]);
    expect(checkSignature(sig, { model: MODEL, requestHash: req, responseHash: res, signers })).toBe(true);
    expect(checkSignature(sig, { model: MODEL, requestHash: res, responseHash: req, signers })).toBe(false);
    expect(checkSignature(sig, { model: "Qwen/Qwen3.8-27B", requestHash: req, responseHash: res, signers })).toBe(false);
    expect(checkSignature({ ...sig, kind: "gateway" }, { model: MODEL, requestHash: req, responseHash: res, signers })).toBe(false);
  });
});
