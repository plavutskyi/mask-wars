import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakePay, type FakeMask } from "../src/fake.ts";
import { base64, catalogOf, INTENTS, Ledger, OneClick, progressOf, spendTransactions, spentOf, succeeded, topUpRequest, utf8, WNEAR, WNEAR_STORAGE } from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/oneclick.json", import.meta.url), "utf8"));
const NEAR = 10n ** 24n;
const FACTORY = "masks.maskwars.near";
const KIRA: FakeMask = { name: "kira", account: `kira.${FACTORY}`, owner: "kira.near", brain: (NEAR / 4n).toString(), fuel: NEAR.toString(), look: "crimson" };
const refuel = (name: string, amount: bigint) => ({ receiver: FACTORY, method: "refuel", args: { name }, amount, tgas: 30 });

describe("a NEAR wallet's vault spends its NEAR on a contract", () => {
  it("is four transactions: register on wrap.near, withdraw from NEAR Intents, unwrap, and the call with the NEAR", () => {
    const txs = spendTransactions("kira.near", refuel("kira", NEAR / 2n));
    expect(txs.map((t) => [t.receiverId, t.actions.map((a) => a.params.methodName)])).toEqual([
      [WNEAR, ["storage_deposit"]],
      [INTENTS, ["ft_withdraw"]],
      [WNEAR, ["near_withdraw"]],
      [FACTORY, ["refuel"]],
    ]);
    expect(txs[0]!.actions[0]!.params).toMatchObject({ args: { account_id: "kira.near", registration_only: true }, deposit: WNEAR_STORAGE.toString() });
    // The vault's wNEAR goes to the person's own account, never anywhere else, and only the last step reaches the call.
    expect(txs[1]!.actions[0]!.params).toMatchObject({ args: { token: WNEAR, receiver_id: "kira.near", amount: (NEAR / 2n).toString() }, deposit: "1" });
    expect(txs[2]!.actions[0]!.params).toMatchObject({ args: { amount: (NEAR / 2n).toString() }, deposit: "1" });
    expect(txs[3]!.actions[0]!.params).toMatchObject({ args: { name: "kira" }, deposit: (NEAR / 2n).toString(), gas: "30000000000000" });
  });

  it("refuses a passkey vault, which has no NEAR account to attach NEAR from, and nothing to spend", () => {
    expect(() => spendTransactions(`0x${"ab".repeat(20)}`, refuel("kira", NEAR))).toThrow(/passkey/);
    expect(() => spendTransactions("kira.near", refuel("kira", 0n))).toThrow();
  });

  it("reads the wallet's outcomes: where it stopped, or what the call returned", () => {
    const ok = (v: unknown, hash = "h") => ({ status: { SuccessValue: base64(utf8(JSON.stringify(v))) }, transaction: { hash } });
    const fail = { status: { Failure: { ActionError: {} } }, transaction: { hash: "f" } };
    expect(spentOf([ok(null), ok("5"), ok(null), ok({ brain: "7" }, "last")])).toEqual({ ok: true, hash: "last", value: { brain: "7" } });
    // The withdrawal bounced: NEAR Intents says "0" moved and the wNEAR is back in the vault.
    expect(spentOf([ok(null), ok("0", "w"), ok(null), ok({})], 5n)).toEqual({ ok: false, step: 2, hash: "w", lost: false });
    expect(spentOf([ok(null), ok("5"), ok(null), ok({}, "last")], 5n)).toMatchObject({ ok: true, hash: "last" });
    // A wallet that reports only "SuccessValue" gives no amount to check: it is not taken for a bounce.
    const bare = { status: "SuccessValue", transaction: { hash: "x" } };
    expect(spentOf([bare, bare, bare, bare], 5n)).toMatchObject({ ok: true });
    expect(spentOf([ok(null), fail])).toEqual({ ok: false, step: 2, hash: "f", lost: false });
    // No answer from step 4 on: lost, not failed; the chain says whether the mind took it.
    expect(spentOf([ok(null), ok("5"), ok(null)])).toEqual({ ok: false, step: 4, hash: null, lost: true });
    expect(spentOf([])).toMatchObject({ ok: false, step: 1, lost: true });
    // A status the wallet did not wait for is not a failure: the chain decides.
    expect(spentOf([{ status: "Started" }, ok("5")], 5n)).toMatchObject({ ok: false, step: 1, lost: true });
    expect(spentOf([{ transaction: { hash: "t" } }])).toMatchObject({ ok: false, step: 1, lost: true, hash: "t" });
    expect([succeeded(ok(null)), succeeded(fail), succeeded({ status: "SuccessValue" }), succeeded({ status: "Failure" }), succeeded(undefined), succeeded({ status: {} })]).toEqual([true, false, true, false, false, false]);
  });

  it("fuels a mask from the vault in the fake, and stops at the step a real chain would", async () => {
    const pay = fakePay({ tokens: fx.tokens, masks: [KIRA] });
    const ledger = new Ledger({ fetch: pay.fetch });
    pay.ledger.set("kira.near", new Map([["nep141:wrap.near", 2n * NEAR]]));
    expect(await ledger.call<FakeMask[]>(FACTORY, "masks_of", { owner: "kira.near" })).toEqual([KIRA]);
    expect(await ledger.call<FakeMask[]>(FACTORY, "masks_of", { owner: "someone.near" })).toEqual([]);

    const done = spentOf(pay.send("kira.near", spendTransactions("kira.near", refuel("kira", NEAR))) as never, NEAR);
    expect(done).toMatchObject({ ok: true, value: { name: "kira", brain: (NEAR + NEAR / 4n).toString() } });
    expect(pay.ledger.get("kira.near")!.get("nep141:wrap.near")).toBe(NEAR);
    expect((await ledger.call<FakeMask>(FACTORY, "get_mask", { name: "kira" })).fuel).toBe((2n * NEAR).toString());

    // More than the vault holds: NEAR Intents refuses the withdrawal and nothing after it is sent.
    const short = pay.send("kira.near", spendTransactions("kira.near", refuel("kira", 5n * NEAR)));
    expect(short).toHaveLength(2);
    expect(spentOf(short as never)).toMatchObject({ ok: false, step: 2 });
    // Below the factory's least refuel: the NEAR stops on the person's own account, out of the vault.
    expect(spentOf(pay.send("kira.near", spendTransactions("kira.near", refuel("kira", NEAR / 20n))) as never)).toMatchObject({ ok: false, step: 4 });
  });
});

