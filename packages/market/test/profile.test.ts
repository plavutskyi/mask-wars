import { describe, expect, it } from "vitest";
import { LISTING, PRICE, listingPatch, listingProblems } from "../src/profile.ts";
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
    expect(LISTING.description).toMatch(/Testnet/);
    expect(LISTING.bio_markdown).toMatch(/`allow` means only that no signal/);
    expect(LISTING.bio_markdown).toMatch(/not charged/);
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
