/**
 * The house's day on a made-up chain (house-chain.ts). Every test counts the transactions that landed: a day sends
 * each step once, whatever happened to the run on the way.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { codeHashHex, NETWORKS } from "@maskwars/network";
import { describe, expect, it } from "vitest";
import {
  CLAIM_SCAN,
  codeHashOf,
  daySummary,
  houseConfig,
  planDay,
  readHouse,
  retireMissing,
  roundArgs,
  runDay,
  stepText,
  stepTx,
  vaultFault,
  wasmInfo,
  type Day,
  type HouseConfig,
  type DayStep,
} from "../src/house.ts";
import type { NearKey } from "../src/near-tx.ts";
import { BOUNTY, CFG, CODE, FakeNear, GONE, HOUR, HOUSE, JUDGE, KEY, MILLI, MINUTE, NEAR, NOVA, NOW, OLD_CODE, ONYX, ORACLE, round, safeWasm, SLOT, VAULT, WASM, ns } from "./house-chain.ts";

const run = (chain: FakeNear, o: { key?: NearKey | null; cfg?: HouseConfig; wasm?: Uint8Array | null; anyTime?: boolean } = {}) =>
  runDay({
    chain,
    config: o.cfg ?? CFG,
    ...(o.key === null ? {} : { key: o.key ?? KEY }),
    wasm: o.wasm === undefined ? WASM : o.wasm,
    ...(o.anyTime ? { anyTime: true } : {}),
    settleMs: 0,
    sleep: async () => {},
  });

const why = (day: Day) => ("why" in day ? day.why : "");

describe("the house's day", () => {
  it("after a round a mask won: the vault retires, is made again without a key, and the next round opens", async () => {
    const chain = FakeNear.after("drained");
    const day = await run(chain);
    expect(day).toMatchObject({ kind: "opened", round: { id: "race-0003", safe: VAULT, challenge: "live-safe" } });
    expect(chain.steps).toEqual(["retire", "create", "open"]);
    expect(day.sent.map((s) => s.step)).toEqual(["retire", "create", "open"]);

    const [retire, create, open] = chain.landed as [FakeNear["landed"][0], FakeNear["landed"][0], FakeNear["landed"][0]];
    expect(retire).toMatchObject({ signer: HOUSE, receiver: VAULT, actions: [{ kind: "functionCall", method: "retire", args: {}, deposit: 0n }] });
    // One transaction, four actions, none of them a key: the account is born with none.
    expect(create.receiver).toBe(VAULT);
    expect(create.actions.map((a) => a.kind)).toEqual(["createAccount", "transfer", "deployContract", "functionCall"]);
    expect(create.actions[1]).toEqual({ kind: "transfer", deposit: 1930n * MILLI });
    expect((create.actions[2] as { code: Buffer }).code.equals(WASM)).toBe(true);
    expect(create.actions[3]).toMatchObject({ method: "new", args: { owner: VAULT, masks: [NOVA, ONYX, ORACLE], arbiter: BOUNTY, team: HOUSE }, deposit: 0n });
    expect(open).toMatchObject({ receiver: BOUNTY, actions: [{ method: "open_safe", deposit: 250n * MILLI }] });
    expect((open.actions[0] as { args: object }).args).toEqual({
      id: "race-0003",
      safe: VAULT,
      masks: [NOVA, ONYX, ORACLE],
      min_loot: (100n * MILLI).toString(),
      hours: 4,
      commit_minutes: 45,
      reveal_minutes: 60,
      safe_code: CODE,
      judge_version: JUDGE,
    });

    // The circle: what the old vault held came home, and the same NEAR went into the new vault and the round.
    expect(chain.house!.amount).toBe((900n + 1680n - 1930n - 250n) * MILLI);
    expect(chain.vault).toMatchObject({ amount: 1930n * MILLI, codeHash: CODE, keys: 0, owner: VAULT, team: HOUSE, lock: { bounty: "race-0003" } });
    expect(chain.bounties.get("race-0003")).toMatchObject({ owner: HOUSE, state: "open", deadline: NOW + 4n * HOUR });
  });

  it("after a round nobody won: the bounty is refunded first, then the same three steps", async () => {
    const chain = FakeNear.after("open");
    expect(await run(chain)).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(chain.steps).toEqual(["refund", "retire", "create", "open"]);
    expect(chain.bounties.get("race-0002")!.state).toBe("refunded");
  });

  it("pays a confirmed winner nobody paid yet before the vault retires", async () => {
    const chain = FakeNear.after("open", { seals: [{ state: "refused" }, { state: "confirmed" }] });
    expect(await run(chain)).toMatchObject({ kind: "opened" });
    expect(chain.steps).toEqual(["settle", "retire", "create", "open"]);
    expect(chain.bounties.get("race-0002")!.state).toBe("drained");
  });

  it("drops a claim the judge never answered, found by its number, then refunds", async () => {
    const chain = FakeNear.after("open");
    chain.claims.set(3, { bounty: "race-0001", by: ORACLE, height: "100" });
    chain.claims.set(21, { bounty: "race-0002", by: NOVA, height: String(chain.height - 5000) });
    expect(await run(chain)).toMatchObject({ kind: "opened" });
    expect(chain.steps).toEqual(["unstick", "refund", "retire", "create", "open"]);
    expect(chain.landed[0]!.actions[0]).toMatchObject({ method: "unstick", args: { id: "race-0002", claim: "21" } });
    // Another round's claim is not this day's business.
    expect([...chain.claims.keys()]).toEqual([3]);
  });

  it("on the first day there is no vault yet: it is made and the round opens under the first free id", async () => {
    const chain = new FakeNear();
    expect(await run(chain)).toMatchObject({ kind: "opened", round: { id: "race-0002" } });
    expect(chain.steps).toEqual(["create", "open"]);
    expect(chain.house!.amount).toBe((3080n - 1930n - 250n) * MILLI);
  });

  it("takes an id no bounty contract of the arena holds, the older ones included", async () => {
    const chain = new FakeNear();
    for (const n of [2, 3, 4, 5, 6]) chain.bounties.set(`race-000${n}`, round(ns("2026-11-01T10:00:00Z"), { owner: "maskwars.near", state: "refunded" }));
    for (const n of [7, 8]) chain.older.add(`race-000${n}`);
    const cfg = { ...CFG, contracts: [BOUNTY, "old.maskwars.near"] };
    expect(await run(chain, { cfg })).toMatchObject({ kind: "opened", round: { id: "race-0009" } });
  });
});

describe("a run that died, started again", () => {
  const order = ["refund", "retire", "create", "open"];

  it.each([1, 2, 3, 4])("right after step %i landed: the next run goes on from the chain and repeats nothing", async (n) => {
    const chain = FakeNear.after("open");
    chain.dieAfter = n;
    await expect(run(chain)).rejects.toThrow(GONE);
    expect(chain.steps).toEqual(order.slice(0, n));
    chain.dead = false;
    chain.dieAfter = null;
    const day = await run(chain);
    // The round is open either way; the run that only found it open says so and sends nothing.
    expect(day).toMatchObject({ kind: n === 4 ? "open" : "opened", round: { id: "race-0003" } });
    expect(day.sent.map((s) => s.step)).toEqual(order.slice(n));
    expect(chain.steps).toEqual(order);
  });

  it.each([0, 1, 2, 3])("right before step %i reached the chain: the next run sends it, once", async (n) => {
    const chain = FakeNear.after("open");
    chain.dieBefore = n;
    await expect(run(chain)).rejects.toThrow(GONE);
    expect(chain.steps).toEqual(order.slice(0, n));
    chain.dead = false;
    chain.dieBefore = null;
    expect(await run(chain)).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(chain.steps).toEqual(order);
  });

  it.each(order)("the answer to %s is lost but it landed: the same run reads the chain and goes on", async (step) => {
    const chain = FakeNear.after("open");
    chain.lost.add(step);
    const day = await run(chain);
    expect(day).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(chain.steps).toEqual(order);
    expect(day.sent.find((s) => s.step === step)!.hash).toBe("(the answer was lost)");
  });

  it.each(order)("%s never reached the chain: the run stops with the reason, and the next one finishes the day", async (step) => {
    const chain = FakeNear.after("open");
    chain.dropped.add(step);
    await expect(run(chain)).rejects.toThrow(`${step} failed: fetch failed`);
    expect(chain.steps).toEqual(order.slice(0, order.indexOf(step)));
    expect(await run(chain)).toMatchObject({ kind: "opened" });
    expect(chain.steps).toEqual(order);
  });

  it("a nonce a node read too early costs nothing: the step is signed again and lands once", async () => {
    const chain = FakeNear.after("drained");
    chain.staleNonce = 2;
    const day = await run(chain);
    expect(day).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(chain.steps).toEqual(["retire", "create", "open"]);
    expect(chain.staleNonce).toBe(0);
    // A node that never catches up stops the run instead of signing for ever.
    const stuck = FakeNear.after("drained");
    stuck.staleNonce = 99;
    await expect(run(stuck)).rejects.toThrow("retire failed: send_tx: INVALID_TRANSACTION");
    expect(stuck.steps).toEqual([]);
  });

  it("a vault an earlier run made and never opened takes the round as it is", async () => {
    const chain = new FakeNear();
    chain.vault = chain.newVault(1930n * MILLI, WASM);
    chain.house = { amount: 1150n * MILLI, storage: 300 };
    expect(await run(chain)).toMatchObject({ kind: "opened", round: { id: "race-0002" } });
    expect(chain.steps).toEqual(["open"]);
  });

  it("a vault left without a round that is not right goes back to the house first", async () => {
    const chain = new FakeNear();
    chain.vault = { ...chain.newVault(1930n * MILLI, WASM), masks: [NOVA, ONYX] };
    chain.house = { amount: 1150n * MILLI, storage: 300 };
    expect(await run(chain)).toMatchObject({ kind: "opened" });
    expect(chain.steps).toEqual(["retire", "create", "open"]);
    expect(chain.vault!.masks).toEqual([NOVA, ONYX, ORACLE]);
  });
});

describe("what is checked around the vault's code", () => {
  it("refuses a code the bounty contract does not list, before anything is made", async () => {
    const chain = new FakeNear();
    chain.safeCodes = [OLD_CODE];
    const day = await run(chain);
    expect(day.kind).toBe("skipped");
    expect(why(day)).toContain(`${BOUNTY} does not know the vault's code ${CODE}`);
    expect(why(day)).toContain("bounty-change.ps1 -AllowSafe");
    expect(chain.steps).toEqual([]);
  });

  it("refuses a wasm that is not the network's safe_code, and a day with no wasm or no safe_code at all", async () => {
    const other = Buffer.alloc(164_000, 8);
    let chain = new FakeNear();
    let day = await run(chain, { wasm: other });
    expect(why(day)).toBe(`the wasm at hand has code hash ${codeHashOf(other)}, not the network's safe_code ${CODE}`);
    // Even a code the contract knows is not deployed unless it is the one the network names.
    chain = new FakeNear();
    day = await run(chain, { wasm: Buffer.alloc(154_000, 3) });
    expect(why(day)).toContain(`not the network's safe_code ${CODE}`);
    chain = new FakeNear();
    expect(why(await run(chain, { wasm: null }))).toBe("the safe's wasm is not at hand: nothing to deploy");
    expect(why(await run(chain, { cfg: { ...CFG, safeCode: null } }))).toContain("safe_code is not set");
    expect(chain.steps).toEqual([]);
  });

  // The safe before 1.5.0 has the same views and its code may well be on the contract's list: made with the house's
  // 1.93 NEAR, it could never retire, and the stake of its code would be lost for good. Nothing is sent for it.
  it("refuses a code that cannot retire, even when it is the network's safe_code and the contract lists it", async () => {
    for (const [exports, said] of [
      [["new", "available"], "exports no retire or on_retire"],
      [["new", "retire", "available"], "exports no on_retire"],
      [["new", "on_retire"], "exports no retire"],
    ] as const) {
      const old = safeWasm(164_000, exports, 9);
      const chain = new FakeNear();
      chain.safeCodes.push(codeHashOf(old));
      const cfg = { ...CFG, safeCode: codeHashOf(old) };
      const day = await run(chain, { wasm: old, cfg });
      expect(day.kind).toBe("skipped");
      expect(why(day)).toBe(`the wasm at hand (${cfg.safeCode}) ${said}: a vault made from it could never retire and give the house its NEAR back`);
      expect(chain.steps).toEqual([]);
      expect(chain.house!.amount).toBe(3080n * MILLI);
      // Asked for its transaction all the same, the step refuses to build it.
      expect(() => stepTx({ kind: "create" }, cfg, old)).toThrow(said);
    }
    // Bytes that are no wasm at all export nothing.
    const junk = Buffer.alloc(164_000, 7);
    expect(wasmInfo(junk)).toEqual({ code: codeHashOf(junk), bytes: 164_000, exports: [] });
    const chain = new FakeNear();
    chain.safeCodes.push(codeHashOf(junk));
    expect(why(await run(chain, { wasm: junk, cfg: { ...CFG, safeCode: codeHashOf(junk) } }))).toContain("exports no retire or on_retire");
    expect(chain.steps).toEqual([]);
    // The safe the house deploys exports both.
    expect(wasmInfo(WASM).exports).toEqual(expect.arrayContaining(["retire", "on_retire"]));
  });

  it("still brings yesterday's NEAR home when today's round cannot open", async () => {
    const chain = FakeNear.after("drained");
    chain.safeCodes = [OLD_CODE];
    const day = await run(chain);
    expect(day.kind).toBe("skipped");
    expect(chain.steps).toEqual(["retire"]);
    expect(chain.vault).toBeNull();
    expect(chain.house!.amount).toBe((900n + 1680n) * MILLI);
  });

  it("after the vault is made: its code, no key, its owner and its team, or the round does not open", async () => {
    for (const [made, said] of [
      [{ keys: 1 }, "it holds 1 access key(s)"],
      [{ team: "maskwars.near" }, "its team is maskwars.near"],
      [{ owner: HOUSE }, `its owner is ${HOUSE}`],
      [{ codeHash: OLD_CODE }, `it runs code ${OLD_CODE}`],
      [{ arbiter: "bounty.someone.near" }, "its bounty contract is bounty.someone.near"],
    ] as const) {
      const chain = new FakeNear();
      chain.made = made;
      await expect(run(chain)).rejects.toThrow(`the vault this run made cannot take a round: ${VAULT} is on chain without a round and cannot take one (${said}`);
      expect(chain.steps).toEqual(["create"]);
    }
  });

  it("says what is wrong with a vault, check by check, and nothing about one that is right", () => {
    const chain = new FakeNear();
    const good = { amount: 1930n * MILLI, codeHash: CODE, keys: 0, safe: { owner: VAULT, team: HOUSE, arbiter: BOUNTY, masks: [ORACLE, NOVA, ONYX], available: 275n * MILLI, lock: null } };
    expect(vaultFault(good, CFG)).toBeNull();
    expect(vaultFault({ ...good, safe: null }, CFG)).toContain("does not answer as a safe");
    expect(vaultFault({ ...good, safe: { ...good.safe, available: 120n * MILLI } }, CFG)).toContain("less than the least drain of 0.1 NEAR");
    expect(chain.steps).toEqual([]);
  });

  it("does not make a vault whose NEAR would leave no loot above the stake of its code", async () => {
    // A wasm 17 KB bigger: its stake and the vault's state would take all but 0.06 NEAR of the 1.93.
    const big = safeWasm(181_000);
    const chain = new FakeNear();
    chain.safeCodes.push(codeHashOf(big));
    const day = await run(chain, { wasm: big, cfg: { ...CFG, safeCode: codeHashOf(big) } });
    expect(day.kind).toBe("skipped");
    expect(why(day)).toBe("1.93 NEAR in the vault would leave less than the least drain of 0.1 NEAR above the 1.87 NEAR its code and state lock");
    expect(chain.steps).toEqual([]);
  });
});

describe("the limits and the bounty contract's own word", () => {
  it("sends nothing above limits.hand, whatever the round asks for", async () => {
    const chain = new FakeNear();
    const safe = { ...CFG, round: { ...CFG.round, safe: 2600n * MILLI } };
    expect(why(await run(chain, { cfg: safe }))).toBe("the vault's 2.6 NEAR is above limits.hand.safe_max, 2.5 NEAR");
    const deposit = { ...CFG, round: { ...CFG.round, deposit: 1200n * MILLI } };
    expect(why(await run(chain, { cfg: deposit }))).toBe("the round's deposit of 1.2 NEAR is above limits.hand.deposit_max, 1.1 NEAR");
    expect(chain.steps).toEqual([]);
  });

  it("the sums are the network's own: nothing is written into the step", () => {
    for (const net of ["mainnet", "testnet"] as const) {
      const n = NETWORKS[net];
      const cfg = houseConfig(n, JUDGE);
      expect(cfg.round.safe).toBe(BigInt(Number(n.round.safe) * 1000) * MILLI);
      expect(cfg.round.deposit).toBe(BigInt(Number(n.round.deposit) * 1000) * MILLI);
      expect(cfg.limits).toEqual({ safeMax: BigInt(Number(n.limits.hand.safe_max) * 1000) * MILLI, depositMax: BigInt(Number(n.limits.hand.deposit_max) * 1000) * MILLI });
      expect(cfg).toMatchObject({ house: n.house, vault: n.vault, bounty: n.bounty, contracts: [n.bounty, ...n.older_bounty], masks: Object.values(n.masks), safeCode: n.safe_code });
      const create = stepTx({ kind: "create" }, cfg, WASM);
      expect(create.actions[1]).toEqual({ kind: "transfer", deposit: cfg.round.safe });
      expect(stepTx({ kind: "open", id: "race-0009" }, cfg).actions[0]).toMatchObject({ deposit: cfg.round.deposit });
      expect(roundArgs(cfg, "race-0009")).toMatchObject({ hours: n.round.hours, commit_minutes: n.round.commit_minutes, reveal_minutes: n.round.reveal_minutes });
    }
  });

  it("opens nothing with another judge than the one the house agrees to, or while new code waits on the contract", async () => {
    const chain = new FakeNear();
    chain.judge = "ab".repeat(32);
    expect(why(await run(chain))).toContain(`judges new rounds with ${"ab".repeat(32)}, not with ${JUDGE}`);
    chain.judge = JUDGE;
    chain.pending = { change: { kind: "code" } };
    expect(why(await run(chain))).toContain("a new code waits on");
    // A new safe code or judge waiting does not stop a bounty.
    chain.pending = { change: { kind: "allow_safe" } };
    expect(await run(chain)).toMatchObject({ kind: "opened" });
  });

  it("stops when the safe would not arm: one open_safe, and the reason", async () => {
    const chain = new FakeNear();
    chain.armFails = true;
    await expect(run(chain)).rejects.toThrow("open failed");
    expect(chain.steps).toEqual(["create"]);
    expect(chain.bounties.get("race-0002")!.state).toBe("refunded");
    // The bounty the contract gave back at once is not the slot's round: the next run tries again, under the next id.
    chain.armFails = false;
    expect(await run(chain)).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(chain.steps).toEqual(["create", "open"]);
  });
});

describe("a day that is skipped", () => {
  it("while yesterday's round is still played: nothing is sent", async () => {
    const chain = FakeNear.after("open");
    // Opened late yesterday: its masks can claim for hours yet.
    chain.bounties.set("race-0002", round(SLOT - 10n * HOUR));
    chain.vault!.lock!.armed_ns = (SLOT - 10n * HOUR).toString();
    const day = await run(chain);
    expect(day.kind).toBe("skipped");
    expect(why(day)).toBe("round race-0002 is not over: nobody won it, and its masks can still claim until 2026-11-12 00:00 UTC");
    expect(chain.steps).toEqual([]);
    expect(chain.vault).not.toBeNull();
  });

  it("while a claim is with a judge who may still answer", async () => {
    const chain = FakeNear.after("open");
    chain.claims.set(4, { bounty: "race-0002", by: NOVA, height: String(chain.height - 100) });
    const day = await run(chain);
    expect(why(day)).toContain(`claim #4 of ${NOVA} is with the judge, who may still answer until block ${chain.height + 500}`);
    expect(chain.steps).toEqual([]);
  });

  it("when a claim with the judge cannot be found by number: by hand, and nothing is guessed", async () => {
    const chain = FakeNear.after("open");
    chain.claims.set(CLAIM_SCAN + 7, { bounty: "race-0002", by: NOVA, height: "1" });
    const day = await run(chain);
    expect(day.kind).toBe("skipped");
    expect(why(day)).toContain("1 claim(s) are with the judge and only 0 could be found by number");
    expect(chain.steps).toEqual([]);
  });

  it("when a mask won and the round's deadline has not come: the vault stays", async () => {
    const chain = FakeNear.after("drained");
    chain.bounties.get("race-0002")!.deadline = NOW + HOUR;
    expect(why(await run(chain))).toContain("its winner is paid, and the vault retires only after the round's deadline");
    expect(chain.steps).toEqual([]);
  });

  it("when the house cannot pay for the round: no vault is made, half a round is never left", async () => {
    const chain = new FakeNear();
    chain.house = { amount: 2000n * MILLI, storage: 300 };
    const day = await run(chain);
    expect(day.kind).toBe("skipped");
    expect(why(day)).toBe("the house holds 1.997 NEAR free: the round needs 2.28 NEAR");
    expect(chain.steps).toEqual([]);
    expect(chain.vault).toBeNull();
  });

  it("when the house cannot pay even with what the vault gives back: the vault comes home, nothing is made", async () => {
    const chain = FakeNear.after("drained");
    chain.house = { amount: 400n * MILLI, storage: 300 };
    const day = await run(chain);
    expect(day.kind).toBe("skipped");
    expect(why(day)).toBe("the house holds 2.077 NEAR free: the round needs 2.28 NEAR");
    expect(chain.steps).toEqual(["retire"]);
  });

  it("when the house is not on chain, or something else stands on the vault's name", async () => {
    const chain = new FakeNear();
    chain.house = null;
    expect(why(await run(chain))).toContain(`the house ${HOUSE} is not on chain yet`);
    chain.house = { amount: 3080n * MILLI, storage: 300 };
    chain.vault = { ...chain.newVault(NEAR, Buffer.from("other")), lock: null };
    expect(why(await run(chain))).toContain(`${VAULT} is on chain and does not answer as a safe`);
    expect(chain.steps).toEqual([]);
  });

  it("when it is too late for the slot: a round opened now could not be over before the next one", async () => {
    const chain = new FakeNear();
    chain.now = SLOT + 9n * HOUR;
    const day = await run(chain);
    expect(day.kind).toBe("skipped");
    expect(why(day)).toBe("too late for the slot of 2026-11-11 18:00 UTC: a round opened now could stay open until 2026-11-12 19:00 UTC, past the next slot");
    // Eight hours after the slot it still fits.
    chain.now = SLOT + 8n * HOUR;
    expect(await run(chain)).toMatchObject({ kind: "opened" });
  });
});

describe("a slot gets one round", () => {
  it("a round still sealing is raced as it is, with nothing sent, key or no key", async () => {
    const chain = FakeNear.after("open");
    chain.bounties.set("race-0002", round(NOW - 10n * MINUTE));
    chain.vault!.lock!.armed_ns = (NOW - 10n * MINUTE).toString();
    for (const key of [KEY, null]) {
      const day = await run(chain, { key });
      expect(day).toMatchObject({ kind: "open", round: { id: "race-0002", commitUntilNs: NOW + 35n * MINUTE } });
      expect(why(day)).toBe("round race-0002 is open and seals until 2026-11-11 18:39 UTC: racing it");
    }
    expect(chain.steps).toEqual([]);
  });

  it("once the slot's round is sealed or over, the day is done: no second round, and the vault waits for tomorrow", async () => {
    const chain = FakeNear.after("open");
    chain.bounties.set("race-0002", round(SLOT + MINUTE));
    chain.now = SLOT + 2n * HOUR;
    expect(await run(chain)).toMatchObject({ kind: "done", why: "round race-0002 is the round of the slot of 2026-11-11 18:00 UTC: it is on its way" });
    chain.bounties.get("race-0002")!.state = "drained";
    chain.now = SLOT + 5n * HOUR;
    expect(await run(chain)).toMatchObject({ kind: "done", why: "round race-0002 is the round of the slot of 2026-11-11 18:00 UTC: drained" });
    // Even with the vault retired by hand since, the slot is not opened twice.
    chain.vault = null;
    expect(await run(chain)).toMatchObject({ kind: "done", why: "round race-0002 already ran for the slot of 2026-11-11 18:00 UTC" });
    expect(chain.steps).toEqual([]);
  });

  // The workflow runs at 18:04, 19:04 and 21:04 UTC so that one start GitHub drops does not cost the day: each run after
  // the one that opened the round finds it and sends nothing.
  it("the runs after the one that opened the slot's round send nothing, key or no key", async () => {
    const chain = FakeNear.after("drained");
    expect(await run(chain)).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    const landed = chain.landed.length;
    const house = chain.house!.amount;
    for (const at of [SLOT + HOUR + 4n * MINUTE, SLOT + 3n * HOUR + 4n * MINUTE]) {
      chain.now = at;
      for (const key of [KEY, null]) {
        expect(await run(chain, { key })).toEqual({ kind: "done", why: "round race-0003 is the round of the slot of 2026-11-11 18:00 UTC: it is on its way", sent: [] });
      }
    }
    // Won in the meantime, it is still the slot's round.
    chain.bounties.get("race-0003")!.state = "drained";
    expect(await run(chain)).toMatchObject({ kind: "done", sent: [] });
    expect(chain.landed).toHaveLength(landed);
    expect(chain.house!.amount).toBe(house);
  });

  it("by hand the owner chooses the time: the slots do not hold the plan back, and it says what that costs", async () => {
    const chain = FakeNear.after("drained");
    chain.now = SLOT + 20n * HOUR;
    const state = await readHouse(chain, CFG);
    const wasm = wasmInfo(WASM);
    expect(planDay(state, CFG, { wasm })).toMatchObject({ kind: "steps", steps: [{ kind: "retire" }], stop: expect.stringContaining("too late for the slot") });
    const byHand = planDay(state, CFG, { wasm, anyTime: true });
    expect(byHand).toMatchObject({ kind: "steps", steps: [{ kind: "retire" }, { kind: "create" }, { kind: "open", id: "race-0003" }] });
    expect(byHand).toMatchObject({ note: "a round opened now can stay open until 2026-11-13 06:00 UTC: the slot of 2026-11-12 18:00 UTC would be skipped if nobody wins it" });
  });
});

// The Season workflow deploys the file the repository carries (scripts/house-open.ts): once a network names the vault's
// code, that wasm must be in apps/web/public/contracts under its sha256, hash to it and be able to retire. Until then
// (safe_code null) the step says the code is not set and makes nothing.
describe.each(["mainnet", "testnet"] as const)("%s: the vault's wasm in the repository", (net) => {
  it("is there, under the sha256 of safe_code, and exports retire and on_retire", () => {
    const code = NETWORKS[net].safe_code;
    if (code === null) {
      const chain = new FakeNear();
      const fresh = { nowNs: chain.now, height: chain.height, house: { amount: 3080n * MILLI, free: 3077n * MILLI }, vault: null, round: null, safeCodes: [CODE], judge: JUDGE, blocking: null, nextId: "race-0002", last: null };
      expect(planDay(fresh, houseConfig(NETWORKS[net], JUDGE), { wasm: wasmInfo(WASM) })).toMatchObject({ kind: "skip", why: expect.stringContaining("safe_code is not set") });
      return;
    }
    const hex = codeHashHex(code);
    const dir = new URL("../../../apps/web/public/contracts/", import.meta.url);
    const file = (existsSync(dir) ? readdirSync(dir) : []).find((f) => f.endsWith(`${hex}.wasm`));
    expect(file, `apps/web/public/contracts/<name>-${hex}.wasm, the code ${net}.json names`).toBeDefined();
    const wasm = readFileSync(new URL(file!, dir));
    expect(codeHashOf(wasm)).toBe(code);
    expect(retireMissing(wasmInfo(wasm))).toEqual([]);
  });
});

describe("without the house's key", () => {
  it("nothing is sent: the steps wait for whoever signs for the house", async () => {
    const chain = FakeNear.after("open");
    const day = await run(chain, { key: null });
    expect(day).toMatchObject({ kind: "unsigned", steps: [{ kind: "refund", id: "race-0002" }, { kind: "retire" }, { kind: "create" }, { kind: "open", id: "race-0003" }] });
    expect(chain.steps).toEqual([]);
    expect(daySummary(day, CFG)).toEqual([
      "### The house's round waits for a signature",
      "",
      `- refund: the bounty of race-0002, which nobody won, goes back to ${HOUSE}`,
      `- retire: ${VAULT} deletes itself and gives its whole balance back to ${HOUSE}`,
      `- make ${VAULT} with 1.93 NEAR in one transaction that adds no key: create, fund, deploy, new`,
      `- open_safe: round race-0003 on ${VAULT} with a deposit of 0.25 NEAR`,
    ]);
  });

  it("the summary of an opened round names the round, the sums and every transaction", async () => {
    const chain = FakeNear.after("drained");
    const lines = daySummary(await run(chain), CFG);
    expect(lines[0]).toBe("### Round race-0003");
    expect(lines).toContain(`- target: \`live-safe\` on \`${VAULT}\` (code \`${CODE}\`)`);
    expect(lines).toContain("- in the vault: 1.93 NEAR, deposit: 0.25 NEAR, a drain counts from 0.1 NEAR");
    expect(lines).toContain("- sealing until 2026-11-11 18:49 UTC, deadline 2026-11-11 22:04 UTC");
    expect(lines.filter((l) => /^- `(retire|create|open)`: /.test(l))).toHaveLength(3);
  });

  it("every step reads as one plain line", () => {
    const steps: DayStep[] = [{ kind: "unstick", id: "race-0002", claim: 21, mask: NOVA }, { kind: "settle", id: "race-0002" }];
    expect(steps.map((s) => stepText(s, CFG))).toEqual([
      `unstick: drop claim #21 of ${NOVA} on race-0002, which the judge never answered`,
      `settle: ${BOUNTY} pays the confirmed winner of race-0002`,
    ]);
  });
});
