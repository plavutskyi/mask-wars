// The reader by the rules of a sealed round, on what testnet RPC and the indexer answered on 7.11.2026: race-0003 as
// recorded, with the contract's own answers about it (`get`, `get_round`, `get_safe`) set as a sealed round, another
// team or another team's mask would have them. Every transaction, every move on the safe and every payout stays as
// testnet recorded it.
import { readFileSync } from "node:fs";
import { ChainReader } from "@maskwars/check";
import { describe, expect, it } from "vitest";
import { Arena, Indexer, pickNow, RPCS } from "../src/index.ts";
import { type Exchange, type Recording, replayFetch } from "../src/replay.ts";

const recording = JSON.parse(readFileSync(new URL("./fixtures/testnet.json", import.meta.url), "utf8")) as Recording;
const CONTRACT = "tinygif8324.testnet";
const NOVA = "nova.tinygif8324.testnet";
const ONYX = "onyx.tinygif8324.testnet";
const ORACLE = "oracle.tinygif8324.testnet";
const MIN = 60_000;
/** NOVA's sweep of safe-0001 in race-0003 (tx 8pvCJFDw…), as recorded. */
const DRAIN_AT = 1793990084546;
const OPENED_AT = 1793989591043;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

/** The recording, with the answers of `account.method(args)` set to `value`. */
function answer(edits: { method: string; args: unknown; value: unknown }[]): Recording {
  const exchanges = recording.exchanges.map((e): Exchange => {
    const p = (e.request as { params?: Record<string, string> } | null)?.params;
    const edit = edits.find((x) => p?.request_type === "call_function" && p.account_id === CONTRACT && p.method_name === x.method && p.args_base64 === b64(x.args));
    if (!edit) return e;
    const r = (e.response as { result: Record<string, unknown> }).result;
    const { error: _error, ...rest } = r;
    return { ...e, response: { ...(e.response as object), result: { ...rest, logs: [], result: [...Buffer.from(JSON.stringify(edit.value))] } } };
  });
  return { ...recording, exchanges };
}

const race3 = { id: "race-0003" };
const bounty3 = (over: Record<string, unknown> = {}) => ({
  owner: CONTRACT,
  amount: "86640000000000000000000",
  target: "safe-0001.tinygif8324.testnet",
  deadline_ns: "1794248791043187964",
  status: { state: "open" },
  ...over,
});
/** race-0003 as a sealed round whose commit window closed a minute after NOVA's sweep. */
const SEAL_UNTIL = DRAIN_AT + MIN;
const REVEAL_UNTIL = SEAL_UNTIL + 60 * MIN;
const round3 = {
  commit_until: ns(SEAL_UNTIL),
  reveal_until: ns(REVEAL_UNTIL),
  deadline_ns: "1794248791043187964",
  seals: [{ mask: NOVA, seq: 0, at_ns: ns(OPENED_AT + MIN), state: "sealed" }],
  judging: [],
};

function arena(rec: Recording, now: number) {
  const fetch = replayFetch(rec);
  return new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer: new Indexer({ fetch }), seasons: [], now: () => now });
}

