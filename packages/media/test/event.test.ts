import { describe, expect, it } from "vitest";
import { EVENT_TYPES, parseEvent } from "../src/index.ts";
import { examples } from "./helpers.ts";

const ex = examples();

describe("media event v1", () => {
  it("reads every example, and every example is marked SIMULATED", () => {
    const types = new Set<string>();
    for (const [name, e] of Object.entries(ex)) {
      const parsed = parseEvent(e);
      expect(parsed.source, name).toBe("SIMULATED");
      types.add(parsed.type);
    }
    expect([...types].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("refuses an unknown type, a wrong version and a missing source", () => {
    expect(() => parseEvent({ ...ex.win_card, type: "jackpot" })).toThrow();
    expect(() => parseEvent({ ...ex.win_card, v: 2 })).toThrow();
    const { source: _s, ...noSource } = ex.win_card;
    expect(() => parseEvent(noSource)).toThrow(/source/);
  });

  it("uses the core's ids", () => {
    expect(() => parseEvent({ ...ex.win_card, fightId: "fight-12" })).toThrow(/fight id/);
    expect(() => parseEvent({ ...ex.win_card, mask: "Ronin" })).toThrow(/mask id/);
  });

  it("a whole race is not an event: the old fight clip type is gone", () => {
    expect(() => parseEvent({ ...ex.win_card, type: "fight_clip" })).toThrow();
  });

  it("money is minimal USDC units as a string, and a win pays at least the stake", () => {
    expect(() => parseEvent({ ...ex.win_card, stake: 5 })).toThrow();
    expect(() => parseEvent({ ...ex.win_card, stake: "5.00" })).toThrow();
    expect(() => parseEvent({ ...ex.win_card, payout: "1000000" })).toThrow(/at least the stake/);
  });

  it("a lose card's line calls the person by name", () => {
    expect(() => parseEvent({ ...ex.lose_card, line: "You backed the loud one again." })).toThrow(/by name/);
  });

  it("The Card has exactly five picks", () => {
    expect(() => parseEvent({ ...ex.card_grid, picks: ex.card_grid.picks.slice(0, 4) })).toThrow();
  });

  it("a line carries no link", () => {
    expect(() => parseEvent({ ...ex.unmask, thought: "see https://x.co/abc" })).toThrow(/link/);
  });
});
