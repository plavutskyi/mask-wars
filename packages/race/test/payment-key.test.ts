/**
 * The key that pays the people's minds on OutLayer (src/payment-key.ts): read by its owner and number from OutLayer's
 * public balance, never by the key, reported in dollars, and low means the owner's top-up step, never a transfer.
 */
import { describe, expect, it } from "vitest";
import { keyLow, keyRef, keyReport, readKeyBalance, TOPUP_USD, topUpStep } from "../src/payment-key.ts";

const API = "https://api.outlayer.example";

describe("the payment key of the people's minds", () => {
  it("is named by its owner and number; the secret part is never used", () => {
    expect(keyRef("maskwars.near:3:abcDEF123secret")).toEqual({ owner: "maskwars.near", nonce: 3 });
    expect(keyRef("not a key")).toBeNull();
    expect(keyRef("maskwars.near:x:secret")).toBeNull();
  });

  it("reads the public balance by owner and number, in dollars", async () => {
    const asked: string[] = [];
    const get = (async (url: string, init?: RequestInit) => {
      asked.push(url);
      expect(new Headers(init?.headers).get("x-payment-key")).toBeNull();
      return Response.json({ owner: "maskwars.near", nonce: 3, initial_balance: "1200000", spent: "950000", reserved: "0", available: "250000", last_used_at: "2026-11-12T18:40:00Z" });
    }) as unknown as typeof fetch;
    const b = await readKeyBalance(`${API}/`, { owner: "maskwars.near", nonce: 3 }, get);
    expect(asked).toEqual([`${API}/public/payment-keys/maskwars.near/3/balance`]);
    expect(b).toMatchObject({ initialUsd: 1.2, spentUsd: 0.95, availableUsd: 0.25, lastUsedAt: "2026-11-12T18:40:00Z" });
    expect(keyLow(b!)).toBe(true);
    const down = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await readKeyBalance(API, { owner: "maskwars.near", nonce: 9 }, down)).toBeNull();
  });

  it("reports what is left, and when it runs low the owner's step by hand", () => {
    const ref = { owner: "maskwars.near", nonce: 3 };
    const full = { ...ref, initialUsd: 1.2, spentUsd: 0.2, reservedUsd: 0, availableUsd: 1, lastUsedAt: null };
    expect(keyReport(ref, full)).toEqual({ lines: ["- people's minds: payment key maskwars.near:3 holds $1.00 of $1.20 (spent $0.20)"], low: false });
    const low = keyReport(ref, { ...full, spentUsd: 1.1, availableUsd: 0.1 });
    expect(low.low).toBe(true);
    // The key holds dollars of USDC, never NEAR: the top-up names the sum with --usd, as OutLayer's CLI takes it.
    expect(low.lines[0]).toContain("**Low**: top it up by hand: `outlayer login` as maskwars.near, then `outlayer keys topup 3 --usd 3` ($3 of USDC from maskwars.near");
    expect(TOPUP_USD).toBe(3);
    expect(topUpStep(ref)).not.toMatch(/\d NEAR\b/);
    expect(topUpStep(ref)).not.toMatch(/near (tokens )?send|transfer/);
    expect(keyReport(null, null)).toMatchObject({ low: true });
    expect(keyReport(ref, null).lines[0]).toContain("could not be read from OutLayer");
  });
});
