import { describe, expect, it } from "vitest";
import {
  act,
  backLastCall,
  backMain,
  canTransition,
  closeMainBook,
  CoreError,
  createFight,
  expireReveals,
  FIGHT_STATES,
  fightSeal,
  finish,
  IllegalTransitionError,
  markPaid,
  marketDuel,
  reveal,
  ring,
  samePrimaryLoser,
  submitSeal,
  voidFight,
  type DuelMove,
  type DuelState,
  type Fight,
} from "../src/index.ts";

const BELL = 1_800_000_000_000;
const USDC = 1_000_000n;
const SALT = ["11".repeat(32), "22".repeat(32)] as const;
const ID = "f-0-7";
const MOVES: [DuelMove, DuelMove] = [
  { primary: "BTC", backup: "ETH", call: "SOL" },
  { primary: "SOL", backup: "NEAR", call: "ETH" },
];

type F = Fight<DuelMove, DuelState>;

const sealOf = (side: 0 | 1, mv: unknown = MOVES[side]): string => {
  const x = mv as Record<string, string>;
  return fightSeal(ID, side === 0 ? "onyx" : "nova", [x.primary!, x.backup!, x.call!], SALT[side]);
};

function open(): F {
  let f: F = createFight(marketDuel, { id: ID, corners: ["onyx", "nova"], bellAt: BELL, revealWindowMs: 20_000 });
  f = backMain(f, { opId: "s0", account: "seed.near", outcome: 0, amount: 40n * USDC, seed: true }, BELL - 60_000);
  f = backMain(f, { opId: "s1", account: "seed.near", outcome: 1, amount: 10n * USDC, seed: true }, BELL - 60_000);
  f = backMain(f, { opId: "b1", account: "alice.near", outcome: 1, amount: 5n * USDC }, BELL - 31_000);
  return f;
}

function live(moves: readonly [unknown, unknown] = MOVES): F {
  let f = closeMainBook(open(), BELL - 30_000, 1_000n * USDC);
  f = submitSeal(f, 0, sealOf(0, moves[0]), BELL - 10_000);
  f = submitSeal(f, 1, sealOf(1, moves[1]), BELL - 5_000);
  return ring(marketDuel, f, BELL);
}

