import { describe, expect, it } from "vitest";
import { duration, formatEntry, formatJournal } from "../src/journal.ts";

describe("journal", () => {
  it("reads like the board", () => {
    expect(formatEntry({ attacker: "ONYX", attempt: 4, verdict: "held", atMs: 120_000 })).toBe("attempt 4: ×");
    expect(formatEntry({ attacker: "ONYX", attempt: 4, verdict: "held", atMs: 120_000 }, "uk")).toBe("спроба 4: ×");
    expect(formatEntry({ attacker: "ONYX", attempt: 5, verdict: "breach", atMs: 192_400 }, "uk")).toBe("спроба 5: злам за 3 хв 12 с");
    expect(formatEntry({ attacker: "ONYX", attempt: 5, verdict: "breach", atMs: 192_400 })).toBe("attempt 5: breach in 3m 12s");
    expect(duration(41_000, "uk")).toBe("41 с");
    expect(duration(3_725_000, "uk")).toBe("1 год 2 хв");
  });

  it("groups by attacker in order of first appearance", () => {
    const lines = formatJournal([
      { attacker: "NOVA", attempt: 1, verdict: "invalid", atMs: 1 },
      { attacker: "ONYX", attempt: 1, verdict: "held", atMs: 2 },
      { attacker: "NOVA", attempt: 2, verdict: "breach", atMs: 41_000 },
    ]);
    expect(lines).toEqual(["NOVA  attempt 1: ×, attempt 2: breach in 41s", "ONYX  attempt 1: ×"]);
  });
});
