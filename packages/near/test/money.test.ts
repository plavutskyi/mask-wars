import { describe, expect, it } from "vitest";
import { BTC, USDC } from "../src/assets.ts";
import type { AgentApiPort } from "../src/api.ts";
import { AgentApiTransportError } from "../src/errors.ts";
import { LogicalIdConflictError, SafeMoney } from "../src/safe/money.ts";
import { MemoryIdempotencyStore, type IdempotencyStore, type MoneyRecord } from "../src/safe/store.ts";
import { moneyCalls, setup, swap } from "./helpers.ts";

describe("statuses", () => {
  it("SUCCESS: amount_out, tx_hash, one key", async () => {
    const { fake, a, money } = setup();
    const out = await money.execute(swap(a.id, "s1"));
    expect(out.state).toBe("SUCCESS");
    expect(out.status?.details.amount_out).toMatch(/^\d+$/);
    expect(out.status?.details.tx_hash).toMatch(/^FAKE-/);
    expect(out.record.attempts).toHaveLength(1);
    expect(moneyCalls(fake)).toHaveLength(1);
    const bal = await fake.getBalances(a.id, { asset: BTC });
    expect(bal.balances[0]?.balance_raw).toBe(out.status?.details.amount_out);
  });

  it("REFUNDED: input comes back, no automatic new work", async () => {
    const { fake, a, money } = setup();
    fake.next("refunded");
    const out = await money.execute(swap(a.id, "r1"));
    expect(out.state).toBe("REFUNDED");
    expect(out.status?.details.refund_tx_hash).toMatch(/^FAKE-/);
    expect((await fake.getBalances(a.id, { asset: USDC })).balances[0]?.balance_raw).toBe("100000000");
    const again = await money.execute(swap(a.id, "r1"));
    expect(again.state).toBe("REFUNDED");
    expect(moneyCalls(fake)).toHaveLength(1);
  });

  it("REFUNDED then reopen: explicit new key", async () => {
    const { fake, a, money } = setup();
    fake.next("refunded");
    await money.execute(swap(a.id, "r2"));
    await money.reopen("r2");
    const out = await money.execute(swap(a.id, "r2"));
    expect(out.state).toBe("SUCCESS");
    const keys = moneyCalls(fake).map((c) => c.key);
    expect(new Set(keys).size).toBe(2);
    expect(out.record.attempt).toBe(2);
  });

  it("FAILED: terminal with failure_code", async () => {
    const { fake, a, money } = setup();
    fake.next("failed");
    const out = await money.execute(swap(a.id, "f1"));
    expect(out.state).toBe("FAILED");
    expect(out.status?.failure_code).toBe("route_failed");
    await expect(money.reopen("missing")).rejects.toThrow();
  });

  it("UNCERTAIN: only polling the same id, never a new key", async () => {
    const { fake, a, money } = setup();
    fake.next("uncertain");
    const first = await money.execute(swap(a.id, "u1"), { deadlineMs: 20_000 });
    expect(first.state).toBe("UNCERTAIN");
    expect(first.record.state).toBe("sent");
    await expect(money.reopen("u1")).rejects.toThrow(/only REFUNDED or FAILED/);
    const second = await money.execute(swap(a.id, "u1"));
    expect(second.state).toBe("SUCCESS");
    expect(second.status?.correlation_id).toBe(first.status?.correlation_id);
    expect(moneyCalls(fake)).toHaveLength(1);
  });

  it("NEEDS_REVIEW: stops, no retry, no new work", async () => {
    const { fake, a, money } = setup();
    fake.next("needs_review");
    const out = await money.execute(swap(a.id, "n1"));
    expect(out.state).toBe("NEEDS_REVIEW");
    expect(out.status?.details.reason).toBe("amount_out_below_minimum");
    const again = await money.execute(swap(a.id, "n1"));
    expect(again.state).toBe("NEEDS_REVIEW");
    expect(moneyCalls(fake)).toHaveLength(1);
    await expect(money.reopen("n1")).rejects.toThrow();
  });

  it("slow: settles later but still SUCCESS within deadline", async () => {
    const { fake, a, money, clock } = setup();
    fake.next("slow");
    const t0 = clock.now();
    const out = await money.execute(swap(a.id, "slow1"));
    expect(out.state).toBe("SUCCESS");
    expect(clock.now() - t0).toBeGreaterThan(40_000);
  });

  it("deadline in PROCESSING returns PENDING and resumes the same op", async () => {
    const { fake, a, money } = setup();
    fake.next("slow");
    const first = await money.execute(swap(a.id, "p1"), { deadlineMs: 5_000 });
    expect(first.state).toBe("PENDING");
    const second = await money.execute(swap(a.id, "p1"));
    expect(second.state).toBe("SUCCESS");
    expect(moneyCalls(fake)).toHaveLength(1);
  });
});

