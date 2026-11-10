import { describe, expect, it } from "vitest";
import { base58Encode, NearKey, type Chain } from "../src/near-tx.ts";
import { collectFinished, openNext, roundSummary, type NextRound, type SeasonRound } from "../src/season.ts";

const SEASON = "season.tinygif8324.testnet";
const SCHEDULER = "scheduler.tinygif8324.testnet";
const KEY = new NearKey(`ed25519:${base58Encode(Buffer.alloc(32, 3))}`);
const MINUTE = 60_000_000_000n;
const SLOT = BigInt(Date.UTC(2026, 10, 9, 18)) * 1_000_000n; // 9 November 2026, 18:00 UTC

const next: NextRound = {
  at_ns: SLOT.toString(),
  n: 7,
  challenge: "live-safe",
  code_hash: "7Hq3rXbK9mP2vW5yZ8cD1fG4hJ6kL9nQ2sT5uV8wX1yA",
  prize: "350000000000000000000000",
  safe_fund: "2000000000000000000000000",
  min_loot: "1000000000000000000000000",
  masks: ["nova.tinygif8324.testnet", "onyx.tinygif8324.testnet", "oracle.tinygif8324.testnet"],
  hours: 2,
  commit_minutes: 45,
  reveal_minutes: 60,
  funded: true,
  treasury: "9000000000000000000000000",
};

const round: SeasonRound = {
  id: "s1-0007-3fa9c2",
  n: 7,
  safe: `s0007.${SEASON}`,
  challenge: "live-safe",
  code_hash: next.code_hash,
  prize: next.prize,
  safe_fund: next.safe_fund,
  min_loot: next.min_loot,
  masks: next.masks,
  slot_ns: SLOT.toString(),
  opened_ns: (SLOT + 4n * MINUTE).toString(),
  commit_until_ns: (SLOT + 49n * MINUTE).toString(),
  deadline_ns: (SLOT + 124n * MINUTE).toString(),
};

/** `round` a day earlier: yesterday's slot. */
const yesterday: SeasonRound = {
  ...round,
  id: "s1-0006-00aa11",
  slot_ns: (SLOT - 1440n * MINUTE).toString(),
  opened_ns: (SLOT - 1436n * MINUTE).toString(),
  commit_until_ns: (SLOT - 1391n * MINUTE).toString(),
  deadline_ns: (SLOT - 1316n * MINUTE).toString(),
};

/** testnet as the scheduler sees it: the treasury's `next`, a clock, and what `open_next` returns. */
class FakeTestnet implements Chain {
  now = SLOT + 4n * MINUTE;
  next: NextRound | null = next;
  value: unknown = round;
  logs: string[] = ["round s1-0007-3fa9c2 opens on s0007.season.tinygif8324.testnet with 350000000000000000000000 yoctoNEAR"];
  failure: unknown = null;
  collectable = 0;
  /** The treasury's rounds, newest first (`latest`). */
  latest: SeasonRound[] = [];
  /** `send_tx` never answers: the RPC dropped it, though the call may have landed. */
  lost = false;
  /** What landing `open_next` adds to `latest`, when it lands without an answer. */
  lands: SeasonRound | null = null;
  /** Every receipt of collect but the call itself failed: `settle` or `refund`, which one does not apply. */
  collectReceiptFails = false;
  readonly sent: { receiver: string; method: string }[] = [];

  async rpc(method: string, p: Record<string, string>): Promise<unknown> {
    if (method === "block") return { header: { timestamp_nanosec: this.now.toString() } };
    if (method === "query" && p.request_type === "view_access_key") return { nonce: 1, block_hash: base58Encode(Buffer.alloc(32, 9)) };
    if (method === "query" && p.method_name === "next") return { result: [...Buffer.from(JSON.stringify(this.next))] };
    if (method === "query" && p.method_name === "collectable") return { result: [...Buffer.from(JSON.stringify(this.collectable))] };
    if (method === "query" && p.method_name === "season") {
      return { result: [...Buffer.from(JSON.stringify({ program: { first_minute: 1080, every_minutes: 1440 } }))] };
    }
    if (method === "query" && p.method_name === "latest") return { result: [...Buffer.from(JSON.stringify(this.latest.slice(0, 1)))] };
    if (method === "send_tx") {
      const sent = Buffer.from(p.signed_tx_base64!, "base64").toString("latin1");
      const called = sent.includes("collect") ? "collect" : "open_next";
      this.sent.push({ receiver: SEASON, method: called });
      if (this.lost) {
        if (this.lands) this.latest = [this.lands, ...this.latest];
        throw new Error("fetch failed: the RPC timed out");
      }
      if (called === "collect") {
        const failed = { outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "the masks can still claim" } } } } } } };
        const receipts = this.collectReceiptFails ? [failed] : [];
        return { status: { SuccessValue: Buffer.from(String(this.collectable)).toString("base64") }, receipts_outcome: receipts };
      }
      const status = this.failure ? { Failure: this.failure } : { SuccessValue: Buffer.from(JSON.stringify(this.value)).toString("base64") };
      return { status, receipts_outcome: [{ outcome: { status: { SuccessValue: "" }, logs: this.logs } }] };
    }
    throw new Error(`unexpected ${method}`);
  }
}

const open = (chain: FakeTestnet) =>
  openNext({
    chain,
    season: SEASON,
    scheduler: SCHEDULER,
    key: KEY,
    settleMs: 0,
    // Waiting moves the clock.
    sleep: async (ms) => {
      chain.now += BigInt(ms) * 1_000_000n;
    },
  });

