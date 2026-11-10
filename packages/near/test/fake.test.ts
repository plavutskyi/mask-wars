import { describe, expect, it } from "vitest";
import { BTC, USDC } from "../src/assets.ts";
import { VirtualClock } from "../src/clock.ts";
import { FakeAgentApi } from "../src/fake/api.ts";
import { SCENARIOS, isScenario } from "../src/fake/scenarios.ts";
import { StatusPoller } from "../src/safe/poller.ts";
import type { AgentApiPort } from "../src/api.ts";

async function run(seed: number) {
  const clock = new VirtualClock();
  const fake = new FakeAgentApi({ clock, seed });
  const a = fake.createAgent("a");
  clock.advance(5_000);
  fake.fund(a.id, USDC, "10000000");
  const poller = new StatusPoller({ api: fake, clock });
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = clock.now();
    const s = await fake.swap(a.id, { origin_asset: USDC, destination_asset: BTC, amount: "1000000" }, { idempotencyKey: `det-key-${i}` });
    await poller.settle(s.correlation_id, { deadlineMs: 120_000 });
    times.push(clock.now() - t0);
  }
  return times;
}

describe("fake Agent API", () => {
  it("is deterministic for a seed", async () => {
    expect(await run(42)).toEqual(await run(42));
    expect(await run(42)).not.toEqual(await run(43));
  });

  it("knows all the scenarios", () => {
    for (const s of ["refunded", "uncertain", "needs_review", "busy", "quota", "slow"]) expect(isScenario(s)).toBe(true);
    expect(SCENARIOS).toContain("failed");
    expect(isScenario("nope")).toBe(false);
  });

  it("agent goes PENDING → ACTIVE after activation and refuses money before", async () => {
    const clock = new VirtualClock();
    const fake = new FakeAgentApi({ clock, activationMs: 3_000 });
    const a = fake.createAgent("new");
    expect((await fake.getAgent(a.id)).status).toBe("PENDING");
    await expect(fake.quoteSwap(a.id, { origin_asset: USDC, destination_asset: BTC, amount: "1" })).rejects.toMatchObject({ code: "agent_not_bound" });
    clock.advance(3_000);
    expect((await fake.getAgent(a.id)).status).toBe("ACTIVE");
  });

  it("deposit: PENDING_DEPOSIT → paid → SUCCESS credits the agent", async () => {
    const clock = new VirtualClock();
    const fake = new FakeAgentApi({ clock, activationMs: 0, autoPayDepositsMs: 5_000 });
    const a = fake.createAgent("d");
    const dep = await fake.deposit(a.id, { origin_asset: USDC, amount: "1000000" }, { idempotencyKey: "dep-key-1" });
    expect(dep.status).toBe("PENDING_DEPOSIT");
    expect(dep.details.deposit_address).toMatch(/^FAKE-/);
    const done = await new StatusPoller({ api: fake, clock }).settle(dep.correlation_id, { deadlineMs: 120_000 });
    expect(done.status).toBe("SUCCESS");
    expect((await fake.getBalances(a.id)).balances[0]?.balance_raw).toBe("1000000");
  });

  it("same key + same body replays; different body is idempotency_conflict", async () => {
    const clock = new VirtualClock();
    const fake = new FakeAgentApi({ clock, activationMs: 0 });
    const a = fake.createAgent("i");
    fake.fund(a.id, USDC, "5000000");
    const body = { origin_asset: USDC, destination_asset: BTC, amount: "1000000" };
    const first = await fake.swap(a.id, body, { idempotencyKey: "idem-key-1" });
    const again = await fake.swap(a.id, body, { idempotencyKey: "idem-key-1" });
    expect(again.correlation_id).toBe(first.correlation_id);
    await expect(fake.swap(a.id, { ...body, amount: "2" }, { idempotencyKey: "idem-key-1" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await fake.getBalances(a.id, { asset: USDC })).balances[0]?.balance_raw).toBe("4000000");
  });
});

describe("status poller", () => {
  it("keeps at most N long-polls in flight", async () => {
    const clock = new VirtualClock();
    let active = 0;
    let peak = 0;
    let calls = 0;
    const api = {
      getStatus: async (id: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 1));
        active--;
        calls++;
        return { correlation_id: id, status: "SUCCESS" } as never;
      },
    } as unknown as AgentApiPort;
    const poller = new StatusPoller({ api, clock, maxConcurrent: 3 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => poller.settle(`op_${i}`, { deadlineMs: 1000 })));
    expect(peak).toBe(3);
    expect(calls).toBe(12);
  });
});
