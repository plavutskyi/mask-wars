import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakePay } from "@maskwars/pay/fake";
import { catalogOf, NEAR_ASSET, OneClick, progressOf, quoteView, topUpRequest, type QuoteView } from "@maskwars/pay";
import { checkHire, hireRequest, type Job } from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("../../pay/test/fixtures/oneclick.json", import.meta.url), "utf8"));
const cat = catalogOf(fx.tokens)!;
const usdc = cat.chains.find((c) => c.id === "sol")!.coins.find((c) => c.symbol === "USDC")!;
const sol = cat.chains.find((c) => c.id === "sol")!.coins.find((c) => c.symbol === "SOL")!;
const job: Job = { text: "Attack my vault before launch", target: "vault.acme.near", team: "acme.near" };
const now = new Date("2026-11-08T09:10:00.000Z");

describe("where a job's money goes", () => {
  it("is the vault top-up of @maskwars/pay with the team's vault as receiver and refund address", () => {
    const { request, units } = hireRequest({ job, from: usdc, usd: 250, dry: false, now });
    expect(units).toBe(250_000_000n);
    expect(request).toEqual(topUpRequest({ account: "acme.near", from: usdc, amount: units, dry: false, now }));
    expect(request).toMatchObject({
      swapType: "FLEX_INPUT",
      depositType: "ORIGIN_CHAIN",
      destinationAsset: NEAR_ASSET,
      recipient: "acme.near",
      recipientType: "INTENTS",
      refundTo: "acme.near",
      refundType: "INTENTS",
    });
  });

  it("sends a coin that is not a dollar rounded up to four digits, never NEAR itself", () => {
    const { units } = hireRequest({ job, from: sol, usd: 250, dry: true, now });
    expect(units.toString()).toMatch(/^\d{4}0+$/);
    expect(() => hireRequest({ job, from: cat.near, usd: 250, dry: true, now })).toThrow();
  });
});

describe("a hire quote read back before its address shows", () => {
  async function quote(usd = 250, from = usdc): Promise<QuoteView> {
    const pay = fakePay({ tokens: fx.tokens, now: () => now.getTime() });
    const api = new OneClick({ fetch: pay.fetch });
    return quoteView(await api.quote(hireRequest({ job, from, usd, dry: false, now }).request));
  }
  const terms = (usd = 250, from = usdc) => ({ job, from, near: cat.near, usd });

  it("passes when it pays this job's team in NEAR for the dollars agreed", async () => {
    expect(checkHire(await quote(), terms())).toEqual({ ok: true });
    expect(checkHire(await quote(40, sol), terms(40, sol))).toEqual({ ok: true });
  });

  it("refuses another receiver, another refund address, another coin", async () => {
    const q = await quote();
    expect(checkHire({ ...q, recipient: "thief.near" }, terms()).ok).toBe(false);
    expect(checkHire({ ...q, refundTo: "thief.near" }, terms()).ok).toBe(false);
    expect(checkHire({ ...q, recipientType: "DESTINATION_CHAIN" }, terms()).ok).toBe(false);
    expect(checkHire({ ...q, destinationAsset: usdc.assetId }, terms()).ok).toBe(false);
    expect(checkHire({ ...q, originAsset: sol.assetId }, terms()).ok).toBe(false);
  });

  it("refuses asking the payer for more than they agreed, or promising far less NEAR", async () => {
    const q = await quote();
    expect(checkHire({ ...q, amountIn: "2500000000" }, terms())).toMatchObject({ ok: false });
    const less = ((BigInt(q.minAmountOut) * 80n) / 100n).toString();
    expect(checkHire({ ...q, amountOut: less, minAmountOut: ((BigInt(less) * 99n) / 100n).toString() }, terms())).toMatchObject({ ok: false, moved: true });
  });

  it("refuses a deposit floor above the amount the payer is told to send", async () => {
    const q = await quote();
    expect(checkHire({ ...q, minAmountIn: (BigInt(q.amountIn) + 1n).toString() }, terms())).toMatchObject({ ok: false });
    expect(checkHire({ ...q, minAmountIn: q.amountIn }, terms())).toEqual({ ok: true });
  });

  it("refuses a preview, a quote with no address, and a price that slid from the one shown", async () => {
    const q = await quote();
    expect(checkHire({ ...q, dry: true }, terms()).ok).toBe(false);
    expect(checkHire({ ...q, depositAddress: null }, terms()).ok).toBe(false);
    const seen = ((BigInt(q.amountOut) * 110n) / 100n).toString();
    expect(checkHire(q, { ...terms(), seen })).toMatchObject({ ok: false, moved: true });
  });

  it("follows the swap to the team's vault, as /wallet follows a top-up", async () => {
    let t = now.getTime();
    const pay = fakePay({ tokens: fx.tokens, stepMs: 1000, now: () => t });
    const api = new OneClick({ fetch: pay.fetch });
    const q = quoteView(await api.quote(hireRequest({ job, from: usdc, usd: 250, dry: false, now }).request));
    expect(progressOf(await api.status(q.depositAddress!)).stage).toBe("waiting");
    t += 5000;
    const done = progressOf(await api.status(q.depositAddress!));
    expect(done.stage).toBe("done");
    expect(pay.ledger.get("acme.near")?.get(NEAR_ASSET)).toBe(BigInt(q.amountOut));
  });
});