describe("fight state machine", () => {
  it("has exactly the spec's transitions", () => {
    const allowed = FIGHT_STATES.flatMap((a) => FIGHT_STATES.filter((b) => canTransition(a, b)).map((b) => `${a}>${b}`));
    expect(allowed.sort()).toEqual(
      ["OPEN>CLOSED", "CLOSED>SEALED", "SEALED>LIVE", "LIVE>RESULT", "RESULT>PAID", "OPEN>VOID", "CLOSED>VOID", "SEALED>VOID", "LIVE>VOID", "RESULT>VOID"].sort(),
    );
  });

  it("runs OPEN → CLOSED → SEALED → LIVE → RESULT → PAID", () => {
    let f = open();
    expect(f.state).toBe("OPEN");
    f = closeMainBook(f, BELL - 30_000, 1_000n * USDC);
    expect(f.state).toBe("CLOSED");
    f = submitSeal(f, 0, sealOf(0), BELL - 10_000);
    expect(f.state).toBe("CLOSED");
    f = submitSeal(f, 1, sealOf(1), BELL - 5_000);
    expect(f.state).toBe("SEALED");
    f = ring(marketDuel, f, BELL);
    expect(f.state).toBe("LIVE");
    f = reveal(marketDuel, f, 1, MOVES[1], SALT[1], BELL + 1_000);
    f = reveal(marketDuel, f, 0, MOVES[0], SALT[0], BELL + 2_000);
    expect(f.play?.entry).toEqual(["BTC", "SOL"]);
    expect(f.play?.calledIt).toEqual([true, false]);
    f = act(marketDuel, f, 1, { kind: "ROTATE", to: "NEAR" }, BELL + 61_000);
    f = backLastCall(marketDuel, f, { opId: "lc1", account: "bob.near", outcome: 1, amount: 2n * USDC }, BELL + 150_000);
    f = backLastCall(marketDuel, f, { opId: "lc2", account: "eve.near", outcome: 0, amount: 1n * USDC }, BELL + 200_000);
    expect(f.lastCall?.backs.map((b) => b.sealed)).toEqual([false, true]);
    expect(() => finish(marketDuel, f, { startUsdc: [10n * USDC, 10n * USDC], finalUsdc: [10n * USDC, 10n * USDC] }, BELL + 299_999)).toThrow(/closing bell/);
    // left +0 bp +25 called; right +20 bp
    f = finish(marketDuel, f, { startUsdc: [10n * USDC, 10n * USDC], finalUsdc: [10n * USDC, 10_020_000n] }, BELL + 300_000);
    expect(f.state).toBe("RESULT");
    expect(f.result).toMatchObject({ winner: 0, how: "score", judgement: { scores: [25n, 20n] } });
    expect(f.settlements?.map((s) => s.kind)).toEqual(["paid", "paid"]);
    const main = f.settlements![0]!;
    if (main.kind !== "paid") throw new Error("paid");
    expect(main.payouts).toEqual([{ opId: "s0", account: "seed.near", amount: 52_250_000n }]);
    f = markPaid(f);
    expect(f.state).toBe("PAID");
    expect(() => voidFight(f, "operator")).toThrow(IllegalTransitionError);
  });

  it("refuses steps out of order with a typed error", () => {
    const f = open();
    for (const step of [
      () => submitSeal(f, 0, sealOf(0), BELL - 10_000),
      () => ring(marketDuel, f, BELL),
      () => reveal(marketDuel, f, 0, MOVES[0], SALT[0], BELL),
      () => finish(marketDuel, f, { startUsdc: [1n, 1n], finalUsdc: [1n, 2n] }, BELL + 300_000),
      () => markPaid(f),
    ]) {
      try {
        step();
        throw new Error("did not throw");
      } catch (e) {
        expect(e).toBeInstanceOf(IllegalTransitionError);
        expect((e as IllegalTransitionError).code).toBe("illegal_transition");
        expect((e as IllegalTransitionError).from).toBe("OPEN");
      }
    }
    const l = live();
    expect(() => backMain(l, { opId: "z", account: "z", outcome: 0, amount: 1n }, BELL)).toThrow(IllegalTransitionError);
  });

  it("takes no BACK after close_at and counts an op_id once across books", () => {
    expect(() => backMain(open(), { opId: "late", account: "x", outcome: 0, amount: 1n }, BELL - 30_000)).toThrow(/30 s/);
    const replay = backMain(open(), { opId: "b1", account: "alice.near", outcome: 1, amount: 5n * USDC }, BELL - 40_000);
    expect(replay.main.backs.length).toBe(3);
    const l = live();
    expect(() => backLastCall(marketDuel, l, { opId: "b1", account: "alice.near", outcome: 1, amount: 5n * USDC }, BELL + 160_000)).toThrow(/already/);
    expect(() => backLastCall(marketDuel, l, { opId: "n", account: "x", outcome: 1, amount: 1n }, BELL + 149_999)).toThrow(/not open/);
    expect(() => backLastCall(marketDuel, l, { opId: "n", account: "x", outcome: 1, amount: 1n }, BELL + 210_000)).toThrow(/closed/);
  });

  it("voids when the vault cannot cover the book, every back refunded in full", () => {
    const f = closeMainBook(open(), BELL - 30_000, 54n * USDC);
    expect(f.state).toBe("VOID");
    expect(f.voidReason).toBe("insolvent");
    const s = f.settlements![0]!;
    expect(s.kind).toBe("void");
    if (s.kind === "void") expect(s.refunds.map((r) => r.amount)).toEqual([40n * USDC, 10n * USDC, 5n * USDC]);
  });

  it("voids a fight still missing a seal at the bell", () => {
    let f = closeMainBook(open(), BELL - 30_000, 1_000n * USDC);
    f = submitSeal(f, 0, sealOf(0), BELL - 10_000);
    expect(() => submitSeal(f, 1, sealOf(1), BELL)).toThrow(/before the bell/);
    expect(() => submitSeal(f, 0, sealOf(0), BELL - 1)).toThrow(CoreError);
    expect(ring(marketDuel, f, BELL)).toMatchObject({ state: "VOID", voidReason: "missing_seal" });
  });

  it("refuses a reveal that does not match the seal", () => {
    const f = live();
    expect(() => reveal(marketDuel, f, 0, MOVES[1], SALT[0], BELL)).toThrow(/does not match/);
    expect(() => reveal(marketDuel, f, 0, MOVES[0], SALT[1], BELL)).toThrow(/does not match/);
    expect(() => reveal(marketDuel, f, 0, MOVES[0], SALT[0], BELL + 20_001)).toThrow(/deadline/);
    const once = reveal(marketDuel, f, 0, MOVES[0], SALT[0], BELL);
    expect(() => reveal(marketDuel, once, 0, MOVES[0], SALT[0], BELL)).toThrow(/revealed/);
  });

  it("forfeits a sealed move outside the rules: coin outside the basket, backup = primary", () => {
    const bad = { primary: "DOGE", backup: "ETH", call: "SOL" };
    let f = live([bad, MOVES[1]]);
    f = reveal(marketDuel, f, 0, bad, SALT[0], BELL + 1_000);
    expect(f.state).toBe("LIVE");
    f = reveal(marketDuel, f, 1, MOVES[1], SALT[1], BELL + 2_000);
    expect(f.result).toMatchObject({ winner: 1, how: "forfeit" });
    const same = { primary: "ETH", backup: "ETH", call: "SOL" };
    let g = live([MOVES[0], same]);
    g = reveal(marketDuel, g, 1, same, SALT[1], BELL);
    g = expireReveals(g, BELL + 20_001);
    expect(g.state).toBe("VOID");
  });

  it("after the deadline: one reveal wins by forfeit, none voids", () => {
    let f = reveal(marketDuel, live(), 1, MOVES[1], SALT[1], BELL);
    expect(() => expireReveals(f, BELL + 20_000)).toThrow(/not passed/);
    f = expireReveals(f, BELL + 20_001);
    expect(f.result).toMatchObject({ winner: 1, how: "forfeit" });
    expect(expireReveals(live(), BELL + 20_001)).toMatchObject({ state: "VOID", voidReason: "no_reveal" });
  });

  it("voids a tie, refunding the LAST CALL book too", () => {
    let f = reveal(marketDuel, live(), 0, MOVES[0], SALT[0], BELL);
    f = reveal(marketDuel, f, 1, MOVES[1], SALT[1], BELL);
    f = backLastCall(marketDuel, f, { opId: "lc", account: "bob.near", outcome: 0, amount: 3n }, BELL + 170_000);
    // left called right; give right exactly 25 bp more
    f = finish(marketDuel, f, { startUsdc: [10n * USDC, 10n * USDC], finalUsdc: [10n * USDC, 10_025_000n] }, BELL + 300_000);
    expect(f.state).toBe("VOID");
    expect(f.voidReason).toBe("tie");
    expect(f.settlements?.map((s) => s.kind)).toEqual(["void", "void"]);
  });

  it("uses the same-primary rule from sha256(fight_id)", () => {
    const same: [DuelMove, DuelMove] = [
      { primary: "ZEC", backup: "BTC", call: "ZEC" },
      { primary: "ZEC", backup: "ETH", call: "ZEC" },
    ];
    let f = reveal(marketDuel, live(same), 0, same[0], SALT[0], BELL);
    f = reveal(marketDuel, f, 1, same[1], SALT[1], BELL);
    const loser = samePrimaryLoser(ID);
    expect(f.play?.entry[loser]).toBe(same[loser].backup);
    expect(f.play?.entry[loser === 0 ? 1 : 0]).toBe("ZEC");
  });
});
