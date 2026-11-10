// A round the season treasury opened on schedule, on a made-up chain: the race reads as any other, its opening and the
// safe's NEAR come from the treasury's own transaction, and the home page knows the next race.
import type { ChainReader } from "@maskwars/check";
import { describe, expect, it } from "vitest";
import { Arena, type Indexer, type Tx } from "../src/index.ts";

const BOUNTY = "bounty.example.testnet";
const SEASON = "season.example.testnet";
const SAFE = `s0007.${SEASON}`;
const NOVA = "nova.tinygif8324.testnet";
const ONYX = "onyx.tinygif8324.testnet";
const ID = "s1-0007-3fa9c2";
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 9, 18, 4, 0);
const NEAR = 10n ** 24n;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const CODE = "7Hq3rXbK9mP2vW5yZ8cD1fG4hJ6kL9nQ2sT5uV8wX1yA";

/** The scheduler's `open_next`: the treasury funds the new safe and opens the round, all in this one transaction. */
const openNext: Tx = {
  hash: "OPENNEXT",
  signer: "scheduler.example.testnet",
  receiver: SEASON,
  at: T0,
  height: 100,
  calls: [{ method: "open_next", args: {}, deposit: 0n }],
  ok: true,
  receipts: [
    { id: "r1", from: SEASON, to: SAFE, at: T0, calls: [{ method: "new", args: { owner: SAFE }, deposit: 0n }], transfer: 2n * NEAR, logs: [], ok: true, value: undefined },
    { id: "r2", from: SEASON, to: BOUNTY, at: T0 + 2000, calls: [{ method: "open_safe", args: { id: ID }, deposit: (NEAR * 35n) / 100n }], transfer: 0n, logs: [], ok: true, value: undefined },
  ],
};

function arena(opts: { seasonUp?: boolean } = {}) {
  const txs: Record<string, Tx[]> = { [BOUNTY]: [], [SEASON]: [openNext], [SAFE]: [openNext] };
  const indexer = {
    accountTxs: async (a: string) => (txs[a] ?? []).map((t) => ({ hash: t.hash, height: t.height, at: t.at, call: t.receiver === a })),
    transactions: async (hashes: readonly string[]) => [openNext].filter((t) => hashes.includes(t.hash)),
  } as unknown as Indexer;
  const views: Record<string, Record<string, unknown>> = {
    [SEASON]: {
      season: { bounty: BOUNTY },
      latest: [{ id: ID, safe: SAFE, challenge: "live-safe" }],
      next: {
        at_ns: ns(Date.UTC(2026, 10, 10, 18)),
        n: 8,
        challenge: "pause-bypass",
        code_hash: CODE,
        prize: ((NEAR * 35n) / 100n).toString(),
        safe_fund: (2n * NEAR).toString(),
        min_loot: NEAR.toString(),
        masks: [NOVA, ONYX],
        hours: 2,
        commit_minutes: 45,
        funded: true,
      },
    },
    [BOUNTY]: {
      get: { owner: SEASON, amount: ((NEAR * 22n) / 100n).toString(), target: SAFE, deadline_ns: ns(T0 + 120 * MIN), status: { state: "open" } },
      get_safe: { safe: SAFE, masks: [NOVA, ONYX], min_loot: NEAR.toString(), opened_ns: ns(T0 + 2000) },
      get_round: { commit_until: ns(T0 + 45 * MIN), reveal_until: ns(T0 + 105 * MIN), deadline_ns: ns(T0 + 120 * MIN), seals: [] },
      judge: { version: "ab".repeat(32) },
    },
    [SAFE]: { available: (2n * NEAR).toString() },
  };
  const rpc = {
    view: async (c: string, method: string) => {
      if (c === SEASON && opts.seasonUp === false) throw new Error("UNKNOWN_ACCOUNT");
      return views[c]?.[method] ?? null;
    },
    account: async () => ({ codeHash: CODE, amount: "0", locked: "0", storageUsage: 0, blockHeight: 1, blockHash: "h" }),
  } as unknown as ChainReader;
  return new Arena({ rpc, indexer, contracts: [BOUNTY], seasons: [SEASON], now: () => T0 + 10 * MIN });
}

describe("a season's round", () => {
  it("is read from the treasury's own transaction: who opened it, with what, and what went into the safe", async () => {
    const view = await arena().view();
    const r = view.races.find((x) => x.id === ID)!;
    expect(r).toMatchObject({ season: SEASON, team: SEASON, kind: "safe", phase: "sealing", live: true, target: SAFE, targetCode: CODE });
    expect(r.locked).toBe(((NEAR * 35n) / 100n).toString());
    expect(r.safeFunded).toBe((2n * NEAR).toString());
    expect(r.txs.open).toBe("OPENNEXT");
    expect(r.events.map((e) => [e.kind, e.who?.account, e.amount])).toEqual([
      ["fund", SEASON, (2n * NEAR).toString()],
      ["open", SEASON, ((NEAR * 35n) / 100n).toString()],
    ]);
    expect(view.now?.id).toBe(ID);
  });

  it("tells the home page when the next race is, on what and for how much", async () => {
    const next = (await arena().view()).next!;
    expect(next).toMatchObject({
      season: SEASON,
      at: Date.UTC(2026, 10, 10, 18),
      n: 8,
      target: "pause-bypass",
      targetCode: CODE,
      inSafe: (2n * NEAR).toString(),
      locked: ((NEAR * 35n) / 100n).toString(),
      prize: ((NEAR * 235n) / 100n).toString(),
      minLoot: NEAR.toString(),
      sealMinutes: 45,
      hours: 2,
      funded: true,
    });
    expect(next.masks.map((m) => m.name)).toEqual(["NOVA", "ONYX"]);
  });

  it("is skipped while the treasury is not on chain, and the arena reads on", async () => {
    const view = await arena({ seasonUp: false }).view();
    expect(view.next).toBeNull();
    expect(view.races).toEqual([]);
  });
});
