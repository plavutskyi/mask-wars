import { readFileSync } from "node:fs";
import { MODELS } from "@maskwars/arena/config";
import {
  ARENA_MODELS,
  FakeProvider,
  ProviderError,
  TEE_MODELS,
  costUsd,
  isTeeModel,
  type Completion,
  type CompletionRequest,
  type ModelVerification,
  type Provider,
} from "@maskwars/mind";
import { describe, expect, it } from "vitest";
import { ModelAttacker } from "../src/agent.ts";
import { mindRecord, nearPrice, ONE_CLICK_TOKENS, parseTab, trustAttested } from "../src/minds.ts";
import { challenge } from "./fixtures.ts";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USAGE = { promptTokens: 16_378, completionTokens: 14_516, cachedTokens: 16_320 };
const QWEN = "Qwen/Qwen3.8-27B-abliterated";

/** A provider that answers with fixed usage and the next inference-id, after `delayMs`. */
class Billed implements Provider {
  readonly id = "near-ai";
  n = 0;
  readonly delayMs: number;
  constructor(delayMs = 0) {
    this.delayMs = delayMs;
  }
  async complete(r: CompletionRequest): Promise<Completion> {
    this.n += 1;
    const n = this.n;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { text: "{}", model: r.model, requestHash: "", responseHash: "", usage: USAGE, costUsd: costUsd(r.model, USAGE), inferenceId: ID(n), signature: null, signatureVerified: false };
  }
}

const tokens = [{ assetId: "nep141:wrap.near", blockchain: "near", symbol: "wNEAR", decimals: 24, price: 3.69, priceUpdatedAt: "2026-11-12T18:20:00.000Z" }];

/** NEAR AI's bill and 1Click's token list: the bill knows `known` ids at once and `late` ones only when asked again. */
function services(o: { known: Record<string, number>; late?: Record<string, number> }) {
  const asks: string[][] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    if (String(url) === ONE_CLICK_TOKENS) return new Response(JSON.stringify(tokens), { status: 200 });
    const ids = (JSON.parse(String(init.body)) as { requestIds: string[] }).requestIds;
    asks.push(ids);
    const priced = asks.length === 1 ? o.known : { ...o.known, ...o.late };
    return new Response(JSON.stringify({ requests: ids.map((requestId) => ({ requestId, costNanoUsd: priced[requestId] ?? 0 })) }), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, asks };
}

describe("the masks' models", () => {
  it("gives each mask of the arena the model the arena's pages name, every one a TEE model", () => {
    expect(ARENA_MODELS).toEqual(MODELS);
    for (const m of Object.values(ARENA_MODELS)) expect(isTeeModel(m)).toBe(true);
    expect(ARENA_MODELS.ORACLE).toBe(QWEN);
    // The red-teaming build is the arena's own: a person's mask cannot pick it, and the mind module does not carry it.
    expect(Object.hasOwn(TEE_MODELS, QWEN)).toBe(false);
    expect(costUsd(QWEN, USAGE)).toBe(costUsd("Qwen/Qwen3.8-27B", USAGE));
  });

  it("races ONYX, NOVA and ORACLE in that order, as before", () => {
    expect(Object.keys(ARENA_MODELS)).toEqual(["ONYX", "NOVA", "ORACLE"]);
  });
});

