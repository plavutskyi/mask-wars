import { describe, expect, it } from "vitest";
import type { AgentPublic, MyAssignments, PlatformStats, X402Recipients } from "../src/api.ts";
import { MarketClient, MarketError, tokenOk } from "../src/client.ts";
import { TOKEN, fakeMarket, fixture } from "./market.ts";
import { API_VERSION, violations } from "./schema.ts";

describe("recorded answers of market.near.ai", () => {
  it("are recorded against API 2.0.0", () => {
    expect(API_VERSION).toBe("2.0.0");
  });

  it("platform stats, x402 payees and a catalog row hold to the published schemas", () => {
    expect(violations("PlatformStatsResponse", fixture("recorded/platform-stats").body)).toEqual([]);
    expect(violations("X402RecipientsResponse", fixture("recorded/x402-recipients").body)).toEqual([]);
    expect(violations("BrowseAgentsResponse", fixture("recorded/browse-finance").body)).toEqual([]);
  });

  it("reads the public endpoints without a token", async () => {
    const { client, seen } = fakeMarket(
      {
        "GET /v1/platform/stats": fixture("recorded/platform-stats"),
        "GET /.well-known/x402": fixture("recorded/x402-recipients"),
        "GET /v1/agents": fixture("recorded/browse-finance"),
      },
      null,
    );
    const stats: PlatformStats = await client.stats();
    expect(stats.live_agents).toBeGreaterThan(0);
    const x402: X402Recipients = await client.x402Recipients();
    expect(x402.x402Version).toBe(2);
    expect(x402.recipients.map((r) => r.network)).toContain("near:mainnet");
    const agents: AgentPublic[] = await client.browseAgents({ category: "finance", sort: "delivered", limit: 1 });
    expect(agents[0]?.category).toBe("finance");
    expect(seen.map((s) => s.path)).toEqual(["/v1/platform/stats", "/.well-known/x402", "/v1/agents?category=finance&sort=delivered&limit=1"]);
    expect(seen.every((s) => s.auth === null)).toBe(true);
  });

  it("an unknown handle is null, not an error", async () => {
    const { client } = fakeMarket({ "GET /v1/agents/maskwars": fixture("recorded/agent-unknown") });
    expect(await client.agent("maskwars")).toBeNull();
  });

  it("a refusal carries the API's own code and is not retryable", async () => {
    const { client } = fakeMarket({ "GET /v1/agents/me/assignments": fixture("recorded/assignments-no-token") });
    const error = await client.assignments().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketError);
    expect(error).toMatchObject({ status: 401, code: "unauthorized", retryable: false });
  });
});

describe("the agent's own work", () => {
  it("sends the token as a bearer and reads the assignments", async () => {
    const { client, seen } = fakeMarket({ "GET /v1/agents/me/assignments": fixture("docs/assignments-a2a") });
    const list: MyAssignments = await client.assignments({ status: "in_progress", limit: 100 });
    expect(violations("MyAssignmentsResponse", fixture("docs/assignments-a2a").body)).toEqual([]);
    expect(list.assignments[0]?.job.title).toBe("Check before paying");
    expect(seen[0]).toMatchObject({ method: "GET", path: "/v1/agents/me/assignments?status=in_progress&limit=100", auth: `Bearer ${TOKEN}` });
  });

  it("start, submit and decline send what the API takes", async () => {
    const id = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
    const { client, seen } = fakeMarket({
      [`POST /v1/assignments/${id}/start`]: fixture("docs/start"),
      [`POST /v1/assignments/${id}/submit`]: fixture("docs/submit-a2a"),
      [`POST /v1/assignments/${id}/decline`]: fixture("docs/submit-a2a"),
    });
    expect((await client.start(id)).startedAt).toBe("2026-11-07T23:10:01Z");
    const done = await client.submit(id, { deliverableMarkdown: "# MASK CHECK: ALLOW" });
    expect(done.status).toBe("accepted");
    await client.decline(id, { reason: "rejected", detail: "x".repeat(1500) });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST /v1/assignments/${id}/start`,
      `POST /v1/assignments/${id}/submit`,
      `POST /v1/assignments/${id}/decline`,
    ]);
    expect(violations("SubmitRequest", seen[1]?.body, { strict: true })).toEqual([]);
    expect(violations("DeclineAssignmentRequest", seen[2]?.body, { strict: true })).toEqual([]);
    expect((seen[2]?.body as { detail: string }).detail).toHaveLength(1000);
    expect(violations("JobAssignment", fixture("docs/submit-a2a").body)).toEqual([]);
    expect(violations("StartAssignmentResponse", fixture("docs/start").body)).toEqual([]);
  });

  it("refuses an empty or oversized deliverable before sending it", async () => {
    const { client, seen } = fakeMarket({});
    await expect(client.submit("a", { deliverableMarkdown: "" })).rejects.toMatchObject({ code: "invalid_deliverable" });
    await expect(client.submit("a", { deliverableMarkdown: "é".repeat(131_073) })).rejects.toMatchObject({ code: "invalid_deliverable" });
    expect(seen).toEqual([]);
  });

  it("a worker call without a token fails before any request", async () => {
    const { client, seen } = fakeMarket({}, null);
    await expect(client.assignments()).rejects.toMatchObject({ code: "no_token" });
    expect(seen).toEqual([]);
  });

  it("reads a competition's counts and the entry it may see", async () => {
    const id = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    const { client } = fakeMarket({ [`GET /v1/jobs/${id}/entries`]: fixture("docs/competition-settled") });
    expect(violations("CompetitionResponse", fixture("docs/competition-settled").body)).toEqual([]);
    const c = await client.competition(id);
    expect(c).toMatchObject({ state: "settled", poolToken: "USDC", entriesCount: 7, awardedCount: 2 });
    expect(c.entries[0]?.score).toBe(90);
  });
});

describe("failures", () => {
  it("5xx and 429 are retryable, with the wait the API asked for", async () => {
    const { client } = fakeMarket({
      "GET /v1/platform/stats": { status: 503, body: { error: "unavailable", message: "try later" } },
      "GET /.well-known/x402": { status: 429, body: { error: "rate_limited", message: "slow down", retry_after: 12 } },
    });
    await expect(client.stats()).rejects.toMatchObject({ status: 503, retryable: true });
    await expect(client.x402Recipients()).rejects.toMatchObject({ status: 429, retryable: true, retryAfter: 12 });
  });

  it("a dropped connection is a retryable network error", async () => {
    const client = new MarketClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(client.stats()).rejects.toMatchObject({ status: 0, code: "network", retryable: true });
  });

  it("never puts the token in an error", async () => {
    const { client } = fakeMarket({ "GET /v1/agents/me/assignments": fixture("recorded/assignments-no-token") });
    const error = (await client.assignments().catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("tokenOk", () => {
  it("takes a token as issued and refuses what a paste gets wrong", () => {
    expect(tokenOk(TOKEN)).toBe(true);
    expect(tokenOk(`Bearer ${TOKEN}`)).toBe(false);
    expect(tokenOk("wk_00000000000000000000000000000000")).toBe(false);
    expect(tokenOk("aat_")).toBe(false);
    expect(() => new MarketClient({ token: `Bearer ${TOKEN}` })).toThrow(/aat_/);
    expect(new MarketClient({ token: ` ${TOKEN}\n` }).hasToken).toBe(true);
  });
});
