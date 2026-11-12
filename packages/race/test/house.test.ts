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
  HOME_LEAST,
  homeAmount,
  houseConfig,
  houseMethod,
  HOUSE_METHODS,
  houseStepTx,
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
import {
  BOUNTY,
  CFG,
  CODE,
  FakeNear,
  GONE,
  HOME_CODE,
  HOUR,
  HOUSE,
  JUDGE,
  KEY,
  MASK_BYTES,
  MASK_KEEPS,
  MILLI,
  MINUTE,
  NEAR,
  NO_CODE,
  NOVA,
  NOW,
  OLD_CODE,
  ONYX,
  ORACLE,
  round,
  safeWasm,
  SLOT,
  VAULT,
  WASM,
  ns,
} from "./house-chain.ts";

const run = (chain: FakeNear, o: { key?: NearKey | null; cfg?: HouseConfig; wasm?: Uint8Array | null; anyTime?: boolean; log?: (line: string) => void } = {}) =>
  runDay({
    chain,
    config: o.cfg ?? CFG,
    ...(o.key === null ? {} : { key: o.key ?? KEY }),
    wasm: o.wasm === undefined ? WASM : o.wasm,
    ...(o.anyTime ? { anyTime: true } : {}),
    ...(o.log ? { log: o.log } : {}),
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

// The house contract (contracts/house) on the house's own account: the day's key is a function-call key for its seven
// methods alone, so every step, the masks' winnings first, is a call on the house that the contract passes on.
describe("through the house contract", () => {
  const DAY_NS = 24n * HOUR;
  const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

  it("sends each step of the day as a call on the house, nothing attached, the masks' winnings first", async () => {
    const chain = FakeNear.after("open").mask(NOVA, 300n * MILLI);
    chain.contract = { lastRound: 2, lastSlot: SLOT - DAY_NS, made: SLOT - DAY_NS };
    const logs: string[] = [];
    expect(await run(chain, { log: (l) => logs.push(l) })).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(chain.steps).toEqual(["home", "refund", "retire", "create", "open"]);
    for (const t of chain.landed) {
      expect(t, t.step).toMatchObject({ signer: HOUSE, receiver: HOUSE, actions: [{ kind: "functionCall", deposit: 0n }] });
      expect(HOUSE_METHODS).toContain((t.actions[0] as { method: string }).method);
    }
    const calls = chain.landed.map((t) => t.actions[0] as { method: string; args: Record<string, unknown> });
    expect(calls.map((c) => c.method)).toEqual(["home", "refund", "retire", "make_vault", "open_round"]);
    expect(calls[0]!.args).toEqual({ mask: NOVA });
    expect(calls[1]!.args).toEqual({ id: "race-0002" });
    expect((calls[3]!.args.wasm as Buffer).equals(WASM)).toBe(true);
    expect(calls[4]!.args).toEqual({ id: "race-0003" });
    expect(logs.some((l) => l.includes("(through the house contract: make_vault)"))).toBe(true);
    // The circle closed the same way: NOVA's winnings home, the vault made again, the round open on it.
    expect(chain.masks.get(NOVA)!.amount).toBe(MASK_KEEPS);
    expect(chain.vault).toMatchObject({ amount: 1930n * MILLI, codeHash: CODE, keys: 0, team: HOUSE, lock: { bounty: "race-0003" } });
    expect(chain.contract).toEqual({ lastRound: 3, lastSlot: SLOT, made: SLOT });
  });

  it("each kind of step has its method, the key's seven, and the gas the key pays for is bounded", () => {
    const steps: DayStep[] = [
      { kind: "home", mask: ORACLE, amount: NEAR },
      { kind: "unstick", id: "race-0002", claim: 21, mask: NOVA },
      { kind: "settle", id: "race-0002" },
      { kind: "refund", id: "race-0002" },
      { kind: "retire" },
      { kind: "create" },
      { kind: "open", id: "race-0003" },
    ];
    expect(steps.map(houseMethod)).toEqual([...HOUSE_METHODS]);
    const txs = steps.map((s) => houseStepTx(s, CFG, WASM));
    for (const tx of txs) {
      expect(tx.receiver).toBe(HOUSE);
      expect(tx.actions).toHaveLength(1);
      const a = tx.actions[0] as { gas: bigint; deposit: bigint };
      expect(a.deposit).toBe(0n);
      expect(a.gas).toBeLessThanOrEqual(120n * 10n ** 12n);
    }
    expect(Buffer.from((txs[1]!.actions[0] as { args: Uint8Array }).args).toString()).toBe(`{"id":"race-0002","claim":"21"}`);
    expect(Buffer.from((txs[5]!.actions[0] as { args: Uint8Array }).args).equals(WASM)).toBe(true);
    expect(() => houseStepTx({ kind: "create" }, CFG, null)).toThrow("the safe's wasm is not at hand");
    expect(() => houseStepTx({ kind: "create" }, CFG, safeWasm(1000, ["new"]))).toThrow("exports no retire or on_retire");
  });

  it("a vault made in an earlier slot retires and is made again: the contract opens only on a vault made in the slot", async () => {
    const chain = new FakeNear();
    chain.vault = chain.newVault(1930n * MILLI, WASM);
    chain.house = { amount: 1150n * MILLI, storage: 36_400 };
    chain.contract = { lastRound: 1, lastSlot: SLOT - DAY_NS, made: SLOT - DAY_NS };
    const plan = planDay(await readHouse(chain, CFG), CFG, { wasm: wasmInfo(WASM) });
    expect(plan).toMatchObject({ kind: "steps", steps: [{ kind: "retire" }, { kind: "create" }, { kind: "open", id: "race-0002" }] });
    expect(plan.kind === "steps" && plan.note).toMatch(/made before this slot/);
    expect(await run(chain)).toMatchObject({ kind: "opened", round: { id: "race-0002" } });
    expect(chain.steps).toEqual(["retire", "create", "open"]);

    // Made in this slot, the same vault takes the round as it is.
    const fresh = new FakeNear();
    fresh.vault = fresh.newVault(1930n * MILLI, WASM);
    fresh.contract = { lastRound: 1, lastSlot: SLOT - DAY_NS, made: SLOT };
    expect(await run(fresh)).toMatchObject({ kind: "opened", round: { id: "race-0002" } });
    expect(fresh.steps).toEqual(["open"]);
  });

  it("opens only a number after the contract's own last round", async () => {
    const chain = new FakeNear();
    chain.contract = { lastRound: 41, lastSlot: 0n, made: 0n };
    expect(await run(chain)).toMatchObject({ kind: "opened", round: { id: "race-0042" } });
    expect(chain.contract).toMatchObject({ lastRound: 42, lastSlot: SLOT, made: SLOT });
  });

  it("the key the owner adds is for the contract's seven methods, with an allowance of 0.3 NEAR", () => {
    const contract = repo("contracts/house/src/contract.rs");
    for (const m of HOUSE_METHODS) expect(contract, m).toMatch(new RegExp(`pub extern "C" fn ${m}\\(\\)`));
    // The spec is a working document of the development repository; the contract's README goes everywhere the code goes.
    for (const doc of ["docs/spec/house-contract.md", "contracts/house/README.md"].filter((d) => d.startsWith("contracts/") || existsSync(new URL(`../../../${d}`, import.meta.url)))) {
      const names = /--function-names '([^']+)'/.exec(repo(doc))?.[1];
      expect(names?.split(/,\s*/), doc).toEqual([...HOUSE_METHODS]);
      expect(repo(doc), doc).toContain("--allowance '0.3 NEAR'");
      expect(repo(doc), doc).not.toContain("--allowance '1 NEAR'");
    }
  });
});

