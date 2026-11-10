import { describe, expect, it } from "vitest";
import { WIN_CARD_MIN_MULTIPLE, fromFightEvent, momentKey, parseEvent, winMultiple } from "../src/index.ts";
import { examples } from "./helpers.ts";

const ex = examples();
const win = (payout: string) => ({ ...ex.win_card, stake: "5000000", payout });

describe("the ×3 threshold", () => {
  it("is ×3", () => expect(WIN_CARD_MIN_MULTIPLE).toBe(3));

  it("a win under ×3 gives no card and no draft", () => {
    expect(fromFightEvent(win("14999999"))).toEqual([]);
    expect(fromFightEvent(ex.win_card_small)).toEqual([]);
  });

  it("a win at exactly ×3 gives a card and a draft", () => {
    const jobs = fromFightEvent(win("15000000"));
    expect(jobs.map((j) => j.kind)).toEqual(["card", "draft"]);
  });

  it("the multiple rounds down: ×2.99 is not ×3", () => {
    expect(winMultiple(parseEvent(win("14950000")) as any)).toBe(2.9);
  });
});

describe("fromFightEvent", () => {
  it("gives each event its jobs", () => {
    const kinds = (e: unknown) => fromFightEvent(e).map((j) => (j.kind === "card" ? `card:${j.card}` : j.kind));
    expect(kinds(ex.win_card)).toEqual(["card:win", "draft"]);
    expect(kinds(ex.lose_card)).toEqual(["card:lose", "draft"]);
    expect(kinds(ex.unmask)).toEqual(["card:unmask", "draft"]);
    expect(kinds(ex.mask_birth)).toEqual(["card:birth", "draft"]);
    expect(kinds(ex.seal_broken)).toEqual(["card:seal", "draft"]);
    expect(kinds(ex.card_grid)).toEqual(["draft"]);
  });

  it("the draft points at its media and keeps the event's source", () => {
    const d = fromFightEvent(ex.seal_broken).find((j) => j.kind === "draft");
    expect(d).toMatchObject({ media: `${momentKey(parseEvent(ex.seal_broken))}:card`, source: "SIMULATED" });
    expect(fromFightEvent(ex.card_grid).find((j) => j.kind === "draft")).toMatchObject({ media: null });
  });

  it("the same moment gives the same key, whatever the handle's @ or case", () => {
    expect(momentKey(parseEvent(ex.win_card))).toBe(momentKey(parseEvent({ ...ex.win_card, handle: "@Kaito_Trades", at: "2026-11-09T15:21:00Z" })));
  });

  it("throws on an event it cannot read", () => {
    expect(() => fromFightEvent({ v: 1, type: "win_card" })).toThrow(/bad media event/);
  });
});
