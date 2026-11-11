import { describe, expect, it } from "vitest";
import {
  factoryHistoryEvents,
  historyEvents,
  openNote,
  raceKey,
  readHistory,
  sealNote,
  sharePayload,
  unwrap,
  viewKeyFromSeed,
  viewKeyFromSignature,
  wrapFor,
  type HistoryEvent,
  type RaceNote,
} from "../src/history.ts";

const ECHO = "echo.masks.mwc59801.testnet";
const seed = (n: number) => new Uint8Array(32).fill(n);

function note(race: string, at: number): RaceNote {
  return {
    v: 1, mask: ECHO, race, at, copyOf: "lyra",
    attempts: [{ n: 1, plan: ["set_owner", "sweep"], verdict: "breach" }],
    mind: { where: "OutLayer TEE", model: "Qwen/Qwen3.8-27B", strategy: true },
    sealed: { seq: 0, plan: ["set_owner", "sweep"] }, result: "won",
    prize: "1000000000000000000000000", loot: "100000000000000000000000", spent: "1000000000000000000000", authorShare: "200000000000000000000000",
    txs: [{ what: "claim", hash: "H" }],
  };
}

describe("view keys and race notes", () => {
  it("makes the same view key from the same wallet signature, another from another account", async () => {
    const sig = new Uint8Array(64).fill(9);
    const a = await viewKeyFromSignature(sig, "bob.testnet");
    const b = await viewKeyFromSignature(sig, "bob.testnet");
    const c = await viewKeyFromSignature(sig, "cat.testnet");
    expect(a.public).toMatch(/^x25519:[0-9a-f]{64}$/);
    expect(a.public).toBe(b.public);
    expect(a.public).not.toBe(c.public);
  });

  it("opens a note only with its race key, and only as the note of that mask and race", async () => {
    const k = await raceKey(seed(1), ECHO, "copy-0001");
    expect(await raceKey(seed(1), ECHO, "copy-0002")).not.toEqual(k);
    expect(await raceKey(seed(1), "lyra.masks.mwc59801.testnet", "copy-0001")).not.toEqual(k);
    const sealed = await sealNote(k, note("copy-0001", 1));
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("set_owner");
    expect((await openNote(k, ECHO, "copy-0001", sealed)).result).toBe("won");
    await expect(openNote(await raceKey(seed(2), ECHO, "copy-0001"), ECHO, "copy-0001", sealed)).rejects.toThrow();
    await expect(openNote(k, ECHO, "copy-0002", sealed)).rejects.toThrow();
  });

  it("pads every note to a step of 256 bytes", async () => {
    const k = await raceKey(seed(1), ECHO, "r");
    const short = await sealNote(k, note("r", 1));
    const longer = await sealNote(k, { ...note("r", 1), txs: [{ what: "x".repeat(40), hash: "y" }] });
    expect(short.length).toBe(longer.length);
  });

  it("wraps a race key for one reader: another reader, or the same key for another mask, opens nothing", async () => {
    const bob = await viewKeyFromSeed(seed(3));
    const eve = await viewKeyFromSeed(seed(4));
    const k = await raceKey(seed(1), ECHO, "copy-0001");
    const w = await wrapFor(bob.public, ECHO, "bob.testnet", k);
    expect(await unwrap(bob, ECHO, "bob.testnet", w)).toEqual(k);
    await expect(unwrap(eve, ECHO, "bob.testnet", w)).rejects.toThrow();
    await expect(unwrap(bob, ECHO, "eve.testnet", w)).rejects.toThrow();
    await expect(unwrap(bob, "lyra.masks.mwc59801.testnet", "bob.testnet", w)).rejects.toThrow();
  });

  it("reads the history a reader was given, by a note's own key or a share, and nothing of a race after a revoke", async () => {
    const hist = seed(1);
    const cat = await viewKeyFromSeed(seed(5));
    const k1 = await raceKey(hist, ECHO, "copy-0001");
    const k2 = await raceKey(hist, ECHO, "copy-0002");
    const k3 = await raceKey(hist, ECHO, "copy-0003");
    const events: HistoryEvent[] = [
      // Race 1, before CAT was granted: no key for CAT in it.
      { kind: "note", mask: ECHO, race: "copy-0001", note: await sealNote(k1, note("copy-0001", 1)), keys: [], at: 1, tx: "t1" },
      // CAT granted: the keeper shares race 1.
      { kind: "share", mask: ECHO, to: "cat.testnet", keys: await wrapFor(cat.public, ECHO, "cat.testnet", sharePayload(new Map([["copy-0001", k1]]))), at: 2, tx: "t2" },
      // Race 2: CAT's key is in the note.
      { kind: "note", mask: ECHO, race: "copy-0002", note: await sealNote(k2, note("copy-0002", 3)), keys: [{ to: "cat.testnet", key: await wrapFor(cat.public, ECHO, "cat.testnet", k2) }], at: 3, tx: "t3" },
      // CAT revoked: race 3 has no key for CAT.
      { kind: "note", mask: ECHO, race: "copy-0003", note: await sealNote(k3, note("copy-0003", 4)), keys: [], at: 4, tx: "t4" },
    ];
    const read = await readHistory(cat, "cat.testnet", events);
    expect(read.map((n) => n.race)).toEqual(["copy-0002", "copy-0001"]);
    const eve = await viewKeyFromSeed(seed(6));
    expect(await readHistory(eve, "eve.testnet", events)).toEqual([]);
    expect(await readHistory(eve, "cat.testnet", events)).toEqual([]);
  });

  it("takes the keeper's latest note of a race: a correction replaces the note before it", async () => {
    const hist = seed(1);
    const bob = await viewKeyFromSeed(seed(3));
    const k = await raceKey(hist, ECHO, "copy-0001");
    const wrap = { to: "bob.testnet", key: await wrapFor(bob.public, ECHO, "bob.testnet", k) };
    const first = { ...note("copy-0001", 1), result: "held" as const };
    const fixed = { ...note("copy-0001", 2), result: "won" as const };
    const events: HistoryEvent[] = [
      { kind: "note", mask: ECHO, race: "copy-0001", note: await sealNote(k, first), keys: [wrap], at: 10, tx: "a" },
      { kind: "note", mask: ECHO, race: "copy-0001", note: await sealNote(k, fixed), keys: [wrap], at: 20, tx: "b" },
    ];
    const read = await readHistory(bob, "bob.testnet", events);
    expect(read).toHaveLength(1);
    expect(read[0]!.result).toBe("won");
  });

  it("reads note and share events of one mask from a transaction's logs", () => {
    const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: "maskwars_masks", version: "1.0.0", event, data })}`;
    const logs = [
      "a plain log",
      ev("note", { name: "echo", account: ECHO, race: "copy-0001", note: "v1.AAAA", keys: [{ to: "bob.testnet", key: "v1.BBBB" }] }),
      ev("note", { name: "lyra", account: "lyra.masks.mwc59801.testnet", race: "copy-0001", note: "v1.CCCC", keys: [] }),
      ev("share", { name: "echo", account: ECHO, to: "cat.testnet", keys: "v1.DDDD" }),
      ev("forge", { name: "echo" }),
    ];
    const got = historyEvents(logs, ECHO, 5, "tx1");
    expect(got.map((e) => e.kind)).toEqual(["note", "share"]);
    expect(got[0]).toMatchObject({ race: "copy-0001", keys: [{ to: "bob.testnet", key: "v1.BBBB" }], at: 5, tx: "tx1" });
  });

  describe("only the factory's own receipts, called by its keeper, count", () => {
    const FACTORY = "masks.mwc59801.testnet";
    const KEEPER = "mwc59801.testnet";
    const ev = (event: string, data: object) => `EVENT_JSON:${JSON.stringify({ standard: "maskwars_masks", version: "1.0.0", event, data })}`;
    const genuine = ev("note", { name: "echo", account: ECHO, race: "copy-0001", note: "v1.AAAA", keys: [{ to: "bob.testnet", key: "v1.BBBB" }] });
    const fake = (race: string) => ev("note", { name: "echo", account: ECHO, race, note: "v1.EEEE", keys: [{ to: "eve.testnet", key: "v1.FFFF" }] });

    it("keeps a genuine note: the factory ran the receipt, the keeper called it", () => {
      const got = factoryHistoryEvents([{ from: KEEPER, to: FACTORY, ok: true, logs: [genuine] }], FACTORY, KEEPER, ECHO, 5, "tx1");
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ kind: "note", race: "copy-0001", keys: [{ to: "bob.testnet", key: "v1.BBBB" }], tx: "tx1" });
    });

    it("ignores a forged note or share logged by another receipt of the same transaction", () => {
      const receipts = [
        // The attacker's contract logs a note and a share that look like the factory's, in a transaction that also
        // calls the factory: a race that never was, and a later "correction" meant to hide the genuine one.
        { from: "eve.testnet", to: "eve-logger.testnet", ok: true, logs: [fake("copy-9999"), fake("copy-0001")] },
        { from: "eve-logger.testnet", to: "eve-logger.testnet", ok: true, logs: [ev("share", { name: "echo", account: ECHO, to: "eve.testnet", keys: "v1.GGGG" })] },
        { from: KEEPER, to: FACTORY, ok: true, logs: [genuine] },
      ];
      const got = factoryHistoryEvents(receipts, FACTORY, KEEPER, ECHO, 5, "tx1");
      expect(got.map((e) => (e.kind === "note" ? e.race : e.kind))).toEqual(["copy-0001"]);
      expect(got[0]).toMatchObject({ note: "v1.AAAA" });
    });

    it("ignores the factory's receipt when someone other than its keeper called it, or when it failed", () => {
      expect(factoryHistoryEvents([{ from: "eve.testnet", to: FACTORY, ok: true, logs: [genuine] }], FACTORY, KEEPER, ECHO, 5, "t")).toEqual([]);
      expect(factoryHistoryEvents([{ from: KEEPER, to: FACTORY, ok: false, logs: [genuine] }], FACTORY, KEEPER, ECHO, 5, "t")).toEqual([]);
    });

    it("a forged later note does not replace the genuine one when the history is read", async () => {
      const bob = await viewKeyFromSeed(seed(3));
      const k = await raceKey(seed(1), ECHO, "copy-0001");
      const wrap = await wrapFor(bob.public, ECHO, "bob.testnet", k);
      const real = ev("note", { name: "echo", account: ECHO, race: "copy-0001", note: await sealNote(k, note("copy-0001", 1)), keys: [{ to: "bob.testnet", key: wrap }] });
      const forged = ev("note", { name: "echo", account: ECHO, race: "copy-0001", note: "v1.AAAA", keys: [{ to: "bob.testnet", key: wrap }] });
      const events = [
        ...factoryHistoryEvents([{ from: KEEPER, to: FACTORY, ok: true, logs: [real] }], FACTORY, KEEPER, ECHO, 10, "a"),
        ...factoryHistoryEvents([{ from: "eve.testnet", to: "eve-logger.testnet", ok: true, logs: [forged] }], FACTORY, KEEPER, ECHO, 20, "b"),
      ];
      const read = await readHistory(bob, "bob.testnet", events);
      expect(read.map((n) => n.race)).toEqual(["copy-0001"]);
    });
  });
});
