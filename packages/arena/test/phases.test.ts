// A sealed round from opening to the break, on a made-up chain: when the race is sealing, racing, LIVE or held.
import type { ChainReader } from "@maskwars/check";
import { describe, expect, it } from "vitest";
import { Arena, type Indexer, type Tx } from "../src/index.ts";

const C = "bounty.example.testnet";
const SAFE = "safe-0009.example.testnet";
const NOVA = "nova.tinygif8324.testnet";
const ONYX = "onyx.tinygif8324.testnet";
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const NEAR = 10n ** 24n;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

function tx(hash: string, signer: string, receiver: string, at: number, method: string, args: Record<string, unknown>, extra: Partial<Tx> = {}): Tx {
  return { hash, signer, receiver, at, height: at, calls: [{ method, args, deposit: 0n }], ok: true, receipts: [], ...extra };
}

interface World {
  now: number;
  status?: Record<string, unknown>;
  safeTxs?: Tx[];
  revealUntil?: number;
}

function arenaAt(w: World) {
  const open = tx("OPEN", "team.testnet", C, T0, "open_safe", { id: "race-0009" });
  const txs: Record<string, Tx[]> = { [C]: [open], [SAFE]: w.safeTxs ?? [] };
  const indexer = {
    accountTxs: async (a: string) => (txs[a] ?? []).map((t) => ({ hash: t.hash, height: t.height, at: t.at, call: true })),
    transactions: async (hashes: readonly string[]) => Object.values(txs).flat().filter((t) => hashes.includes(t.hash)),
  } as unknown as Indexer;
  const views: Record<string, unknown> = {
    get: { owner: "team.testnet", amount: (NEAR / 5n).toString(), target: SAFE, deadline_ns: ns(T0 + 24 * 60 * MIN), status: w.status ?? { state: "open" } },
    get_safe: { safe: SAFE, masks: [NOVA, ONYX], min_loot: NEAR.toString(), opened_ns: ns(T0) },
    get_round: {
      commit_until: ns(T0 + 30 * MIN),
      ...(w.revealUntil ? { reveal_until: ns(w.revealUntil) } : {}),
      deadline_ns: ns(T0 + 24 * 60 * MIN),
      seals: [{ mask: NOVA, seq: 0, at_ns: ns(T0 + 4 * MIN), state: "sealed" }],
    },
    judge: { version: "ab".repeat(32) },
    available: (3n * NEAR).toString(),
  };
  const rpc = {
    view: async (_c: string, method: string) => views[method] ?? null,
    account: async () => ({ codeHash: "SafeCode1111111111111111111111111111111111", amount: "0", locked: "0", storageUsage: 0, blockHeight: 1, blockHash: "h" }),
  } as unknown as ChainReader;
  return new Arena({ rpc, indexer, contracts: [C], now: () => w.now });
}

describe("a sealed round's clock", () => {
  it("is LIVE while the masks seal their plans, and the race starts when the window closes", async () => {
    const r = (await arenaAt({ now: T0 + 10 * MIN }).race("race-0009"))!;
    expect(r.phase).toBe("sealing");
    expect(r.live).toBe(true);
    expect(r.startsAt).toBe(T0 + 30 * MIN);
    expect(r.inSafe).toBe((3n * NEAR).toString());
    expect(r.prize).toBe((3n * NEAR + NEAR / 5n).toString());
    expect(r.events.map((e) => [e.kind, e.who?.name, e.seq ?? null])).toEqual([
      ["open", "team.testnet", null],
      ["seal", "NOVA", 0],
    ]);
  });

  it("is LIVE through the reveal window, then quiet: no LIVE mark when nothing happens", async () => {
    expect((await arenaAt({ now: T0 + 45 * MIN, revealUntil: T0 + 90 * MIN }).race("race-0009"))?.live).toBe(true);
    const quiet = (await arenaAt({ now: T0 + 45 * MIN }).race("race-0009"))!;
    expect(quiet.phase).toBe("racing");
    expect(quiet.live).toBe(false);
  });

  it("is LIVE again the moment a mask moves on the safe", async () => {
    const move = tx("MOVE", ONYX, SAFE, T0 + 41 * MIN, "set_owner", { new_owner: ONYX });
    const r = (await arenaAt({ now: T0 + 45 * MIN, safeTxs: [move] }).race("race-0009"))!;
    expect(r.live).toBe(true);
    expect(r.events.at(-1)).toMatchObject({ kind: "move", method: "set_owner", ok: true });
  });

  it("calls the race broken as soon as a mask drains the safe, before the judge answers", async () => {
    const sweep = tx("SWEEP", NOVA, SAFE, T0 + 40 * MIN, "sweep", { to: NOVA, amount: NEAR.toString() }, {
      receipts: [{ id: "r", from: SAFE, to: NOVA, at: T0 + 40 * MIN + 1_000, calls: [], transfer: NEAR, logs: [], ok: true, value: undefined }],
    });
    const r = (await arenaAt({ now: T0 + 44 * MIN, safeTxs: [sweep] }).race("race-0009"))!;
    expect(r.phase).toBe("broken");
    expect(r.winner?.name).toBe("NOVA");
    expect(r.loot).toBe(NEAR.toString());
    expect(r.breakMs).toBe(10 * MIN);
    expect(r.payout).toBeNull();
    expect(r.live).toBe(true);
  });

  it("is held once the deadline passes with nobody through", async () => {
    const r = (await arenaAt({ now: T0 + 25 * 60 * MIN }).race("race-0009"))!;
    expect(r.phase).toBe("held");
    expect(r.live).toBe(false);
  });
});