describe("a sealed round, by its rules", () => {
  it("names no winner for a drain in the sealing window while the contract has not paid", async () => {
    const rec = answer([
      { method: "get", args: race3, value: bounty3() },
      { method: "get_round", args: race3, value: round3 },
    ]);
    const r = (await arena(rec, SEAL_UNTIL + 10 * MIN).race("race-0003"))!;
    expect(r.sealUntil).toBe(SEAL_UNTIL);
    expect(r.phase).toBe("racing");
    expect([r.winner, r.brokeAt, r.breakMs, r.loot, r.takes]).toEqual([null, null, null, null, null]);
    // The sweep is on the course, marked: it does not count.
    const drain = r.events.find((e) => e.kind === "drain")!;
    expect(drain).toMatchObject({ who: { account: NOVA }, early: true, tx: "8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg" });
    expect(r.txs.drain).toBeNull();
  });

  it("stays LIVE through the reveal window by the round's rule, and gives the window's end", async () => {
    const rec = answer([
      { method: "get", args: race3, value: bounty3() },
      { method: "get_round", args: race3, value: round3 },
    ]);
    const during = (await arena(rec, REVEAL_UNTIL - MIN).race("race-0003"))!;
    expect(during.revealUntil).toBe(REVEAL_UNTIL);
    expect(during.live).toBe(true);
    // Read when testnet was recorded: the window is long over and nothing moved since.
    const after = (await arena(rec, recording.recordedAt).race("race-0003"))!;
    expect(after.live).toBe(false);
    expect(after.phase).toBe("racing");
  });

  it("keeps the contract's word once it paid, with no break time before the race started", async () => {
    const rec = answer([{ method: "get_round", args: race3, value: round3 }]);
    const r = (await arena(rec, recording.recordedAt).race("race-0003"))!;
    expect(r.state).toBe("drained");
    expect(r.winner?.account).toBe(NOVA);
    expect(r.phase).toBe("broken");
    expect(r.breakMs).toBeNull();
  });

  it("calls a mask of another team by its whole account, never by the arena's mask names", async () => {
    const rec = answer([
      {
        method: "get_safe",
        args: race3,
        value: { safe: "safe-0001.tinygif8324.testnet", masks: [NOVA, "nova.someone.testnet", ONYX, ORACLE], min_loot: "1000000000000000000000000", opened_ns: "1793989591043187964" },
      },
    ]);
    const r = (await arena(rec, recording.recordedAt).race("race-0003"))!;
    expect(r.masks.map((m) => [m.name, m.mask, m.slug])).toEqual([
      ["NOVA", true, "nova"],
      ["nova.someone.testnet", true, null],
      ["ONYX", true, "onyx"],
      ["ORACLE", true, "oracle"],
    ]);
  });

  it("calls a person's mask from the factory by its own name, with its page, and a look-alike by its whole account", async () => {
    const KIRA = "kira.masks.tinygif8324.testnet";
    const rec = answer([
      {
        method: "get_safe",
        args: race3,
        value: { safe: "safe-0001.tinygif8324.testnet", masks: [NOVA, KIRA, "kira.masks.someone.testnet", "a.kira.masks.tinygif8324.testnet"], min_loot: "1000000000000000000000000", opened_ns: "1793989591043187964" },
      },
    ]);
    const r = (await arena(rec, recording.recordedAt).race("race-0003"))!;
    expect(r.masks.map((m) => [m.name, m.slug])).toEqual([
      ["NOVA", "nova"],
      ["KIRA", "kira"],
      ["kira.masks.someone.testnet", null],
      ["a.kira.masks.tinygif8324.testnet", null],
    ]);
  });

  it("puts the arena's own races first on the home page, and another team's only with its mark", async () => {
    // Another team opened race-0003 on the arena's contract and it runs (its only drain came in the sealing window);
    // the arena's own races are over.
    const foreign = answer([
      { method: "get", args: race3, value: bounty3({ owner: "someone.testnet" }) },
      { method: "get_round", args: race3, value: round3 },
    ]);
    const view = await arena(foreign, recording.recordedAt).view();
    expect(view.races.map((r) => [r.id, r.official])).toEqual([
      ["race-0003", false],
      ["race-0002", true],
      ["race-0001", true],
    ]);
    expect(view.now).toMatchObject({ id: "race-0003", official: false, team: "someone.testnet" });
    // Once one of the arena's own races runs, it takes the home page.
    const ours = answer([
      { method: "get", args: race3, value: bounty3({ owner: "someone.testnet" }) },
      { method: "get_round", args: race3, value: round3 },
      {
        method: "get",
        args: { id: "race-0002" },
        value: { owner: CONTRACT, amount: "100000000000000000000000", target: "open-admin", deadline_ns: "1794218115244306751", status: { state: "open" } },
      },
    ]);
    const both = await arena(ours, recording.recordedAt).view();
    expect(both.now).toMatchObject({ id: "race-0002", official: true });
    expect(pickNow(both.races.filter((r) => r.id !== "race-0002"))?.id).toBe("race-0003");
    // With nothing running, the arena's latest race, not another team's.
    expect(pickNow(both.races.map((r) => ({ ...r, live: false, phase: "held" as const })))?.id).toBe("race-0002");
  });
});