describe("every way a top-up ends can be walked in the fake, by its cents", () => {
  const walk = async (usd: number) => {
    let t = Date.parse("2026-11-11T09:00:00.000Z");
    const pay = fakePay({ tokens: fx.tokens, stepMs: 1000, now: () => t });
    const api = new OneClick({ fetch: pay.fetch });
    const cat = catalogOf(await api.tokens())!;
    const usdc = cat.chains[0]!.coins[0]!;
    const q = await api.quote(topUpRequest({ account: fx.account, from: usdc, amount: BigInt(Math.round(usd * 1e6)), dry: false, now: new Date(t) }));
    const seen = [];
    for (let i = 0; i < 6; i++) {
      seen.push(progressOf(await api.status(q.quote.depositAddress!)));
      t += 1000;
    }
    return { stages: [...new Set(seen.map((p) => p.stage))], last: seen.at(-1)!, held: pay.ledger.get(fx.account) };
  };

  it("goes through by default", async () => {
    const r = await walk(2);
    expect(r.stages).toEqual(["waiting", "seen", "moving", "done"]);
    expect(r.held?.get("nep141:wrap.near")).toBeGreaterThan(0n);
  });

  it("is refunded to the vault at .13, fails at .66, arrives short at .07", async () => {
    const refunded = await walk(2.13);
    expect(refunded.stages).toEqual(["waiting", "seen", "moving", "refunded"]);
    expect(refunded.last.refunded).toBe("2130000");
    expect([...refunded.held!.values()]).toEqual([2_130_000n]);

    const failed = await walk(2.66);
    expect(failed.stages).toEqual(["waiting", "seen", "moving", "failed"]);
    expect(failed.held).toBeUndefined();

    const short = await walk(2.07);
    expect(short.stages).toEqual(["waiting", "seen", "short"]);
    expect(short.last.deposited).toBe(((2_070_000n * 4n) / 5n).toString());
  });
});