describe("a mind's answers", () => {
  it("keeps each answer's usage, list price and bill id, and waits for a call still on its way", async () => {
    const c = await challenge("over-withdraw");
    const provider = new Billed(30);
    const m = new ModelAttacker({ id: "ORACLE", provider, model: QWEN });
    const first = m.propose(c, []);
    await m.idle();
    await first;
    void m.propose(c, []);
    expect(m.answers).toHaveLength(1);
    await m.idle();
    expect(m.answers).toHaveLength(2);
    expect(m.answers[1]).toEqual({ model: QWEN, usage: USAGE, listUsd: costUsd(QWEN, USAGE), inferenceId: ID(2), verified: false });
  });

  it("keeps whether each answer's TEE signature checked out against the race's attestation", async () => {
    const c = await challenge("over-withdraw");
    const signed: Provider = { id: "near-ai", complete: async (r) => ({ ...(await new Billed().complete(r)), signatureVerified: true }) };
    const m = new ModelAttacker({ id: "ORACLE", provider: signed, model: QWEN });
    await m.propose(c, []);
    expect(m.answers[0]?.verified).toBe(true);
  });

  it("keeps a call cut off after NEAR AI named it, for the bill to price, and counts one it never named as unanswered", async () => {
    const c = await challenge("over-withdraw");
    const none = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    const named = new ProviderError("timeout", "no answer in 300000ms", undefined, { model: QWEN, usage: none, costUsd: 0, inferenceId: ID(7), cut: true });
    const m = new ModelAttacker({ id: "ORACLE", provider: new FakeProvider([named, new ProviderError("timeout", "no answer in 300000ms")]), model: QWEN });
    await m.propose(c, []);
    await m.propose(c, []);
    expect(m.answers).toEqual([{ model: QWEN, usage: none, listUsd: 0, inferenceId: ID(7), cut: true, verified: false }]);
    expect(m.unanswered).toBe(1);
  });

  it("counts nothing for a call that brought no answer, and says so", async () => {
    const c = await challenge("over-withdraw");
    const m = new ModelAttacker({ id: "ONYX", provider: new FakeProvider([new Error("502 upstream request failed")]), model: "z-ai/glm-5.3-flash" });
    expect((await m.propose(c, [])).ok).toBe(false);
    expect(m.answers).toEqual([]);
    expect(m.unanswered).toBe(1);
  });

  it("counts an answer with no plan in it: NEAR AI bills it all the same", async () => {
    const c = await challenge("over-withdraw");
    const spent = { promptTokens: 16_378, completionTokens: 24_000, cachedTokens: 0 };
    const billed = { model: QWEN, usage: spent, costUsd: costUsd(QWEN, spent), inferenceId: ID(9) };
    const cut = new ProviderError("shape", "the model spent all 24000 tokens before it answered", undefined, billed);
    const m = new ModelAttacker({ id: "ORACLE", provider: new FakeProvider([cut]), model: QWEN });
    expect((await m.propose(c, [])).ok).toBe(false);
    expect(m.answers).toEqual([{ model: QWEN, usage: spent, listUsd: billed.costUsd, inferenceId: ID(9), verified: false }]);
    expect(m.unanswered).toBe(0);
  });
});

describe("the models' attestation as the race begins", () => {
  const verification = (model: string, outcome: ModelVerification["outcome"], signers: string[]): ModelVerification => ({
    model,
    nonce: "n",
    checkedAt: "2026-11-12T18:04:00Z",
    ms: 1,
    outcome,
    gateway: null,
    nodes: signers.map((signer) => ({ role: "model", signer, tcb: null, advisories: [], mrtd: null, gpus: null, checks: [] })),
    checks: [],
  });

  it("trusts the nodes of each model whose attestation passed, and no node of one that did not", async () => {
    const trusted: string[][] = [];
    const lines: string[] = [];
    const got = await trustAttested({ trust: (s) => void trusted.push([...s]) }, [QWEN, "z-ai/glm-5.3-flash", QWEN], {
      verify: async (model) => (model === QWEN ? verification(model, "pass", ["0xaa", "0xbb"]) : verification(model, "unavailable", ["0xcc"])),
      log: (l) => lines.push(l),
    });
    expect(got).toEqual({ [QWEN]: 2, "z-ai/glm-5.3-flash": 0 });
    expect(trusted).toEqual([["0xaa", "0xbb"]]);
    expect(lines.join("\n")).toMatch(/z-ai\/glm-5.3-flash: attestation unavailable: its answers count as not verified/);
  });
});

