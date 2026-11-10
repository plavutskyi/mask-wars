import { describe, expect, it } from "vitest";
import { BUDGETS, MAX_BODY_BYTES, callerOf, createBudget, createLimiter } from "../src/index.ts";
import { ENDPOINT, setup, text } from "./helpers.ts";

const tight = (http: number, tools: number) => ({
  http: { perCaller: http, perInstance: 1_000, windowMs: 60_000 },
  check: { perCaller: tools, perInstance: 1_000, windowMs: 60_000 },
  race: { perCaller: tools, perInstance: 1_000, windowMs: 60_000 },
  arena: { perCaller: tools, perInstance: 1_000, windowMs: 60_000 },
});

describe("limits on the server", () => {
  it("each tool has its own budget per caller, and says when to come back", async () => {
    const s = setup({ budgets: tight(1_000, 2) });
    const agent = await s.connect("legacy", "198.51.100.1");
    for (let i = 0; i < 2; i++) expect((await agent.callTool({ name: "get_race", arguments: { id: "race-0003" } })).isError).toBeFalsy();
    const third = await agent.callTool({ name: "get_race", arguments: { id: "race-0003" } });
    expect(third.isError).toBe(true);
    expect(text(third)).toMatch(/^Too many get_race calls: wait \d+ s and call again \(2 a minute per caller\)\.$/);
    // The other tools and other callers are not held up.
    expect((await agent.callTool({ name: "check_account", arguments: { account: "nova.tinygif8324.testnet" } })).isError).toBeFalsy();
    const other = await s.connect("legacy", "198.51.100.2");
    expect((await other.callTool({ name: "get_race", arguments: { id: "race-0003" } })).isError).toBeFalsy();
    await agent.close();
    await other.close();
  });

  it("a flood of requests gets 429 with retry-after before any server is built", async () => {
    const s = setup({ budgets: tight(2, 1_000) });
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await s.post(ping)).status).toBe(200);
    expect((await s.post(ping)).status).toBe(200);
    const flood = await s.post(ping);
    expect(flood.status).toBe(429);
    expect(Number(flood.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await flood.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000, message: expect.stringMatching(/^Too many requests: wait \d+ s/) } });
    // Someone else still gets in.
    expect((await s.post(ping, { "x-real-ip": "192.0.2.99" })).status).toBe(200);
  });

  it("refuses a body bigger than any call to these tools", async () => {
    const s = setup();
    const res = await s.post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_race", arguments: { id: "x".repeat(MAX_BODY_BYTES) } } });
    expect(res.status).toBe(413);
  });

  it("the default budgets match /api/check for MASK CHECK", () => {
    expect(BUDGETS.check).toEqual({ perCaller: 30, perInstance: 600, windowMs: 60_000 });
  });
});

describe("the endpoint over HTTP", () => {
  it("a crawler or a script opening /mcp sees how to connect", async () => {
    const s = setup();
    const res = await s.serve(new Request(ENDPOINT, { headers: { accept: "*/*" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toMatchObject({
      name: "maskwars",
      transport: "streamable-http",
      endpoint: ENDPOINT,
      tools: ["get_live_race", "list_races", "get_race", "get_mask", "get_league", "get_rules", "check_account"],
      connect: { claude_code: `claude mcp add --transport http maskwars ${ENDPOINT}`, codex: `codex mcp add maskwars --url ${ENDPOINT}` },
    });
  });

  it("a browser goes to the page for people when there is one", async () => {
    const browser = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
    const page = setup({ page: "/mcp/connect" });
    const res = await page.serve(new Request(ENDPOINT, { headers: browser }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/mcp/connect");
    // Without a page, a browser gets the JSON card; an MCP client is never redirected.
    expect((await setup().serve(new Request(ENDPOINT, { headers: browser }))).status).toBe(200);
    expect((await page.serve(new Request(ENDPOINT, { headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-06-18" } }))).status).toBe(405);
  });

  it("holds no stream open: an SSE GET is refused and no list changes are advertised", async () => {
    const s = setup();
    const res = await s.serve(new Request(ENDPOINT, { headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-06-18" } }));
    expect(res.status).toBe(405);
    const client = await s.connect("modern");
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false });
    await client.close();
  });

  it("answers the browser preflight for any origin", async () => {
    const s = setup();
    const res = await s.serve(new Request(ENDPOINT, { method: "OPTIONS", headers: { origin: "https://agent.example", "access-control-request-method": "POST" } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("serves a 2025 client without a session: each POST stands alone", async () => {
    const s = setup();
    const res = await s.post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_race", arguments: { id: "race-0003" } } });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = await res.text();
    const json = JSON.parse(body.startsWith("event:") ? body.split("\ndata: ")[1]!.split("\n")[0]! : body) as { id: number; result: { structuredContent: { winner: string } } };
    expect(json.id).toBe(7);
    expect(json.result.structuredContent.winner).toBe("nova.tinygif8324.testnet");
  });

  it("refuses a body that is not JSON", async () => {
    const s = setup();
    const res = await s.post("hello", { "content-type": "text/plain" });
    expect(res.status).toBe(415);
  });
});

describe("createLimiter", () => {
  it("lets a caller through up to the limit, then says when to come back", () => {
    const l = createLimiter({ perWindow: 2, windowMs: 60_000 });
    expect(l.take("a", 0)).toBeNull();
    expect(l.take("a", 1_000)).toBeNull();
    expect(l.take("a", 2_000)).toBe(58);
    expect(l.take("b", 2_000)).toBeNull();
    expect(l.take("a", 60_000)).toBeNull();
  });

  it("keeps its memory bounded", () => {
    const l = createLimiter({ perWindow: 1, windowMs: 60_000, maxKeys: 2 });
    l.take("a", 0);
    l.take("b", 0);
    expect(l.take("c", 0)).toBeNull();
    expect(l.take("a", 0)).toBeNull();
  });

  it("a budget stops the whole instance too", () => {
    const b = createBudget({ perCaller: 5, perInstance: 2, windowMs: 60_000 });
    expect(b.take("a", 0)).toBeNull();
    expect(b.take("b", 0)).toBeNull();
    expect(b.take("c", 0)).toBe(60);
  });
});

describe("callerOf", () => {
  it("reads the address Vercel reports", () => {
    expect(callerOf(new Request("https://x", { headers: { "x-real-ip": "1.2.3.4" } }))).toBe("1.2.3.4");
    expect(callerOf(new Request("https://x", { headers: { "x-forwarded-for": "5.6.7.8, 10.0.0.1" } }))).toBe("5.6.7.8");
    expect(callerOf(new Request("https://x"))).toBe("unknown");
    expect(callerOf(undefined)).toBe("local");
  });
});