describe("errors", () => {
  it("wallet_busy: refusal recorded, then a new key, then success", async () => {
    const { fake, a, money } = setup();
    fake.next("busy");
    const out = await money.execute(swap(a.id, "b1"));
    expect(out.state).toBe("SUCCESS");
    expect(out.record.attempts).toHaveLength(2);
    expect(out.record.attempts[0]?.outcome).toBe("refused:wallet_busy");
    const keys = moneyCalls(fake).map((c) => c.key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("wallet_busy beyond retries: REFUSED, next execute takes a new key", async () => {
    const { fake, a, clock, store } = setup();
    const money = new SafeMoney({ api: fake, store, clock, maxBusyRetries: 1 });
    fake.next("busy", "busy");
    const out = await money.execute(swap(a.id, "b2"));
    expect(out).toMatchObject({ state: "REFUSED", code: "wallet_busy" });
    const next = await money.execute(swap(a.id, "b2"));
    expect(next.state).toBe("SUCCESS");
    expect(new Set(moneyCalls(fake).map((c) => c.key)).size).toBe(3);
  });

  it("provider_limit_reached: REFUSED, wallet blocked locally until available_at", async () => {
    const { fake, a, money, custody } = setup();
    fake.next("quota");
    const out = await money.execute(swap(a.id, "q1"));
    expect(out).toMatchObject({ state: "REFUSED", code: "provider_limit_reached" });
    expect(await custody.remaining(a.id)).toBe(0);
    const again = await money.execute(swap(a.id, "q1"));
    expect(again).toMatchObject({ state: "REFUSED", code: "custody_exhausted" });
    expect(moneyCalls(fake)).toHaveLength(1);
  });

  for (const code of ["policy_denied", "policy_limit_exceeded", "policy_destination_denied", "spend_budget_exceeded", "spend_price_unavailable"]) {
    it(`${code}: REFUSED without retry; next attempt only with a new key`, async () => {
      const { fake, a, money } = setup();
      fake.failNext(code);
      const out = await money.execute(swap(a.id, `e-${code}`));
      expect(out).toMatchObject({ state: "REFUSED", code });
      expect(out.record.state).toBe("refused");
      expect(moneyCalls(fake)).toHaveLength(1);
      const next = await money.execute(swap(a.id, `e-${code}`));
      expect(next.state).toBe("SUCCESS");
      const keys = moneyCalls(fake).map((c) => c.key);
      expect(keys[0]).not.toBe(keys[1]);
    });
  }

  it("sponsor_busy: retried with the SAME key, one operation", async () => {
    const { fake, a, money } = setup();
    fake.failNext("sponsor_busy");
    const out = await money.execute(swap(a.id, "sp1"));
    expect(out.state).toBe("SUCCESS");
    const keys = moneyCalls(fake).map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(out.record.attempts).toHaveLength(1);
  });

  for (const code of ["operation_not_pending", "intent_generation_recovery_required", "authorization_stale", "code_we_never_saw"]) {
    it(`${code}: outcome unknown, the next attempt keeps the key`, async () => {
      const { fake, a, money } = setup();
      fake.failNext(code);
      const out = await money.execute(swap(a.id, `h-${code}`));
      expect(out).toMatchObject({ state: "PENDING", code });
      expect(out.record.state).toBe("pending");
      const next = await money.execute(swap(a.id, `h-${code}`));
      expect(next.state).toBe("SUCCESS");
      const keys = moneyCalls(fake).map((c) => c.key);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });
  }

  it("transport error after the API accepted: same key replays the same op", async () => {
    const { fake, a, clock } = setup();
    let drop = true;
    const flaky: AgentApiPort = Object.assign(Object.create(fake) as AgentApiPort, {
      swap: async (...args: Parameters<AgentApiPort["swap"]>) => {
        const result = await fake.swap(...args);
        if (drop) {
          drop = false;
          throw new AgentApiTransportError(new Error("socket hang up"), args[2].idempotencyKey);
        }
        return result;
      },
      getStatus: fake.getStatus.bind(fake),
    });
    const money = new SafeMoney({ api: flaky, store: new MemoryIdempotencyStore(), clock });
    const out = await money.execute(swap(a.id, "t1"));
    expect(out.state).toBe("SUCCESS");
    const keys = moneyCalls(fake).map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const ops = new Set(fake.calls.filter((c) => c.method === "swap").map((c) => c.key));
    expect(ops.size).toBe(1);
  });
});

describe("idempotency store", () => {
  it("the key is in the store before the API sees the request", async () => {
    const { fake, a, clock } = setup();
    const inner = new MemoryIdempotencyStore();
    const seen: MoneyRecord[] = [];
    const store: IdempotencyStore = {
      get: (id) => inner.get(id),
      list: () => inner.list(),
      put: (r) => inner.put(r),
    };
    const api: AgentApiPort = Object.assign(Object.create(fake) as AgentApiPort, {
      swap: async (...args: Parameters<AgentApiPort["swap"]>) => {
        const stored = await inner.get("k1");
        if (stored) seen.push(stored);
        return fake.swap(...args);
      },
      getStatus: fake.getStatus.bind(fake),
    });
    const money = new SafeMoney({ api, store, clock });
    await money.execute(swap(a.id, "k1"));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ state: "pending", key: "mw:swap:k1:1" });
  });

  it("crash after write: a restart resends with the stored key", async () => {
    const { fake, a, clock, store } = setup();
    await store.put({
      logicalId: "c1",
      kind: "swap",
      agentId: a.id,
      body: swap(a.id, "c1").body,
      key: "mw:swap:c1:1",
      attempt: 1,
      state: "pending",
      attempts: [{ key: "mw:swap:c1:1", at: clock.now() }],
      updatedAt: clock.now(),
    });
    const money = new SafeMoney({ api: fake, store, clock });
    const out = await money.execute(swap(a.id, "c1"));
    expect(out.state).toBe("SUCCESS");
    expect(moneyCalls(fake).map((c) => c.key)).toEqual(["mw:swap:c1:1"]);
  });

  it("same logical id with a different body is refused", async () => {
    const { a, money } = setup();
    await money.execute(swap(a.id, "x1"));
    await expect(money.execute(swap(a.id, "x1", "2000000"))).rejects.toBeInstanceOf(LogicalIdConflictError);
  });
});

describe("wallet queue", () => {
  it("concurrent money calls on one wallet never hit wallet_busy", async () => {
    const { fake, a, money } = setup();
    const outs = await Promise.all([money.execute(swap(a.id, "w1")), money.execute(swap(a.id, "w2")), money.execute(swap(a.id, "w3"))]);
    expect(outs.map((o) => o.state)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    expect(outs.every((o) => o.record.attempts.length === 1)).toBe(true);
  });

  it("without the queue the fake answers wallet_busy", async () => {
    const { fake, a } = setup();
    const body = swap(a.id, "z").body;
    const results = await Promise.allSettled([fake.swap(a.id, body, { idempotencyKey: "raw-key-1" }), fake.swap(a.id, body, { idempotencyKey: "raw-key-2" })]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("wallet_busy");
  });

  it("transfer between two agents moves the money", async () => {
    const { fake, a, b, money } = setup();
    const out = await money.execute({ kind: "transfer", agentId: a.id, logicalId: "back:1", body: { asset: USDC, amount: "1000000", recipient: b.wallet!.near_account_id, confidential: false } });
    expect(out.state).toBe("SUCCESS");
    expect((await fake.getBalances(b.id, { asset: USDC })).balances[0]?.balance_raw).toBe("101000000");
  });
});
