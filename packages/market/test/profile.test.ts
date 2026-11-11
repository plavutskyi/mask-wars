import { describe, expect, it } from "vitest";
import { LISTING, PRICE, atomicUsdc, listingPatch, listingProblems } from "../src/profile.ts";
import { violations } from "./schema.ts";

describe("the MASK WARS listing", () => {
  it("passes every rule the marketplace states", () => {
    expect(listingProblems()).toEqual([]);
    expect(LISTING.description.length).toBeLessThanOrEqual(200);
    expect(LISTING.name.length).toBeLessThanOrEqual(80);
  });

  it("is a PATCH body and a pricing plan the API takes, field for field", () => {
    expect(violations("PatchAgentRequest", listingPatch(), { strict: true })).toEqual([]);
    expect(violations("CreatePricingPlanRequest", PRICE, { strict: true })).toEqual([]);
    expect(listingPatch()).not.toHaveProperty("handle");
  });

  it("says plainly what it reads and where", () => {
    expect(LISTING.description).toMatch(/NEAR mainnet/);
    expect(LISTING.tags).toContain("mainnet");
    expect(`${LISTING.description}\n${LISTING.bio_markdown}\n${JSON.stringify(LISTING.input_schema)}\n${PRICE.description}`).not.toMatch(/testnet/i);
    expect(LISTING.bio_markdown).toMatch(/two independent RPC providers/i);
    expect(LISTING.bio_markdown).toMatch(/`allow` means only that no signal/);
    expect(LISTING.bio_markdown).toMatch(/not charged/);
  });

  it("the price is what the 402 restates in atomic USDC", () => {
    expect(PRICE).toMatchObject({ model: "per_call", price_amount: "0.10" });
    expect(atomicUsdc(PRICE.price_amount)).toBe("100000");
    expect(atomicUsdc("0.5000")).toBe("500000");
    expect(atomicUsdc("12")).toBe("12000000");
    expect(atomicUsdc("0.000001")).toBe("1");
    expect(() => atomicUsdc("0.0000001")).toThrow(/not a USDC amount/);
    expect(() => atomicUsdc("free")).toThrow(/not a USDC amount/);
  });

  it("catches what the marketplace would refuse", () => {
    const bad = { ...LISTING, handle: "Mask_Wars", description: "x".repeat(201), tags: [...LISTING.tags, "a", "b"] };
    const problems = listingProblems(bad, { ...PRICE, price_amount: "0.1234567" });
    expect(problems.join("\n")).toMatch(/handle Mask_Wars/);
    expect(problems.join("\n")).toMatch(/description: 1 to 200/);
    expect(problems.join("\n")).toMatch(/tags: at most 10/);
    expect(problems.join("\n")).toMatch(/price 0.1234567/);
    expect(listingProblems({ ...LISTING, handle: "ab--cd" })).toHaveLength(1);
    expect(listingProblems({ ...LISTING, handle: "maskwars-" })).toHaveLength(1);
  });
});