// The masks run contracts/home: anyone may call home(), and everything a mask holds above 0.4 NEAR and the stake of its
// storage goes to the house and nowhere else. On 13.11 the house alone would hold 2.27 NEAR of the 2.28 a round needs;
// what the winner holds above what it keeps is what opens the round.
describe("the masks' winnings come home first", () => {
  /** The day after a round NOVA won, with a house that cannot open the next one on its own: 0.497 + 1.68 < 2.28. */
  const after13 = () => {
    const chain = FakeNear.after("drained").mask(NOVA, 390n * MILLI).mask(ONYX, 0n).mask(ORACLE, 5n * MILLI);
    chain.house = { amount: 500n * MILLI, storage: 300 };
    return chain;
  };

  it("what the winner holds above what it keeps comes home first, counts toward the round, and the round opens", async () => {
    const chain = after13();
    const day = await run(chain);
    expect(day).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(chain.steps).toEqual(["home", "retire", "create", "open"]);
    expect(day.sent.map((s) => s.step)).toEqual(["home", "retire", "create", "open"]);
    // A plain home() on the mask, signed by the house: no argument, no deposit, 10 TGas.
    expect(chain.landed[0]).toEqual({
      step: "home",
      signer: HOUSE,
      receiver: NOVA,
      actions: [{ kind: "functionCall", method: "home", args: {}, gas: 10n * 10n ** 12n, deposit: 0n }],
    });
    // NOVA keeps exactly what it keeps; ORACLE's 0.005 NEAR is not worth the gas of a call and waits for its next win.
    expect(chain.masks.get(NOVA)!.amount).toBe(MASK_KEEPS);
    expect(chain.masks.get(ORACLE)!.amount).toBe(MASK_KEEPS + 5n * MILLI);
    expect(chain.house!.amount).toBe((500n + 390n + 1680n - 1930n - 250n) * MILLI);
  });

  it("a node a block behind shows the mask paid out before the house is credited: the day reads again and opens", async () => {
    // No vault to retire (the first day, or one already retired): the round opens on what the house holds and what
    // NOVA brings home, 0.5 + 1.9 ≥ 2.28. The node answers the house's balance two readings late after the home().
    const chain = new FakeNear().mask(NOVA, 1900n * MILLI).mask(ONYX, 0n).mask(ORACLE, 0n);
    chain.house = { amount: 500n * MILLI, storage: 300 };
    chain.houseLag = 2;
    const day = await runDay({ chain, config: CFG, key: KEY, wasm: WASM, settleMs: 60_000, sleep: async () => {} });
    expect(day).toMatchObject({ kind: "opened" });
    expect(chain.steps).toEqual(["home", "create", "open"]);
  });

  it("without home on the mask the same day is skipped, and says why: the winnings stay with it", async () => {
    const chain = after13();
    chain.masks.get(NOVA)!.code = NO_CODE;
    const day = await run(chain);
    expect(day.kind).toBe("skipped");
    expect(why(day)).toBe(
      `the house holds 2.177 NEAR free: the round needs 2.28 NEAR; winnings that stay with their mask: ${NOVA} holds 0.39 NEAR above what it keeps and runs code ${NO_CODE}, not home ${HOME_CODE}; scripts/mainnet/home-deploy.mjs prints the deploy of home`,
    );
    // The vault still came home; nothing was called on a mask that does not run home.
    expect(chain.steps).toEqual(["retire"]);
    expect(chain.masks.get(NOVA)!.amount).toBe(MASK_KEEPS + 390n * MILLI);
  });

  it("calls home() only on a mask that runs the network's home_code; any other is skipped and said", async () => {
    const chain = after13();
    chain.masks.get(NOVA)!.code = OLD_CODE;
    chain.masks.get(ONYX)!.amount += 200n * MILLI;
    const lines: string[] = [];
    expect(await run(chain, { log: (l) => lines.push(l) })).toMatchObject({ kind: "opened" });
    expect(chain.landed.filter((t) => t.step === "home").map((t) => t.receiver)).toEqual([ONYX]);
    expect(lines).toContain(
      `winnings that stay with their mask: ${NOVA} holds 0.39 NEAR above what it keeps and runs code ${OLD_CODE}, not home ${HOME_CODE}; scripts/mainnet/home-deploy.mjs prints the deploy of home`,
    );
    expect(lines).toContain(`home: ${ONYX} sends the 0.2 NEAR it holds above what it keeps back to ${HOUSE}`);
    // A network that names no home code calls home() on nobody.
    const none = after13();
    const day = await run(none, { cfg: { ...CFG, homeCode: null } });
    expect(day.kind).toBe("skipped");
    expect(why(day)).toContain(`${NOVA} holds 0.39 NEAR above what it keeps, and the network names no home_code`);
    expect(none.steps).toEqual(["retire"]);
  });

  it("a home() that does not bring the winnings home stops nothing: the day goes on without them", async () => {
    // The house can open the round without NOVA's winnings: the day opens it all the same.
    const rich = FakeNear.after("drained").mask(NOVA, 390n * MILLI);
    rich.homeFails.add(NOVA);
    const lines: string[] = [];
    const day = await run(rich, { log: (l) => lines.push(l) });
    expect(day).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(rich.steps).toEqual(["retire", "create", "open"]);
    expect(day.sent.map((s) => s.step)).toEqual(["retire", "create", "open"]);
    expect(lines.some((l) => l.includes(`home: failed:`) && l.includes(`${NOVA} still holds its winnings: the day goes on without them`))).toBe(true);
    expect(rich.masks.get(NOVA)!.amount).toBe(MASK_KEEPS + 390n * MILLI);
    // The house cannot: the vault still comes home, and the day says why no round opens.
    const poor = after13();
    poor.homeFails.add(NOVA);
    const skipped = await run(poor);
    expect(skipped.kind).toBe("skipped");
    expect(why(skipped)).toBe(
      `the house holds 2.177 NEAR free: the round needs 2.28 NEAR; winnings that stay with their mask: ${NOVA} holds 0.39 NEAR above what it keeps, and this run has called its home() once already`,
    );
    expect(poor.steps).toEqual(["retire"]);
  });

  it("a home() whose answer was lost lands once, and the day goes on", async () => {
    const chain = after13();
    chain.lost.add(`home:${NOVA}`);
    expect(await run(chain)).toMatchObject({ kind: "opened" });
    expect(chain.steps).toEqual(["home", "retire", "create", "open"]);
  });

  it("brings each mask's winnings home in one call each, and never takes the house above limits.house_max", async () => {
    const chain = FakeNear.after("drained").mask(NOVA, 390n * MILLI).mask(ONYX, 110n * MILLI).mask(ORACLE, 3000n * MILLI);
    const lines: string[] = [];
    expect(await run(chain, { log: (l) => lines.push(l) })).toMatchObject({ kind: "opened" });
    expect(chain.landed.filter((t) => t.step === "home").map((t) => t.receiver)).toEqual([NOVA, ONYX]);
    // 0.9 + 1.68 from the vault + 0.39 + 0.11 is 3.08 NEAR; ORACLE's 3 more would take the house past its 3.5.
    const stays = `winnings that stay with their mask: ${ORACLE} holds 3 NEAR above what it keeps, and bringing it home would take ${HOUSE} above limits.house_max, 3.5 NEAR, with what the vault brings back`;
    expect(lines).toContain(stays);
    expect(chain.masks.get(ORACLE)!.amount).toBe(MASK_KEEPS + 3000n * MILLI);
    // The vault's NEAR counts even when the winnings alone would fit: 0.5 + 3 is the limit, and the vault's 1.68 is not.
    const poor = FakeNear.after("drained").mask(ORACLE, 3000n * MILLI);
    poor.house = { amount: 500n * MILLI, storage: 300 };
    const skipped = await run(poor);
    expect(skipped.kind).toBe("skipped");
    expect(why(skipped)).toBe(`the house holds 2.177 NEAR free: the round needs 2.28 NEAR; ${stays}`);
    expect(poor.steps).toEqual(["retire"]);
    expect(poor.house!.amount).toBeLessThanOrEqual(3500n * MILLI);
  });

  it("calls home() once per mask in a run: what a mask is paid after it waits for the next run, and stops nothing", async () => {
    // Every mask holds something on the first day; a stranger tops NOVA up right after its home(), and the confirmed
    // winner of yesterday's round is paid by settle after the masks' calls: no mask is called twice, the day opens.
    const chain = FakeNear.after("open", { seals: [{ state: "confirmed" }] }).mask(NOVA, 80n * MILLI).mask(ONYX, 80n * MILLI).mask(ORACLE, 80n * MILLI);
    chain.onLanded = (step, receiver) => {
      if (step === "home" && receiver === NOVA) chain.masks.get(NOVA)!.amount += 200n * MILLI;
      if (step === "settle") chain.masks.get(ORACLE)!.amount += 110n * MILLI;
    };
    const lines: string[] = [];
    const day = await run(chain, { log: (l) => lines.push(l) });
    expect(day).toMatchObject({ kind: "opened", round: { id: "race-0003" } });
    expect(chain.steps).toEqual(["home", "home", "home", "settle", "retire", "create", "open"]);
    expect(chain.landed.filter((t) => t.step === "home").map((t) => t.receiver)).toEqual([NOVA, ONYX, ORACLE]);
    expect(day.sent.map((s) => s.step)).toEqual(["home", "home", "home", "settle", "retire", "create", "open"]);
    expect(lines.some((l) => l.includes(`${NOVA} holds 0.2 NEAR above what it keeps, and this run has called its home() once already`))).toBe(true);
    expect(lines.some((l) => l.includes(`${ORACLE} holds 0.11 NEAR above what it keeps, and this run has called its home() once already`))).toBe(true);
    // The next run brings both home.
    chain.onLanded = null;
    chain.now += 24n * HOUR;
    await run(chain);
    expect(chain.steps.slice(7, 9)).toEqual(["home", "home"]);
    expect(chain.landed.slice(7, 9).map((t) => t.receiver)).toEqual([NOVA, ORACLE]);
  });

  it("nothing is called while a round is sealing, once the slot has its round, or before the house is on chain", async () => {
    const sealing = FakeNear.after("open").mask(NOVA, 390n * MILLI);
    sealing.bounties.set("race-0002", round(NOW - 10n * MINUTE));
    sealing.vault!.lock!.armed_ns = (NOW - 10n * MINUTE).toString();
    expect(await run(sealing)).toMatchObject({ kind: "open" });
    const done = FakeNear.after("open").mask(NOVA, 390n * MILLI);
    done.bounties.set("race-0002", round(SLOT + MINUTE));
    done.now = SLOT + 2n * HOUR;
    expect(await run(done)).toMatchObject({ kind: "done" });
    const homeless = after13();
    homeless.house = null;
    expect(why(await run(homeless))).toContain("is not on chain yet");
    for (const chain of [sealing, done, homeless]) expect(chain.steps).toEqual([]);
  });

  it("without the house's key the winnings wait with the rest of the day, as one line each", async () => {
    const chain = after13();
    const day = await run(chain, { key: null });
    expect(day).toMatchObject({ kind: "unsigned", steps: [{ kind: "home", mask: NOVA, amount: 390n * MILLI }, { kind: "retire" }, { kind: "create" }, { kind: "open" }] });
    expect(daySummary(day, CFG)[2]).toBe(`- home: ${NOVA} sends the 0.39 NEAR it holds above what it keeps back to ${HOUSE}`);
    expect(stepTx({ kind: "home", mask: ONYX, amount: NEAR }, CFG)).toMatchObject({ receiver: ONYX, actions: [{ method: "home", gas: 10n * 10n ** 12n, deposit: 0n }] });
    // What comes home is counted before it is sent: here even with it the house cannot pay, and the plan says so.
    chain.house = { amount: 100n * MILLI, storage: 300 };
    expect(await run(chain, { key: null })).toMatchObject({
      kind: "unsigned",
      steps: [{ kind: "home" }, { kind: "retire" }],
      stop: "the house holds 0.097 NEAR free and 1.68 NEAR comes back with the vault and 0.39 NEAR comes home from the masks: the round needs 2.28 NEAR",
    });
    expect(chain.steps).toEqual([]);
  });

  it("counts what goes home the way contracts/home does: above 0.4 NEAR and the stake of the mask's storage", async () => {
    const keep = 400n * MILLI + BigInt(MASK_BYTES) * 10n ** 19n;
    expect(keep).toBe(MASK_KEEPS);
    expect(homeAmount({ amount: keep, storageUsage: MASK_BYTES }, CFG)).toBe(0n);
    expect(homeAmount({ amount: keep - 1n, storageUsage: MASK_BYTES }, CFG)).toBe(0n);
    expect(homeAmount({ amount: keep + 1n, storageUsage: MASK_BYTES }, CFG)).toBe(1n);
    expect(homeAmount({ amount: keep + NEAR, storageUsage: MASK_BYTES + 1 }, CFG)).toBe(NEAR - 10n ** 19n);
    expect(HOME_LEAST).toBe(10n * MILLI);
    // The reading: each mask on chain with what it holds, stores and runs; a mask that is not on chain is left out.
    const s = await readHouse(new FakeNear().mask(NOVA, 7n), CFG);
    expect(s.masks).toEqual([{ account: NOVA, amount: MASK_KEEPS + 7n, storageUsage: MASK_BYTES, codeHash: HOME_CODE }]);
  });

  it("the network names the code of home for each network: a code hash, the one contracts/home builds", () => {
    for (const net of ["mainnet", "testnet"] as const) {
      const code = NETWORKS[net].home_code;
      expect(code && codeHashHex(code), net).toMatch(/^[0-9a-f]{64}$/);
      expect(houseConfig(NETWORKS[net], JUDGE).homeCode).toBe(code);
    }
    expect(NETWORKS.mainnet.home_code).not.toBe(NETWORKS.testnet.home_code);
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
      expect(cfg.limits).toEqual({
        safeMax: BigInt(Number(n.limits.hand.safe_max) * 1000) * MILLI,
        depositMax: BigInt(Number(n.limits.hand.deposit_max) * 1000) * MILLI,
        houseMax: BigInt(Number(n.limits.house_max) * 1000) * MILLI,
      });
      expect(cfg.round.maskKeep).toBe(BigInt(Number(n.round.mask_keep) * 1000) * MILLI);
      expect(cfg).toMatchObject({ house: n.house, vault: n.vault, bounty: n.bounty, contracts: [n.bounty, ...n.older_bounty], masks: Object.values(n.masks), safeCode: n.safe_code, homeCode: n.home_code });
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
      const fresh = { nowNs: chain.now, height: chain.height, house: { amount: 3080n * MILLI, free: 3077n * MILLI }, masks: [], vault: null, round: null, safeCodes: [CODE], judge: JUDGE, blocking: null, nextId: "race-0002", last: null };
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
