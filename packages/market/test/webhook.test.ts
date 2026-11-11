import { describe, expect, it, vi } from "vitest";
import { type HireCreatedEvent, createWebhookHandler, serveHire, signature, verifyDelivery } from "../src/webhook.ts";
import { fakeMarket, fixture, result } from "./market.ts";

const SECRET = "test-webhook-secret-0123456789abcdef";
const TS = "1762556400";
const NOW = Number(TS) * 1000;
const PING = '{"event":"webhook.ping","agent_id":"9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","delivery_id":"test-1","test":true}';
const HIRE = fixture("docs/hire-created").body as HireCreatedEvent;
const ID = HIRE.assignment_id;

function delivery(body: string, over: Record<string, string> = {}): Request {
  return new Request("https://maskwars.example/hook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-market-event": (JSON.parse(body) as { event: string }).event,
      "x-market-delivery": "d-1",
      "x-market-timestamp": TS,
      "x-market-signature": signature(SECRET, TS, body),
      ...over,
    },
    body,
  });
}

describe("signature", () => {
  it("matches HMAC-SHA256 over `<timestamp>.<raw body>` as the marketplace documents it", () => {
    // Computed independently with Python's hmac module.
    expect(signature(SECRET, TS, PING)).toBe("sha256=8cbac88ea867f67a773f017ca44ee77276ddd5c452d84d31fec866121fd10b01");
  });

  it("refuses a stale, missing or wrong signature", () => {
    const ok = { secret: SECRET, timestamp: TS, signature: signature(SECRET, TS, PING), rawBody: PING, nowMs: NOW };
    expect(verifyDelivery(ok)).toEqual({ ok: true });
    expect(verifyDelivery({ ...ok, nowMs: NOW + 301_000 })).toEqual({ ok: false, why: "stale timestamp" });
    expect(verifyDelivery({ ...ok, signature: null })).toEqual({ ok: false, why: "no signature" });
    expect(verifyDelivery({ ...ok, timestamp: null })).toEqual({ ok: false, why: "no timestamp" });
    expect(verifyDelivery({ ...ok, rawBody: `${PING} ` })).toEqual({ ok: false, why: "bad signature" });
    expect(verifyDelivery({ ...ok, secret: `${SECRET}x` })).toEqual({ ok: false, why: "bad signature" });
  });
});

