/**
 * The house's day with guests (src/house.ts with src/house-guests.ts): the vault is made with the arena's masks and
 * today's guests beside them, the round lists exactly the vault's masks, each guest adds its storage to the deposit,
 * and a guest's winnings never go home to the house.
 */
import { describe, expect, it } from "vitest";
import { guestsOf, openDeposit, planDay, readHouse, roundArgs, runDay, stepText, stepTx, vaultFault, wasmInfo } from "../src/house.ts";
import { BOUNTY, CFG, FakeNear, HOUSE, KEY, MILLI, NOVA, ONYX, ORACLE, VAULT, WASM } from "./house-chain.ts";

const KIRA = "kira.masks.maskwars.near";
const AGENT = "agent.near";
const run = (chain: FakeNear, guests: readonly string[]) => runDay({ chain, config: CFG, key: KEY, wasm: WASM, guests, settleMs: 0, sleep: async () => {} });

describe("the house's round with guests", () => {
  it("makes the vault with the arena's masks and the guests, and opens the round for exactly them, the deposit with their storage", async () => {
    const chain = FakeNear.after("drained");
    const day = await run(chain, [KIRA, AGENT]);
    expect(day).toMatchObject({ kind: "opened", round: { id: "race-0003", masks: [NOVA, ONYX, ORACLE, KIRA, AGENT] } });
    expect(chain.steps).toEqual(["retire", "create", "open"]);
    const [, create, open] = chain.landed as [FakeNear["landed"][0], FakeNear["landed"][0], FakeNear["landed"][0]];
    expect(create.actions[3]).toMatchObject({ method: "new", args: { owner: VAULT, masks: [NOVA, ONYX, ORACLE, KIRA, AGENT], arbiter: BOUNTY, team: HOUSE } });
    // 0.25 NEAR, and 0.051 for each guest: the 4000 bytes the bounty contract keeps for every mask of a round, the judge's
    // fee of its first claim and its account id in the round.
    expect(open).toMatchObject({ receiver: BOUNTY, actions: [{ method: "open_safe", deposit: 352n * MILLI, args: { masks: [NOVA, ONYX, ORACLE, KIRA, AGENT] } }] });
    expect(chain.house!.amount).toBe((900n + 1680n - 1930n - 352n) * MILLI);
  });

  it("lets in no guest twice, none of the arena's own, and no more than the network's three (mainnet: people's masks only)", async () => {
    const s = await readHouse(FakeNear.after("drained"), CFG);
    const many = [KIRA, NOVA, KIRA, "a.near", "b.near", "c.near", "d.near", "e.near"];
    const p = planDay(s, CFG, { wasm: wasmInfo(WASM), guests: many });
    expect(p).toMatchObject({ kind: "steps", steps: [{ kind: "retire" }, { kind: "create", guests: [KIRA, "a.near", "b.near"] }, { kind: "open" }] });
    const open = (p as unknown as { steps: { kind: string; masks?: string[] }[] }).steps[2]!;
    expect(open.masks).toEqual([NOVA, ONYX, ORACLE, KIRA, "a.near", "b.near"]);
    expect(openDeposit(CFG, open.masks)).toBe(403n * MILLI);
  });

  it("a day without guests is the day it always was", async () => {
    const s = await readHouse(FakeNear.after("drained"), CFG);
    const p = planDay(s, CFG, { wasm: wasmInfo(WASM) });
    expect(p).toMatchObject({ kind: "steps", steps: [{ kind: "retire" }, { kind: "create" }, { kind: "open", id: "race-0003" }] });
    expect(stepTx({ kind: "open", id: "race-0003" }, CFG).actions[0]).toMatchObject({ deposit: 250n * MILLI });
    expect(roundArgs(CFG, "race-0003").masks).toEqual([NOVA, ONYX, ORACLE]);
    expect(stepText({ kind: "open", id: "race-0003" }, CFG)).toBe(`open_safe: round race-0003 on ${VAULT} with a deposit of 0.25 NEAR`);
  });

  it("a vault an earlier run made with today's guests takes its round as it is, with their deposit", async () => {
    const chain = new FakeNear();
    chain.house = { amount: 900n * MILLI, storage: 300 };
    chain.vault = { ...chain.newVault(1930n * MILLI, WASM), masks: [NOVA, ONYX, ORACLE, KIRA] };
    const day = await run(chain, [KIRA]);
    expect(chain.steps).toEqual(["open"]);
    expect(day).toMatchObject({ kind: "opened", round: { masks: [NOVA, ONYX, ORACLE, KIRA] } });
    expect(chain.landed[0]).toMatchObject({ actions: [{ deposit: openDeposit(CFG, [NOVA, ONYX, ORACLE, KIRA]) }] });
  });

  it("a vault made for other guests retires and is made again with today's: nobody unchecked plays this slot", async () => {
    const chain = new FakeNear();
    chain.house = { amount: 900n * MILLI, storage: 300 };
    chain.vault = { ...chain.newVault(1930n * MILLI, WASM), masks: [NOVA, ONYX, ORACLE, KIRA] };
    const day = await run(chain, [AGENT]);
    expect(chain.steps).toEqual(["retire", "create", "open"]);
    expect(day).toMatchObject({ kind: "opened", round: { masks: [NOVA, ONYX, ORACLE, AGENT] } });
  });

  it("a vault without one of the arena's masks, or with too many guests, cannot take a round", () => {
    const chain = new FakeNear();
    const v = (masks: string[]) => ({ ...chain.newVault(1930n * MILLI, WASM), codeHash: CFG.safeCode!, available: 280n * MILLI, masks });
    const read = (masks: string[]) => {
      const raw = v(masks);
      return { amount: raw.amount, codeHash: raw.codeHash, keys: 0, safe: { owner: VAULT, team: HOUSE, arbiter: BOUNTY, masks, available: 280n * MILLI, lock: null } };
    };
    expect(vaultFault(read([NOVA, ONYX, ORACLE, KIRA]), CFG)).toBeNull();
    expect(vaultFault(read([NOVA, ONYX, KIRA]), CFG)).toBe("its masks are not the round's");
    expect(vaultFault(read([NOVA, ONYX, ORACLE, KIRA, KIRA]), CFG)).toBe("its masks are not the round's");
    expect(vaultFault(read([NOVA, ONYX, ORACLE, "a", "b", "c", "d"]), CFG)).toBe("it lets in 4 guests, more than 3");
    expect(guestsOf([NOVA, KIRA, ONYX], CFG)).toEqual([KIRA]);
  });

  it("guests never cost the day its round: the house pays for the guests it can, the last of the list drops out first", async () => {
    // After retire the house holds 1.68 + 0.6 free: the round itself (1.93 + 0.25 + 0.1) and not a guest more.
    const bare = FakeNear.after("drained");
    bare.house = { amount: 600n * MILLI + 300n * 10n ** 19n, storage: 300 };
    const logs: string[] = [];
    const day = await runDay({ chain: bare, config: CFG, key: KEY, wasm: WASM, guests: [KIRA, AGENT, "c.near"], settleMs: 0, sleep: async () => {}, log: (l) => logs.push(l) });
    expect(day).toMatchObject({ kind: "opened", round: { masks: [NOVA, ONYX, ORACLE] } });
    expect(bare.steps).toEqual(["retire", "create", "open"]);
    expect(bare.landed[2]).toMatchObject({ actions: [{ method: "open_safe", deposit: 250n * MILLI }] });
    expect(logs).toContain(`the house pays for 0 of today's 3 guest(s): ${KIRA}, ${AGENT}, c.near wait for another day`);

    // 0.11 NEAR more pays for two guests' 0.051 each: the first two of the list play, the third waits.
    const two = FakeNear.after("drained");
    two.house = { amount: 710n * MILLI + 300n * 10n ** 19n, storage: 300 };
    const s = await readHouse(two, CFG);
    expect(planDay(s, CFG, { wasm: wasmInfo(WASM), guests: [KIRA, AGENT, "c.near"] })).toEqual({
      kind: "steps",
      steps: [{ kind: "retire" }, { kind: "create", guests: [KIRA, AGENT] }, { kind: "open", id: "race-0003", masks: [NOVA, ONYX, ORACLE, KIRA, AGENT] }],
      note: `the house pays for 2 of today's 3 guest(s): c.near waits for another day`,
    });
    expect(await run(two, [KIRA, AGENT, "c.near"])).toMatchObject({ kind: "opened", round: { masks: [NOVA, ONYX, ORACLE, KIRA, AGENT] } });
    expect(two.landed[2]).toMatchObject({ actions: [{ deposit: 352n * MILLI }] });
  });

  it("a day is skipped only when the round itself cannot be paid, whoever wanted to be a guest", async () => {
    const chain = FakeNear.after("drained");
    chain.house = { amount: 599n * MILLI + 300n * 10n ** 19n, storage: 300 };
    const day = await run(chain, [KIRA, AGENT, "c.near"]);
    expect(day).toMatchObject({ kind: "skipped" });
    expect("why" in day && day.why).toBe("the house holds 2.279 NEAR free: the round needs 2.28 NEAR");
    expect(chain.steps).toEqual(["retire"]);
  });

  it("a vault waiting with guests the house can no longer pay for goes back and is made again with those it can", async () => {
    const chain = new FakeNear();
    // The vault holds 1.93, the house 0.42 free: not the 0.25 + 0.102 + 0.1 the vault's two guests need. Once the vault
    // is home the house holds 2.35: the round and one guest, the first of the list.
    chain.house = { amount: 420n * MILLI + 300n * 10n ** 19n, storage: 300 };
    chain.vault = { ...chain.newVault(1930n * MILLI, WASM), masks: [NOVA, ONYX, ORACLE, KIRA, AGENT] };
    const day = await run(chain, [KIRA, AGENT]);
    expect(chain.steps).toEqual(["retire", "create", "open"]);
    expect(day).toMatchObject({ kind: "opened", round: { masks: [NOVA, ONYX, ORACLE, KIRA] } });
  });

  it("a vault this run made opens on the deposit alone: the gas the house kept already paid for making it", async () => {
    const chain = new FakeNear();
    chain.house = { amount: 260n * MILLI + 300n * 10n ** 19n, storage: 300 };
    chain.vault = { ...chain.newVault(1930n * MILLI, WASM), masks: [NOVA, ONYX, ORACLE] };
    const s = await readHouse(chain, CFG);
    expect(planDay(s, CFG, { wasm: wasmInfo(WASM), guests: [] })).toEqual({ kind: "skip", why: "the house holds 0.26 NEAR free: the round needs 0.35 NEAR" });
    expect(planDay(s, CFG, { wasm: wasmInfo(WASM), guests: [], made: true })).toEqual({ kind: "steps", steps: [{ kind: "open", id: "race-0002" }] });
  });

  it("an empty guest list is today's word too: a vault left with yesterday's guests retires, in the run as in --plan", async () => {
    const left = () => {
      const chain = new FakeNear();
      chain.house = { amount: 900n * MILLI, storage: 300 };
      chain.vault = { ...chain.newVault(1930n * MILLI, WASM), masks: [NOVA, ONYX, ORACLE, KIRA] };
      return chain;
    };
    const plan = planDay(await readHouse(left(), CFG), CFG, { wasm: wasmInfo(WASM), guests: [] });
    expect(plan).toMatchObject({ kind: "steps", steps: [{ kind: "retire" }, { kind: "create" }, { kind: "open" }] });
    expect((plan as { note?: string }).note).toContain(`its guests are not today's (none)`);
    const chain = left();
    const day = await run(chain, []);
    expect(chain.steps).toEqual(["retire", "create", "open"]);
    expect(day).toMatchObject({ kind: "opened", round: { masks: [NOVA, ONYX, ORACLE] } });
    // Without a word on today's guests (an owner's script that read none), a vault on chain keeps its own.
    const kept = left();
    expect(await runDay({ chain: kept, config: CFG, key: KEY, wasm: WASM, settleMs: 0, sleep: async () => {} })).toMatchObject({ kind: "opened", round: { masks: [NOVA, ONYX, ORACLE, KIRA] } });
    expect(kept.steps).toEqual(["open"]);
  });

  it("through the house contract, whose terms pin the round's masks, the plan seats no guest and says why", async () => {
    const chain = FakeNear.after("drained");
    const s = await readHouse(chain, CFG);
    const p = planDay({ ...s, contract: { lastRound: 2, lastSlotNs: 0n, madeSlotNs: 0n } }, CFG, { wasm: wasmInfo(WASM), guests: [KIRA] });
    expect(p).toMatchObject({ kind: "steps", steps: [{ kind: "retire" }, { kind: "create" }, { kind: "open" }] });
    const steps = (p as unknown as { steps: { kind: string; guests?: string[]; masks?: string[] }[]; note?: string }).steps;
    expect(steps[1]!.guests).toBeUndefined();
    expect(steps[2]!.masks).toBeUndefined();
    expect((p as { note?: string }).note).toContain(`the house contract pins the round's masks: today's guest(s) ${KIRA} wait until its terms take guests`);
  });

  it("a guest's winnings stay with the guest: home() is called only on the arena's own masks", async () => {
    const chain = FakeNear.after("drained").mask(NOVA, 500n * MILLI).mask(KIRA, 900n * MILLI);
    const s = await readHouse(chain, CFG);
    const p = planDay(s, CFG, { wasm: wasmInfo(WASM), guests: [KIRA] });
    const homes = (p as unknown as { steps: { kind: string; mask?: string }[] }).steps.filter((x) => x.kind === "home").map((x) => x.mask);
    expect(homes).toEqual([NOVA]);
  });
});
