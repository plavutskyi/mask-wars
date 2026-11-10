import { readFileSync } from "node:fs";
import { ChainReader } from "@maskwars/check";
import { describe, expect, it } from "vitest";
import { Arena, Indexer, RPCS, duration, near, pickNow, raceNo } from "../src/index.ts";
import { type Recording, replayFetch } from "../src/replay.ts";

// What testnet RPC and the indexer answered on 7.11.2026, recorded by `pnpm --filter @maskwars/arena record`.
const recording = JSON.parse(readFileSync(new URL("./fixtures/testnet.json", import.meta.url), "utf8")) as Recording;

const NEAR = 10n ** 24n;
const NOVA = "nova.tinygif8324.testnet";
const TEAM = "tinygif8324.testnet";

function recorded(opts: { now?: number; ttlMs?: number } = {}) {
  const base = replayFetch(recording);
  const calls: string[] = [];
  let down = false;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${String(input)} ${typeof init?.body === "string" ? init.body : ""}`);
    if (down) throw new TypeError("fetch failed");
    return base(input, init);
  }) as typeof globalThis.fetch;
  let now = opts.now ?? recording.recordedAt;
  const arena = new Arena({
    rpc: new ChainReader({ endpoints: RPCS, fetch }),
    indexer: new Indexer({ fetch }),
    // The recording is from before the season treasury: it holds no answer about one.
    seasons: [],
    now: () => now,
    ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
  });
  return {
    arena,
    calls,
    setDown: (v: boolean) => {
      down = v;
    },
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("the arena on testnet, from recorded answers", () => {
  it("lists every race on the bounty contract, newest first, with the state the contract holds", async () => {
    const view = await recorded().arena.view();
    expect(view.races.map((r) => [r.id, r.contract, r.kind, r.state, r.phase])).toEqual([
      ["race-0003", TEAM, "safe", "drained", "broken"],
      ["race-0002", TEAM, "sandbox", "paid", "broken"],
      ["race-0001", TEAM, "sandbox", "refunded", "held"],
    ]);
    expect(view.races.every((r) => !r.live)).toBe(true);
    expect(view.now?.id).toBe("race-0003");
  });

  it("reads race-0003 as it happened: NOVA took the safe, drained 1 NEAR in 8:13 and the contract paid it", async () => {
    const r = (await recorded().arena.race("race-0003"))!;
    expect(r.winner).toMatchObject({ account: NOVA, slug: "nova", name: "NOVA", mask: true });
    expect(r.masks.map((m) => m.name)).toEqual(["NOVA", "ONYX", "ORACLE"]);
    expect(r.target).toBe("safe-0001.tinygif8324.testnet");
    expect(r.targetCode).toBe("ACrGiPV5s7DPk5LvXv1N6dyQvqdXTu1m978FseoBw5ja");
    expect(r.safeFunded).toBe((3n * NEAR).toString());
    expect(r.minLoot).toBe(NEAR.toString());
    expect(r.loot).toBe(NEAR.toString());
    expect(r.payout).toEqual({ amount: "86640000000000000000000", at: expect.any(Number), tx: "BHuCzqtM3ZWnS4EBww9ig9txers8ebQnqerGCpqW4Me8" });
    expect(r.takes).toBe((NEAR + 86_640_000_000_000_000_000_000n).toString());
    expect(r.openedAt).toBe(1793989591043);
    expect(r.brokeAt).toBe(1793990084546);
    expect(r.breakMs).toBe(493_503);
    expect(duration(r.breakMs)).toBe("8:13");
    expect(r.txs).toEqual({
      open: "BQgyeK2614DmFpz3KjYnHE6Fgw7PmNRPfY7Cc9VkFgXY",
      drain: "8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg",
      payout: "BHuCzqtM3ZWnS4EBww9ig9txers8ebQnqerGCpqW4Me8",
    });
    expect(r.judge).toBe("f6cf7728627068f204ac8bea282dd6438412a00ee3708e06d74ca1631b12434d");
    expect(r.inSafe).toBeNull();
  });

  it("tells the course of race-0003 in order: the safe filled, the vault opened, NOVA's moves, the claims, the payout", async () => {
    const r = (await recorded().arena.race("race-0003"))!;
    expect(r.events.map((e) => [e.kind, e.who?.name, e.method ?? e.verdict ?? null, e.amount ? near(e.amount) : null])).toEqual([
      ["fund", TEAM, null, "3"],
      ["open", TEAM, null, "0.1"],
      ["move", "NOVA", "set_owner", null],
      ["drain", "NOVA", "sweep", "1"],
      ["claim", "NOVA", "no", null],
      ["claim", "NOVA", "paid", null],
      ["paid", "NOVA", null, "0.0866"],
    ]);
    expect(r.events.find((e) => e.kind === "move")?.tx).toBe("FXvHZ88tqZkot9mup6m1Q4aM4K9573iKLpEHjLA31EK5");
  });

  it("keeps a payout to the team's own account out of every mask's earnings", async () => {
    const view = await recorded().arena.view();
    const r2 = view.races.find((r) => r.id === "race-0002")!;
    expect(r2.winner).toMatchObject({ account: TEAM, mask: false, slug: null });
    expect(r2.runId).toBe("42198804982");
    expect(r2.takes).toBe((NEAR / 10n).toString());
    expect(r2.breakMs).toBeNull();
    expect(view.league.map((m) => m.who.account)).not.toContain(TEAM);
  });

  it("reads race-0001 as held: nobody was paid and the bounty went back to the team", async () => {
    const r = (await recorded().arena.race("race-0001"))!;
    expect(r.winner).toBeNull();
    expect(r.refund).toEqual({ amount: (NEAR / 10n).toString(), at: expect.any(Number), tx: "Dhu8RhKEDiwf9eAmkq7kTrcG7T78o2FC6DXMAmad8mtN" });
    expect(r.events.at(-1)?.kind).toBe("refund");
  });

  it("ranks the league by what each mask took, then breaks, then the fastest break", async () => {
    const { league } = await recorded().arena.view();
    expect(league.map((m) => [m.who.name, m.races, m.breaks, near(m.earned), m.fastestMs, m.fastestRace])).toEqual([
      ["NOVA", 1, 1, "1.086", 493_503, "race-0003"],
      ["ONYX", 1, 0, "0", null, null],
      ["ORACLE", 1, 0, "0", null, null],
    ]);
    expect(league[0]?.who.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
    expect(league[0]?.history[0]).toMatchObject({ id: "race-0003", won: true, targetCode: "ACrGiPV5s7DPk5LvXv1N6dyQvqdXTu1m978FseoBw5ja" });
  });

  it("finds a mask by its page name or its account", async () => {
    const { arena } = recorded();
    expect((await arena.mask("nova"))?.who.account).toBe(NOVA);
    expect((await arena.mask(NOVA))?.who.slug).toBe("nova");
    expect(await arena.mask("nobody")).toBeNull();
    expect(await arena.race("race-9999")).toBeNull();
  });

  it("reads finished races once and serves the last good reading when the chain stops answering", async () => {
    const t = recorded({ ttlMs: 1_000 });
    const first = await t.arena.view();
    const n = t.calls.length;
    expect(await t.arena.view()).toBe(first);
    expect(t.calls.length).toBe(n);

    t.tick(5_000);
    await t.arena.view();
    const again = t.calls.slice(n);
    expect(again.some((c) => c.includes('"method":"query"'))).toBe(false);

    t.tick(5_000);
    t.setDown(true);
    expect((await t.arena.view()).races).toHaveLength(3);
  });

  it("fails when the very first reading finds nothing", async () => {
    const t = recorded();
    t.setDown(true);
    await expect(t.arena.view()).rejects.toThrow();
  });
});

describe("numbers", () => {
  it("shows NEAR rounded down", () => {
    expect(near((NEAR * 108_664n) / 100_000n)).toBe("1.086");
    expect(near(86_640_000_000_000_000_000_000n)).toBe("0.0866");
    expect(near(NEAR / 10n)).toBe("0.1");
    expect(near(3n * NEAR)).toBe("3");
    expect(near(12_345n * NEAR + NEAR / 2n)).toBe("12,345");
    expect(near(15n * NEAR + (NEAR * 27n) / 100n)).toBe("15.2");
    expect(near(1_000_000_000_000_000_000_000n)).toBe("0.001");
    expect(near(1_000_000_000_000_000_000n)).toBe("0.000001");
    expect(near("0")).toBe("0");
    expect(near(null)).toBe("0");
  });

  it("shows a span the way a race clock does", () => {
    expect(duration(493_503)).toBe("8:13");
    expect(duration(64_000)).toBe("1:04");
    expect(duration(3_725_000)).toBe("1:02:05");
    expect(duration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 d 4 h");
    expect(duration(null)).toBe("–");
    expect(raceNo("race-0003")).toBe("0003");
    expect(raceNo("team-x")).toBe("team-x");
    expect(raceNo("human-0001")).toBe("H0001");
  });
});

describe("what the home page shows", () => {
  const base = { live: false, openedAt: 0 } as const;
  const race = (id: string, phase: "sealing" | "racing" | "broken" | "held", extra: Partial<{ live: boolean; openedAt: number }> = {}) =>
    ({ ...base, id, phase, ...extra }) as unknown as Parameters<typeof pickNow>[0][number];

  it("puts a LIVE race first, then one about to start, else the latest", () => {
    expect(pickNow([race("b", "broken", { openedAt: 3 }), race("a", "held", { openedAt: 1 })])?.id).toBe("b");
    expect(pickNow([race("b", "broken", { openedAt: 3 }), race("s", "sealing", { openedAt: 2 })])?.id).toBe("s");
    expect(pickNow([race("q", "racing", { openedAt: 4 }), race("l", "racing", { openedAt: 2, live: true })])?.id).toBe("l");
    expect(pickNow([])).toBeNull();
  });
});