describe("createWebhookHandler", () => {
  const handler = (onHire = vi.fn(async () => {}), waitUntil?: (p: Promise<unknown>) => void) => ({
    onHire,
    handle: createWebhookHandler({ secret: SECRET, onHire, now: () => NOW, ...(waitUntil ? { waitUntil } : {}) }),
  });

  it("refuses a short secret and a handler with nothing to do", () => {
    expect(() => createWebhookHandler({ secret: "short", onHire: async () => {} })).toThrow(/32/);
    expect(() => createWebhookHandler({ secret: SECRET })).toThrow(/onHire/);
  });

  it("answers a ping with 200 and does no work", async () => {
    const { onHire, handle } = handler();
    const res = await handle(delivery(PING));
    expect(res.status).toBe(200);
    expect(onHire).not.toHaveBeenCalled();
  });

  it("answers a hire at once and works it after, through waitUntil", async () => {
    const tasks: Promise<unknown>[] = [];
    const { onHire, handle } = handler(vi.fn(async () => {}), (p) => tasks.push(p));
    const res = await handle(delivery(JSON.stringify(HIRE)));
    expect(res.status).toBe(200);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(onHire).toHaveBeenCalledWith(HIRE);
  });

  it("takes a repeated delivery once", async () => {
    const { onHire, handle } = handler();
    await handle(delivery(JSON.stringify(HIRE)));
    const again = await handle(delivery(JSON.stringify(HIRE)));
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(onHire).toHaveBeenCalledTimes(1);
  });

  it("refuses an unsigned or forged delivery, a bad body and anything but POST", async () => {
    const { onHire, handle } = handler();
    expect((await handle(delivery(PING, { "x-market-signature": signature("another-secret-0123456789abcdefghij", TS, PING) }))).status).toBe(401);
    const forged = delivery(JSON.stringify({ ...HIRE, amount: "0" }), { "x-market-signature": signature(SECRET, TS, JSON.stringify(HIRE)) });
    expect((await handle(forged)).status).toBe(401);
    const notJson = "not json";
    expect((await handle(new Request("https://x/hook", { method: "POST", headers: { "x-market-timestamp": TS, "x-market-signature": signature(SECRET, TS, notJson) }, body: notJson }))).status).toBe(400);
    expect((await handle(new Request("https://x/hook"))).status).toBe(405);
    expect(onHire).not.toHaveBeenCalled();
  });

  it("works a change request and a redo the same way: by reading the assignment back", async () => {
    const { onHire, handle } = handler();
    for (const [i, event] of ["hire.changes_requested", "hire.dispute_resolved"].entries()) {
      const body = JSON.stringify({ event, job_id: HIRE.job_id, assignment_id: ID });
      expect((await handle(delivery(body, { "x-market-delivery": `again-${i}` }))).status).toBe(200);
      expect(onHire).toHaveBeenLastCalledWith({ event, job_id: HIRE.job_id, assignment_id: ID });
    }
    expect(onHire).toHaveBeenCalledTimes(2);
  });

  it("takes no work from an event that names no assignment, or from one that only reports", async () => {
    const { onHire, handle } = handler();
    const events = [
      { event: "hire.created", hire_id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", hirer_account_id: "x", kind: "manual" },
      { event: "hire.accepted", job_id: HIRE.job_id, assignment_id: ID },
      { event: "hire.refunded", job_id: HIRE.job_id, assignment_id: ID, amount: "0.10", token: "USDC", reason: "buyer_cancelled" },
      { event: "message.created", job_id: HIRE.job_id, assignment_id: ID },
      { event: "agent.suspended", agent_id: "x", reason: "policy", disposition: "halt" },
    ];
    for (const [i, e] of events.entries()) expect((await handle(delivery(JSON.stringify(e), { "x-market-delivery": `other-${i}` }))).status).toBe(200);
    expect(onHire).not.toHaveBeenCalled();
  });

  it("a failed hire is logged, never thrown into the response", async () => {
    const lines: string[] = [];
    const tasks: Promise<unknown>[] = [];
    const handle = createWebhookHandler({
      secret: SECRET,
      now: () => NOW,
      onHire: async () => {
        throw new Error("market down");
      },
      waitUntil: (p) => tasks.push(p),
      log: (l) => lines.push(l),
    });
    expect((await handle(delivery(JSON.stringify(HIRE)))).status).toBe(200);
    await Promise.all(tasks);
    expect(lines.at(-1)).toBe(`hire.created ${ID} failed: market down; a poll of the agent's assignments picks it up`);
  });
});

describe("serveHire", () => {
  it("reads the assignment back and works it", async () => {
    const { client, seen } = fakeMarket({
      "GET /v1/agents/me/assignments": fixture("docs/assignments-a2a"),
      [`POST /v1/assignments/${ID}/start`]: fixture("docs/start"),
      [`POST /v1/assignments/${ID}/submit`]: fixture("docs/submit-a2a"),
    });
    expect(await serveHire(HIRE, { client, check: async (a) => result(a, "allow") })).toBe("submitted");
    expect(seen.map((s) => s.method + " " + s.path.split("?")[0])).toEqual([
      "GET /v1/agents/me/assignments",
      `POST /v1/assignments/${ID}/start`,
      `POST /v1/assignments/${ID}/submit`,
    ]);
  });

  it("tries again when the marketplace fails in a way it calls retryable, and gives up on anything else", async () => {
    let submits = 0;
    const flaky = fakeMarket({
      "GET /v1/agents/me/assignments": fixture("docs/assignments-a2a"),
      [`POST /v1/assignments/${ID}/start`]: fixture("docs/start"),
      [`POST /v1/assignments/${ID}/submit`]: () => (++submits === 1 ? { status: 502, body: { error: "bad_gateway", message: "upstream" } } : fixture("docs/submit-a2a")),
    });
    const lines: string[] = [];
    expect(await serveHire(HIRE, { client: flaky.client, check: async (a) => result(a, "allow"), retryDelaysMs: [0], log: (l) => lines.push(l) })).toBe("submitted");
    expect(submits).toBe(2);
    expect(lines.some((l) => l.startsWith(`retry   ${ID}: POST /v1/assignments/${ID}/submit: 502`))).toBe(true);

    const down = fakeMarket({ "GET /v1/agents/me/assignments": { status: 503, body: { error: "unavailable", message: "later" } } });
    await expect(serveHire(HIRE, { client: down.client, check: vi.fn(), retryDelaysMs: [0, 0] })).rejects.toMatchObject({ status: 503 });
    expect(down.seen).toHaveLength(3);

    const revoked = fakeMarket({ "GET /v1/agents/me/assignments": fixture("recorded/assignments-no-token") });
    await expect(serveHire(HIRE, { client: revoked.client, check: vi.fn(), retryDelaysMs: [0, 0] })).rejects.toMatchObject({ status: 401 });
    expect(revoked.seen).toHaveLength(1);
  });

  it("does nothing when the hire is no longer in progress", async () => {
    const { client, seen } = fakeMarket({ "GET /v1/agents/me/assignments": { status: 200, body: { assignments: [] } } });
    expect(await serveHire(HIRE, { client, check: vi.fn() })).toBe("skipped");
    expect(seen).toHaveLength(1);
  });

  it("the default handler wires serveHire end to end", async () => {
    const { client, seen } = fakeMarket({
      "GET /v1/agents/me/assignments": fixture("docs/assignments-a2a"),
      [`POST /v1/assignments/${ID}/start`]: fixture("docs/start"),
      [`POST /v1/assignments/${ID}/submit`]: fixture("docs/submit-a2a"),
    });
    const tasks: Promise<unknown>[] = [];
    const handle = createWebhookHandler({ secret: SECRET, client, check: async (a) => result(a, "warn"), now: () => NOW, waitUntil: (p) => tasks.push(p) });
    expect((await handle(delivery(JSON.stringify(HIRE)))).status).toBe(200);
    await Promise.all(tasks);
    expect((seen.at(-1)?.body as { deliverableMarkdown: string }).deliverableMarkdown).toMatch(/^# MASK CHECK: WARN/);
  });
});
