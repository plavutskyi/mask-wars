import { describe, expect, it } from "vitest";
import {
  MinuteProposal,
  SealProposal,
  checkMinute,
  defaultMinute,
  defaultSeal,
  extractJson,
  readMinute,
  readSeal,
  type MinuteContext,
} from "../src/decision.ts";
import { MANNERS, MASKS } from "../src/masks.ts";
import { MARKET } from "./fixtures.ts";

const minute = (over: Partial<MinuteContext> = {}): MinuteContext => ({
  mask: "nova",
  rival: "onyx",
  market: MARKET,
  holding: "BTC",
  rivalHolding: "ZEC",
  rotated: false,
  lead: 0,
  minute: 1,
  ...over,
});

describe("schemas", () => {
  it("accepts a well-formed seal and rejects extra keys or unknown coins", () => {
    expect(SealProposal.safeParse({ primary: "SOL", backup: "ETH", call: "ZEC" }).success).toBe(true);
    expect(SealProposal.safeParse({ primary: "SOL", backup: "ETH", call: "ZEC", note: "hi" }).success).toBe(false);
    expect(SealProposal.safeParse({ primary: "DOGE", backup: "ETH", call: "ZEC" }).success).toBe(false);
    expect(SealProposal.safeParse({ primary: "SOL", backup: "ETH" }).success).toBe(false);
  });

  it("minute move is HOLD, or ROTATE with a coin", () => {
    expect(MinuteProposal.safeParse({ action: "HOLD" }).success).toBe(true);
    expect(MinuteProposal.safeParse({ action: "ROTATE", coin: "SOL" }).success).toBe(true);
    expect(MinuteProposal.safeParse({ action: "ROTATE" }).success).toBe(false);
    expect(MinuteProposal.safeParse({ action: "SELL", coin: "SOL" }).success).toBe(false);
  });
});

describe("reading model text", () => {
  it("finds the JSON inside prose and fences", () => {
    expect(extractJson('Sure! ```json\n{"primary":"SOL","backup":"ETH","call":"ZEC"}\n```')).toEqual({
      primary: "SOL",
      backup: "ETH",
      call: "ZEC",
    });
    expect(extractJson('{"a":"}{"}')).toEqual({ a: "}{" });
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson('{"broken": ')).toBeUndefined();
  });

  it("forgives lower-case coins, nothing else", () => {
    expect(readSeal("nova", '{"primary":"sol","backup":"eth","call":"zec"}')).toEqual({
      ok: true,
      value: { primary: "SOL", backup: "ETH", call: "ZEC" },
    });
    expect(readSeal("nova", '{"primary":"SOL","backup":"SOL","call":"ZEC"}').ok).toBe(false);
  });

  it("enforces the manner: ORACLE only BTC and ETH, RONIN only NEAR and ZEC", () => {
    expect(readSeal("oracle", '{"primary":"SOL","backup":"BTC","call":"ZEC"}').ok).toBe(false);
    expect(readSeal("oracle", '{"primary":"ETH","backup":"BTC","call":"SOL"}').ok).toBe(true);
    expect(readSeal("ronin", '{"primary":"NEAR","backup":"BTC","call":"SOL"}').ok).toBe(false);
    expect(readMinute(minute({ mask: "ronin", holding: "NEAR" }), '{"action":"ROTATE","coin":"SOL"}').ok).toBe(false);
  });

  it("refuses a second rotate and a rotate into the coin already held", () => {
    expect(checkMinute(minute({ rotated: true }), { action: "ROTATE", coin: "SOL" }).ok).toBe(false);
    expect(checkMinute(minute(), { action: "ROTATE", coin: "BTC" }).ok).toBe(false);
    expect(checkMinute(minute({ rotated: true }), { action: "HOLD" }).ok).toBe(true);
  });
});

describe("defaults follow the open manner", () => {
  it("every mask produces a seal that passes its own rules", () => {
    for (const mask of MASKS) {
      for (const rival of MASKS.filter((m) => m !== mask)) {
        const seal = defaultSeal({ mask, rival, market: MARKET });
        expect(SealProposal.safeParse(seal).success).toBe(true);
        expect(seal.backup).not.toBe(seal.primary);
        expect(MANNERS[mask].coins).toContain(seal.primary);
        expect(MANNERS[mask].coins).toContain(seal.backup);
      }
    }
  });

  it("ONYX buys the deepest drop, NOVA the fastest runner, ORACLE the stronger of BTC/ETH, RONIN of NEAR/ZEC", () => {
    expect(defaultSeal({ mask: "onyx", rival: "nova", market: MARKET }).primary).toBe("ZEC");
    expect(defaultSeal({ mask: "nova", rival: "onyx", market: MARKET }).primary).toBe("SOL");
    expect(defaultSeal({ mask: "oracle", rival: "onyx", market: MARKET })).toMatchObject({ primary: "ETH", backup: "BTC" });
    expect(defaultSeal({ mask: "ronin", rival: "onyx", market: MARKET })).toMatchObject({ primary: "NEAR", backup: "ZEC" });
  });

  it("calls the rival by the rival's manner", () => {
    expect(defaultSeal({ mask: "nova", rival: "onyx", market: MARKET }).call).toBe("ZEC");
    expect(defaultSeal({ mask: "onyx", rival: "nova", market: MARKET }).call).toBe("SOL");
    expect(defaultSeal({ mask: "onyx", rival: "oracle", market: MARKET }).call).toBe("ETH");
  });

  it("WRAITH never stands where it expects the rival", () => {
    const seal = defaultSeal({ mask: "wraith", rival: "nova", market: MARKET });
    expect(seal.primary).not.toBe(seal.call);
  });

  it("VOLT rotates at once, a spent rotate always holds, WRAITH rotates only when behind", () => {
    expect(defaultMinute(minute({ mask: "volt" }))).toEqual({ action: "ROTATE", coin: "SOL" });
    expect(defaultMinute(minute({ mask: "volt", rotated: true }))).toEqual({ action: "HOLD" });
    expect(defaultMinute(minute({ mask: "wraith", lead: 10 }))).toEqual({ action: "HOLD" });
    const behind = defaultMinute(minute({ mask: "wraith", lead: -10, rivalHolding: "SOL" }));
    expect(behind).toEqual({ action: "ROTATE", coin: "NEAR" });
  });

  it("every default minute move passes the rules", () => {
    for (const mask of MASKS) {
      const holding = MANNERS[mask].coins[0]!;
      const ctx = minute({ mask, holding, lead: -5 });
      expect(checkMinute(ctx, defaultMinute(ctx)).ok).toBe(true);
    }
  });
});