describe("the scheduler", () => {
  it("opens the round that is due with one open_next and hands the race its id and target", async () => {
    const chain = new FakeTestnet();
    const r = await open(chain);
    expect(r).toMatchObject({ kind: "opened", round: { id: "s1-0007-3fa9c2", challenge: "live-safe" } });
    expect(chain.sent).toEqual([{ receiver: SEASON, method: "open_next" }]);
  });

  it("sends nothing before the slot", async () => {
    const chain = new FakeTestnet();
    chain.now = SLOT - MINUTE;
    chain.next = { ...next, at_ns: SLOT.toString() };
    chain.latest = [yesterday];
    expect(await open(chain)).toEqual({ kind: "waiting", why: "round s1-0006-00aa11 already sealed for the slot of 2026-11-08T18:00:00Z" });
    expect(chain.sent).toEqual([]);
  });

  it("goes red when the treasury cannot pay for the round that is due", async () => {
    const chain = new FakeTestnet();
    chain.next = { ...next, funded: false, treasury: "1200000000000000000000000" };
    await expect(open(chain)).rejects.toThrow("the treasury holds 1.200 NEAR for rounds: too little for round #7");
    expect(chain.sent).toEqual([]);
  });

  it("goes red, saying why, when the slot was due and the treasury skipped it (season review finding 3)", async () => {
    // A skipped slot used to leave the run green: nobody noticed the show did not happen.
    const chain = new FakeTestnet();
    chain.value = null;
    chain.logs = ["no round this time: the bounty contract does not know the safe's code"];
    expect(await open(chain)).toMatchObject({
      kind: "missed",
      why: "the slot of 2026-11-09T18:00:00Z gets no round: no round this time: the bounty contract does not know the safe's code",
    });
  });

  it("races a round already open for this slot while it still seals (season review finding 2)", async () => {
    // An earlier run died after open_next, or someone with the scheduler's key opened the round first: the next run
    // found nothing due and raced nothing, and the round went by with its safe untouched.
    const chain = new FakeTestnet();
    chain.now = SLOT + 20n * MINUTE;
    chain.latest = [round];
    chain.next = { ...next, at_ns: (SLOT + 1440n * MINUTE).toString() };
    expect(await open(chain)).toMatchObject({ kind: "open", round: { id: "s1-0007-3fa9c2" } });
    expect(chain.sent).toEqual([]);
    // Once its commit window is over there is nothing left to seal: no race, and nothing was missed.
    chain.now = SLOT + 49n * MINUTE;
    expect(await open(chain)).toMatchObject({ kind: "waiting", why: "round s1-0007-3fa9c2 already sealed for the slot of 2026-11-09T18:00:00Z" });
    // Yesterday's round does not stand in for today's slot.
    chain.latest = [yesterday];
    chain.next = next;
    chain.now = SLOT + 20n * MINUTE;
    expect(await open(chain)).toMatchObject({ kind: "opened" });
  });

  it("finds the round in latest when open_next landed but its answer was lost (season review finding 2)", async () => {
    const chain = new FakeTestnet();
    chain.lost = true;
    chain.lands = round;
    expect(await open(chain)).toMatchObject({ kind: "opened", round: { id: "s1-0007-3fa9c2" } });
    // Lost and never landed: red.
    const lost = new FakeTestnet();
    lost.lost = true;
    await expect(open(lost)).rejects.toThrow("open_next: fetch failed");
  });

  it("fails loudly when open_next fails", async () => {
    const chain = new FakeTestnet();
    chain.failure = { ActionError: { kind: { FunctionCallError: { ExecutionError: "a round is already on its way" } } } };
    await expect(open(chain)).rejects.toThrow("a round is already on its way");
  });

  it("goes red when a slot is due and the program has no target to run (season review finding 3)", async () => {
    const chain = new FakeTestnet();
    chain.next = null;
    expect(await open(chain)).toMatchObject({ kind: "missed", why: expect.stringContaining("no target of the program can run") });
    // Before the first slot of a new program nothing was missed yet.
    chain.now = 1000n * MINUTE;
    expect(await open(chain)).toMatchObject({ kind: "waiting" });
  });

  it("brings finished rounds home with the same key, and sends nothing when none are", async () => {
    const chain = new FakeTestnet();
    expect(await collectFinished({ chain, season: SEASON, scheduler: SCHEDULER, key: KEY })).toBe(0);
    expect(chain.sent).toEqual([]);
    chain.collectable = 2;
    expect(await collectFinished({ chain, season: SEASON, scheduler: SCHEDULER, key: KEY })).toBe(2);
    expect(chain.sent).toEqual([{ receiver: SEASON, method: "collect" }]);
  });

  it("reads what collect returned, not the settle or refund that failed by design (season review finding 4)", async () => {
    const chain = new FakeTestnet();
    chain.collectable = 1;
    chain.collectReceiptFails = true;
    expect(await collectFinished({ chain, season: SEASON, scheduler: SCHEDULER, key: KEY })).toBe(1);
  });

  it("summarises the round for the workflow", () => {
    const lines = roundSummary(round, "TxHash");
    expect(lines[0]).toBe("### Round s1-0007-3fa9c2");
    expect(lines).toContain("- in the safe: 2.000 NEAR, bounty: 0.350 NEAR, a drain counts from 1.000 NEAR");
    expect(lines).toContain("- sealing until 2026-11-09T18:49:00Z, deadline 2026-11-09T20:04:00Z");
  });
});
