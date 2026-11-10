import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CoreError, effectivePrimaries, lastCallPhase, marketDuel, samePrimaryLoser, scoreBp, type DuelMove } from "../src/index.ts";

const m = (primary: string, backup: string, call: string): DuelMove => marketDuel.parseMove({ primary, backup, call });

describe("market duel", () => {
  it("parses moves from the basket only, backup ≠ primary", () => {
    expect(m("BTC", "ETH", "BTC")).toEqual({ primary: "BTC", backup: "ETH", call: "BTC" });
    expect(() => m("DOGE", "ETH", "BTC")).toThrow(CoreError);
    expect(() => m("BTC", "BTC", "ETH")).toThrow(/backup/);
    expect(() => marketDuel.parseMove(null)).toThrow(CoreError);
  });

  it("gives the backup to the side named by the low bit of sha256(fight_id)[0]", () => {
    for (let n = 1; n < 50; n++) {
      const id = `f-0-${n}`;
      const bit = createHash("sha256").update(id).digest()[0]! & 1;
      expect(samePrimaryLoser(id)).toBe(bit);
      const eff = effectivePrimaries(id, [m("SOL", "BTC", "ETH"), m("SOL", "ZEC", "ETH")]);
      expect(eff).toEqual(bit === 0 ? ["BTC", "SOL"] : ["SOL", "ZEC"]);
    }
    expect(effectivePrimaries("f-0-1", [m("SOL", "BTC", "ETH"), m("ETH", "SOL", "ETH")])).toEqual(["SOL", "ETH"]);
  });

  it("scores floor((final − start)·10000/start) toward minus infinity, +25 for CALLED IT", () => {
    expect(scoreBp(10_000_000n, 10_000_000n, false)).toBe(0n);
    expect(scoreBp(10_000_000n, 10_000_999n, false)).toBe(0n);
    expect(scoreBp(10_000_000n, 10_001_000n, true)).toBe(26n);
    expect(scoreBp(10_000_000n, 9_999_999n, false)).toBe(-1n);
    expect(scoreBp(10_000_000n, 9_998_999n, false)).toBe(-2n);
    expect(scoreBp(10_000_000n, 0n, false)).toBe(-10_000n);
    expect(() => scoreBp(0n, 1n, false)).toThrow(CoreError);
  });

  it("calls CALLED IT against the rival's effective primary", () => {
    // f-0-1: find who takes the backup and build the case around it
    const id = "f-0-1";
    const loser = samePrimaryLoser(id);
    const moves: [DuelMove, DuelMove] = [m("SOL", "BTC", "ZEC"), m("SOL", "ZEC", "BTC")];
    const s = marketDuel.start(id, moves);
    if (loser === 0) expect(s.calledIt).toEqual([false, true]); // left enters BTC; right called BTC
    else expect(s.calledIt).toEqual([true, false]); // right enters ZEC; left called ZEC
  });

  it("allows one ROTATE, one call a minute at 1:00–4:59, to another coin", () => {
    let s = marketDuel.start("f-0-3", [m("BTC", "ETH", "SOL"), m("SOL", "NEAR", "BTC")]);
    expect(() => marketDuel.act(s, 0, { kind: "HOLD" }, 30_000)).toThrow(/1:00/);
    expect(() => marketDuel.act(s, 0, { kind: "HOLD" }, 300_000)).toThrow(/1:00/);
    s = marketDuel.act(s, 0, { kind: "HOLD" }, 60_000);
    expect(() => marketDuel.act(s, 0, { kind: "HOLD" }, 119_999)).toThrow(/already/);
    expect(() => marketDuel.act(s, 0, { kind: "ROTATE", to: "BTC" }, 120_000)).toThrow(/another coin/);
    s = marketDuel.act(s, 0, { kind: "ROTATE", to: "ZEC" }, 120_000);
    expect(s.holding).toEqual(["ZEC", "SOL"]);
    expect(s.entry).toEqual(["BTC", "SOL"]);
    expect(() => marketDuel.act(s, 0, { kind: "ROTATE", to: "ETH" }, 180_000)).toThrow(/once/);
    s = marketDuel.act(s, 1, { kind: "ROTATE", to: "BTC" }, 240_000);
    expect(s.holding).toEqual(["ZEC", "BTC"]);
  });

  it("judges the bigger score, tie is null", () => {
    const s = marketDuel.start("f-0-3", [m("BTC", "ETH", "NEAR"), m("SOL", "NEAR", "ZEC")]);
    const j = marketDuel.judge(s, { startUsdc: [10_000_000n, 10_000_000n], finalUsdc: [10_010_000n, 10_020_000n] });
    expect(j).toEqual({ winner: 1, scores: [10n, 20n] });
    const tie = marketDuel.judge(s, { startUsdc: [10_000_000n, 10_000_000n], finalUsdc: [9_990_000n, 9_990_000n] });
    expect(tie.winner).toBeNull();
  });

  it("opens LAST CALL at 2:30, seals the last 30 s, closes at 3:30", () => {
    expect(lastCallPhase(149_999)).toBe("before");
    expect(lastCallPhase(150_000)).toBe("open");
    expect(lastCallPhase(180_000)).toBe("sealed");
    expect(lastCallPhase(210_000)).toBe("closed");
  });
});
