import { describe, expect, it } from "vitest";
import {
  applyResult,
  callPercentBp,
  ELO,
  emptyCalls,
  emptyRating,
  modelIndex,
  ratingView,
  rateFight,
  recordCall,
  weightClassOf,
  YOCTO_PER_NEAR,
} from "../src/index.ts";

describe("rating", () => {
  it("moves Elo with K 48 while provisional, 32 after, symmetric for equal ratings", () => {
    const [w, l] = rateFight(emptyRating("onyx", "market-duel-v1"), emptyRating("nova", "market-duel-v1"));
    expect(w.rating).toBe(1224);
    expect(l.rating).toBe(1176);
    let row = emptyRating("onyx", "market-duel-v1");
    for (let i = 0; i < ELO.provisionalGames; i++) row = applyResult(row, row.rating, 1);
    const before = row.rating;
    expect(applyResult(row, before, 1).rating - before).toBeCloseTo(16, 10);
    expect(ratingView(row).provisional).toBe(false);
  });

  it("keeps disciplines apart and does not rate a tie", () => {
    expect(() => rateFight(emptyRating("a", "market-duel-v1"), emptyRating("b", "liars-dice"))).toThrow();
    expect(() => applyResult(emptyRating("a", "x"), 1200, 0.5 as 0)).toThrow(/VOID/);
  });

  it("narrows the interval with games", () => {
    const fresh = ratingView(emptyRating("a", "x"));
    expect(fresh.high - fresh.rating).toBe(686);
    let row = emptyRating("a", "x");
    for (let i = 0; i < 100; i++) row = applyResult(row, row.rating, (i % 2) as 0 | 1);
    const v = ratingView(row);
    expect(v.high - v.low).toBeLessThan(150);
  });

  it("counts Call% in basis points", () => {
    let c = emptyCalls();
    expect(callPercentBp(c)).toBeNull();
    c = recordCall(recordCall(recordCall(c, true), false), false);
    expect(callPercentBp(c)).toBe(3333);
  });

  it("ranks the Model Index of one discipline", () => {
    const [glm, claude] = rateFight(emptyRating("glm", "market-duel-v1"), emptyRating("claude", "market-duel-v1"));
    const idx = modelIndex([claude, glm, emptyRating("qwen", "market-duel-v1"), emptyRating("codex", "liars-dice")], "market-duel-v1");
    expect(idx.map((e) => [e.rank, e.subject])).toEqual([[1, "glm"], [2, "qwen"], [3, "claude"]]);
  });

  it("puts a vault in the heaviest class it reaches", () => {
    const classes = [
      { name: "light", minYocto: 1n * YOCTO_PER_NEAR },
      { name: "heavy", minYocto: 100n * YOCTO_PER_NEAR },
      { name: "middle", minYocto: 10n * YOCTO_PER_NEAR },
    ];
    expect(weightClassOf(0n, classes)).toBeNull();
    expect(weightClassOf(YOCTO_PER_NEAR, classes)).toBe("light");
    expect(weightClassOf(10n * YOCTO_PER_NEAR - 1n, classes)).toBe("light");
    expect(weightClassOf(10n * YOCTO_PER_NEAR, classes)).toBe("middle");
    expect(weightClassOf(5_000n * YOCTO_PER_NEAR, classes)).toBe("heavy");
  });
});
