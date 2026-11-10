import { BTC, USDC } from "../src/assets.ts";
import { VirtualClock } from "../src/clock.ts";
import { FakeAgentApi } from "../src/fake/api.ts";
import { MemoryIdempotencyStore } from "../src/safe/store.ts";
import { SafeMoney, type MoneyRequest } from "../src/safe/money.ts";
import { CustodyCounter } from "../src/safe/custody.ts";

export function setup(options: { custodyLimit?: number } = {}) {
  const clock = new VirtualClock();
  const fake = new FakeAgentApi({ clock, seed: 7, ...(options.custodyLimit ? { custodyLimit: options.custodyLimit } : {}) });
  const a = fake.createAgent("left");
  const b = fake.createAgent("right");
  clock.advance(10_000);
  fake.fund(a.id, USDC, "100000000");
  fake.fund(b.id, USDC, "100000000");
  const store = new MemoryIdempotencyStore();
  const custody = new CustodyCounter({ clock, ...(options.custodyLimit ? { limit: options.custodyLimit } : {}) });
  const money = new SafeMoney({ api: fake, store, clock, custody });
  return { clock, fake, a, b, store, custody, money };
}

export function swap(agentId: string, logicalId: string, amount = "1000000"): Extract<MoneyRequest, { kind: "swap" }> {
  return { kind: "swap", agentId, logicalId, body: { origin_asset: USDC, destination_asset: BTC, amount, confidential: false } };
}

export const moneyCalls = (fake: FakeAgentApi) => fake.calls.filter((c) => ["swap", "transfer", "withdraw", "deposit"].includes(c.method));
