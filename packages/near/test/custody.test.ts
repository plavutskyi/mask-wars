import { describe, expect, it } from "vitest";
import { CustodyCounter, CustodyExhaustedError } from "../src/safe/custody.ts";
import { VirtualClock } from "../src/clock.ts";
import { setup, swap } from "./helpers.ts";

describe("custody counter", () => {
  it("rolling 24h window, 100 by default", async () => {
    const clock = new VirtualClock();
    const c = new CustodyCounter({ clock });
    for (let i = 0; i < 100; i++) {
      await c.record("w");
      clock.advance(60_000);
    }
    expect(await c.remaining("w")).toBe(0);
    await expect(c.assertAvailable("w")).rejects.toBeInstanceOf(CustodyExhaustedError);
    clock.advance(24 * 3_600_000 - 100 * 60_000 + 1);
    expect(await c.remaining("w")).toBe(1);
  });

  it("fight entry needs ops plus reserve", async () => {
    const clock = new VirtualClock();
    const c = new CustodyCounter({ clock, limit: 5 });
    expect(await c.canEnterFight("w")).toBe(true);
    await c.record("w");
    await c.record("w");
    expect(await c.canEnterFight("w")).toBe(false);
    await expect(c.assertFightEntry("w")).rejects.toBeInstanceOf(CustodyExhaustedError);
  });

  it("our counter stops before the provider quota", async () => {
    const { fake, a, money } = setup({ custodyLimit: 3 });
    for (let i = 0; i < 3; i++) expect((await money.execute(swap(a.id, `c${i}`))).state).toBe("SUCCESS");
    const out = await money.execute(swap(a.id, "c3"));
    expect(out).toMatchObject({ state: "REFUSED", code: "custody_exhausted" });
    expect(fake.calls.filter((c) => c.method === "swap")).toHaveLength(3);
  });

  it("the fake enforces its own quota with provider_limit_reached", async () => {
    const { fake, a } = setup({ custodyLimit: 1 });
    const body = swap(a.id, "q").body;
    await fake.swap(a.id, body, { idempotencyKey: "quota-key-1" });
    await expect(fake.swap(a.id, body, { idempotencyKey: "quota-key-2" })).rejects.toMatchObject({ code: "provider_limit_reached" });
  });
});