describe("mindRecord", () => {
  const own = [
    { name: "ORACLE", account: "oracle.maskwars.near", model: QWEN, answers: [1, 2, 3].map((n) => ({ model: QWEN, usage: USAGE, listUsd: 0.02, inferenceId: ID(n) })), unanswered: 1 },
    { name: "ONYX", account: "onyx.maskwars.near", model: "z-ai/glm-5.3-flash", answers: [{ model: "z-ai/glm-5.3-flash", usage: USAGE, listUsd: 0.004, inferenceId: null }], unanswered: 0 },
  ];

  it("prices every answer from NEAR AI's bill, asks again for the late ones, and reads NEAR's price", async () => {
    const s = services({ known: { [ID(1)]: 17_719_048, [ID(2)]: 19_892_680 }, late: { [ID(3)]: 10_000_000 } });
    const waits: number[] = [];
    const r = await mindRecord({ network: "mainnet", race: "race-0003", own, apiKey: "k", fetch: s.fetch, sleep: async (ms) => void waits.push(ms), now: () => 42 });
    expect(waits).toEqual([5_000, 20_000]);
    expect(s.asks).toEqual([[ID(1), ID(2), ID(3)], [ID(3)]]);
    const oracle = r.masks.find((m) => m.name === "ORACLE")!;
    expect(oracle).toMatchObject({ answers: 3, billed: 3, unanswered: 1, tokens: { prompt: 3 * 16_378, completion: 3 * 14_516, cached: 3 * 16_320 } });
    expect(oracle.usd).toBeCloseTo(0.047611728, 12);
    // No id: priced at the list price from its tokens, and said so.
    expect(r.masks.find((m) => m.name === "ONYX")).toMatchObject({ answers: 1, billed: 0, usd: 0.004 });
    expect(r).toMatchObject({ v: 1, network: "mainnet", race: "race-0003", at: 42, near: { usd: 3.69, at: "2026-11-12T18:20:00.000Z" } });
  });

  it("prices an answer the bill never knew at its list price", async () => {
    const s = services({ known: { [ID(1)]: 17_719_048 } });
    const r = await mindRecord({ network: "mainnet", race: "race-0003", own: [own[0]!], apiKey: "k", fetch: s.fetch, sleep: async () => {} });
    expect(r.masks[0]).toMatchObject({ answers: 3, billed: 1 });
    expect(r.masks[0]!.usd).toBeCloseTo(0.017719048 + 0.04, 12);
    // A tab from before the attestation check says nothing of it: neither does the record.
    expect(r.masks[0]).not.toHaveProperty("verified");
  });

  it("prices a call cut off on its way from the bill, and counts it as left out of the price when the bill does not know it", async () => {
    const none = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    const answers = [
      { model: QWEN, usage: USAGE, listUsd: 0.02, inferenceId: ID(1), verified: true },
      { model: QWEN, usage: none, listUsd: 0, inferenceId: ID(2), cut: true, verified: false },
      { model: QWEN, usage: none, listUsd: 0, inferenceId: ID(3), cut: true, verified: false },
    ];
    const s = services({ known: { [ID(1)]: 17_719_048, [ID(2)]: 30_000_000 } });
    const r = await mindRecord({ network: "mainnet", race: "race-0003", own: [{ ...own[0]!, answers, unanswered: 1 }], apiKey: "k", fetch: s.fetch, sleep: async () => {} });
    expect(r.masks[0]).toMatchObject({ answers: 2, billed: 2, unanswered: 2, verified: 1, tokens: { prompt: 16_378 } });
    expect(r.masks[0]!.usd).toBeCloseTo(0.047719048, 12);
  });

  it("asks no bill without a key, and adds the people's minds as their tokens counted", async () => {
    const s = services({ known: {} });
    const people = [{ name: "KIRA", account: "kira.masks.maskwars.near", model: "Qwen/Qwen3.8-27B", calls: 2, unanswered: 3, usd: 0.03, tokens: { promptTokens: 32_768, completionTokens: 20_480, cachedTokens: 0 } }];
    const r = await mindRecord({ network: "testnet", race: "human-0001", own, people, fetch: s.fetch, sleep: async () => {} });
    expect(s.asks).toEqual([]);
    expect(r.masks.map((m) => [m.name, m.billed, m.usd])).toEqual([
      ["ORACLE", 0, 0.06],
      ["ONYX", 0, 0.004],
      ["KIRA", 0, 0.03],
    ]);
  });

  it("writes no NEAR price when 1Click does not answer, and refuses a record that is not well formed", async () => {
    expect(await nearPrice((async () => new Response("down", { status: 502 })) as typeof fetch)).toBeNull();
    expect(await nearPrice((async () => new Response(JSON.stringify([{ ...tokens[0], price: 0 }]), { status: 200 })) as typeof fetch)).toBeNull();
    const s = services({ known: {} });
    await expect(mindRecord({ network: "mainnet", race: "../x", own, fetch: s.fetch, sleep: async () => {} })).rejects.toThrow(/not well formed/);
  });
});

