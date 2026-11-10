import { describe, expect, it } from "vitest";
import type { MyAssignmentItem, MyAssignments } from "../src/api.ts";
import { MarketError } from "../src/client.ts";
import { pollOnce, runWorker } from "../src/worker.ts";
import { fakeMarket, fixture, result } from "./market.ts";

const a2a = fixture("docs/assignments-a2a").body as MyAssignments;
const first = a2a.assignments[0] as MyAssignmentItem;

function row(id: string, description: string): MyAssignmentItem {
  return { ...first, assignment: { ...first.assignment, assignmentId: id }, job: { ...first.job, description } };
}

describe("pollOnce", () => {
  it("works every row in progress; one failure does not stop the rest", async () => {
    const rows = [row("11111111-1111-4111-8111-111111111111", "nova.tinygif8324.testnet"), row("22222222-2222-4222-8222-222222222222", "onyx.tinygif8324.testnet"), row("33333333-3333-4333-8333-333333333333", "nothing here")];
    const { client } = fakeMarket({
      "GET /v1/agents/me/assignments": { status: 200, body: { assignments: rows } },
      "POST /v1/assignments/11111111-1111-4111-8111-111111111111/start": fixture("docs/start"),
      "POST /v1/assignments/11111111-1111-4111-8111-111111111111/submit": fixture("docs/submit-a2a"),
      "POST /v1/assignments/22222222-2222-4222-8222-222222222222/start": fixture("docs/start"),
      "POST /v1/assignments/22222222-2222-4222-8222-222222222222/submit": { status: 503, body: { error: "unavailable", message: "later" } },
      "POST /v1/assignments/33333333-3333-4333-8333-333333333333/start": fixture("docs/start"),
      "POST /v1/assignments/33333333-3333-4333-8333-333333333333/decline": fixture("docs/submit-a2a"),
    });
    const lines: string[] = [];
    const report = await pollOnce({ client, check: async (a) => result(a, "allow"), log: (l) => lines.push(l) });
    expect(report).toEqual({ submitted: 1, declined: 1, skipped: 0, failed: 1 });
    expect(lines.some((l) => l.startsWith("failed  22222222-2222-4222-8222-222222222222"))).toBe(true);
  });
});

describe("pollOnce and the webhook", () => {
  it("leaves a row the webhook started a moment ago, and takes it over after the grace", async () => {
    const started: MyAssignmentItem = { ...first, assignment: { ...first.assignment, startedAt: "2026-11-07T23:10:01Z" } };
    const id = started.assignment.assignmentId;
    const routes = {
      "GET /v1/agents/me/assignments": { status: 200, body: { assignments: [started] } },
      [`POST /v1/assignments/${id}/start`]: fixture("docs/start"),
      [`POST /v1/assignments/${id}/submit`]: fixture("docs/submit-a2a"),
    };
    const soon = fakeMarket(routes);
    const at = (iso: string) => () => Date.parse(iso);
    expect(await pollOnce({ client: soon.client, check: async (a) => result(a, "allow"), now: at("2026-11-07T23:10:30Z") })).toEqual({ submitted: 0, declined: 0, skipped: 1, failed: 0 });
    expect(soon.seen).toHaveLength(1);
    const late = fakeMarket(routes);
    expect(await pollOnce({ client: late.client, check: async (a) => result(a, "allow"), now: at("2026-11-07T23:11:02Z") })).toEqual({ submitted: 1, declined: 0, skipped: 0, failed: 0 });
  });
});

describe("runWorker", () => {
  it("polls until aborted", async () => {
    let polls = 0;
    const controller = new AbortController();
    const { client } = fakeMarket({
      "GET /v1/agents/me/assignments": () => {
        if (++polls === 3) controller.abort();
        return { status: 200, body: { assignments: [] } };
      },
    });
    await runWorker({ client, check: async (a) => result(a, "allow"), intervalMs: 1, signal: controller.signal });
    expect(polls).toBe(3);
  });

  it("stops on a 401: a revoked token does not come back by waiting", async () => {
    const { client } = fakeMarket({ "GET /v1/agents/me/assignments": fixture("recorded/assignments-no-token") });
    await expect(runWorker({ client, check: async (a) => result(a, "allow"), intervalMs: 1 })).rejects.toBeInstanceOf(MarketError);
  });

  it("keeps going through a failed poll", async () => {
    let polls = 0;
    const controller = new AbortController();
    const lines: string[] = [];
    const { client } = fakeMarket({
      "GET /v1/agents/me/assignments": () => {
        if (++polls === 2) controller.abort();
        return polls === 1 ? { status: 502, body: { error: "bad_gateway", message: "upstream" } } : { status: 200, body: { assignments: [] } };
      },
    });
    await runWorker({ client, check: async (a) => result(a, "allow"), intervalMs: 1, signal: controller.signal, log: (l) => lines.push(l) });
    expect(polls).toBe(2);
    expect(lines[0]).toMatch(/^poll    failed: GET \/v1\/agents\/me\/assignments: 502/);
  });
});
