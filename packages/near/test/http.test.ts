import { afterEach, describe, expect, it } from "vitest";
import { BTC, USDC } from "../src/assets.ts";
import { HttpAgentApi } from "../src/api.ts";
import { VirtualClock } from "../src/clock.ts";
import { AgentApiError } from "../src/errors.ts";
import { FakeAgentApi } from "../src/fake/api.ts";
import { serveFake, type FakeServer } from "../src/fake/server.ts";
import { MemoryIdempotencyStore } from "../src/safe/store.ts";
import { SafeMoney } from "../src/safe/money.ts";

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start() {
  const clock = new VirtualClock();
  const fake = new FakeAgentApi({ clock, seed: 3 });
  const a = fake.createAgent("left");
  clock.advance(10_000);
  fake.fund(a.id, USDC, "50000000");
  server = await serveFake(fake);
  const api = new HttpAgentApi({ apiKey: "naa_test", baseUrl: server.url, grants: { [a.id]: "ngt_test" } });
  return { clock, fake, a, api };
}

describe("HttpAgentApi against the fake over HTTP", () => {
  it("tokens, agent, wallet, balances", async () => {
    const { api, a } = await start();
    expect((await api.getTokens()).map((t) => t.asset_id)).toContain(BTC);
    expect((await api.getAgent(a.id)).status).toBe("ACTIVE");
    expect((await api.listAgents()).data).toHaveLength(1);
    expect((await api.getWallet(a.id)).near_account_id).toMatch(/^[0-9a-f]{64}$/);
    expect((await api.getBalances(a.id)).balances[0]?.balance_raw).toBe("50000000");
  });

  it("dry quote, swap, status, proof through SafeMoney", async () => {
    const { api, a, clock } = await start();
    const quote = await api.quoteSwap(a.id, { origin_asset: USDC, destination_asset: BTC, amount: "1000000" });
    expect(quote.dry).toBe(true);
    expect(Number(quote.fee?.percent)).toBeGreaterThan(0);
    const money = new SafeMoney({ api, store: new MemoryIdempotencyStore(), clock });
    const out = await money.execute({ kind: "swap", agentId: a.id, logicalId: "h1", body: { origin_asset: USDC, destination_asset: BTC, amount: "1000000", confidential: false } });
    expect(out.state).toBe("SUCCESS");
    const proof = await api.getOperationProof(a.id, out.status!.correlation_id);
    expect(proof.origin).toContain("fake");
    expect(proof.events.length).toBeGreaterThan(1);
  });

  it("errors arrive as AgentApiError with code, layer and Retry-After", async () => {
    const { api, a, fake } = await start();
    fake.failNext("sponsor_busy");
    const err = await api.swap(a.id, { origin_asset: USDC, destination_asset: BTC, amount: "1" }, { idempotencyKey: "http-key-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentApiError);
    expect(err).toMatchObject({ code: "sponsor_busy", layer: "api", status: 503, retryable: true, retryAfterSeconds: 10 });
  });

  it("money calls need a grant token for that agent", async () => {
    const { a, fake } = await start();
    const api = new HttpAgentApi({ apiKey: "naa_test", baseUrl: server!.url });
    await expect(api.swap(a.id, { origin_asset: USDC, destination_asset: BTC, amount: "1" }, { idempotencyKey: "http-key-2" })).rejects.toThrow(/no grant/);
    expect(fake.calls.filter((c) => c.method === "swap")).toHaveLength(0);
  });

  it("rejects bad idempotency keys and plain-http remote hosts", () => {
    expect(() => new HttpAgentApi({ apiKey: "k", baseUrl: "http://example.com" })).toThrow(/HTTPS/);
    const api = new HttpAgentApi({ apiKey: "k", baseUrl: "http://127.0.0.1:1" });
    expect(() => api.swap("a", { origin_asset: USDC, destination_asset: BTC, amount: "1" }, { idempotencyKey: "short" })).toThrow(/Idempotency-Key/);
  });
});