describe("the tab", () => {
  it("goes from the race to its price as written, and nothing else passes for one", async () => {
    const c = await challenge("over-withdraw");
    const m = new ModelAttacker({ id: "ORACLE", provider: new Billed(), model: QWEN });
    await m.propose(c, []);
    const tab = { network: "mainnet", race: "race-0003", own: [{ name: "ORACLE", account: "oracle.maskwars.near", model: m.model, answers: m.answers, unanswered: m.unanswered }], people: [] };
    const read = parseTab(JSON.parse(JSON.stringify(tab)));
    expect(read).toEqual(tab);
    const s = services({ known: { [ID(1)]: 15_538_870 } });
    const r = await mindRecord({ ...read!, apiKey: "k", fetch: s.fetch, sleep: async () => {} });
    expect(r.masks[0]).toMatchObject({ name: "ORACLE", answers: 1, billed: 1, usd: 0.01553887 });
    for (const bad of [null, { ...tab, network: "devnet" }, { ...tab, own: [{ ...tab.own[0], unanswered: -1 }] }, { ...tab, own: [{ ...tab.own[0], answers: [{ model: QWEN }] }] }]) {
      expect(parseTab(bad)).toBeNull();
    }
  });
});

describe("the workflow", () => {
  const text = readFileSync(new URL("../../../.github/workflows/live-race.yml", import.meta.url), "utf8");
  const job = (name: string) => text.slice(text.indexOf(`\n  ${name}:\n`), text.indexOf("\n\n  ", text.indexOf(`\n  ${name}:\n`) + 1));

  it("hands the race's record on as minds-<race>, the name the site reads", () => {
    expect(job("race")).toContain('--minds "$RUNNER_TEMP/minds.json"');
    expect(job("minds")).toContain("name: minds-${{ inputs.bounty }}");
    const site = readFileSync(new URL("../../../apps/web/lib/minds.ts", import.meta.url), "utf8");
    expect(site).toContain("name: `minds-${race}`");
  });

  it("prices the minds beside the drain, never before the seal, with NEAR AI's key and no mask's", () => {
    const race = job("race");
    expect(race).not.toContain("scripts/minds.ts");
    expect(race).toContain("name: minds-tab");
    const minds = job("minds");
    expect(minds).toContain("needs: [guard, race]");
    expect(minds).toContain("NEAR_AI_API_KEY: ${{ secrets.NEAR_AI_API_KEY }}");
    expect(minds).toContain("--ignore-scripts");
    for (const key of ["MASK_KEYS", "KEEPER_SEED", "OUTLAYER_PAYMENT_KEY", "HOUSE_KEY"]) expect(minds).not.toContain(key);
    expect(job("drain")).not.toContain("minds");
  });
});
