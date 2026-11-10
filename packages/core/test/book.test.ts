import { describe, expect, it } from "vitest";
import { addBack, closeBook, CoreError, multipliers, openBook, settle, splitmix64, below, type Book } from "../src/index.ts";

const USDC = 1_000_000n;

function book(backs: [number, bigint][], outcomes = 2, rakeBps = 500): Book {
  let b = openBook({ id: "b", kind: outcomes === 6 ? "season" : "main", outcomes, rakeBps });
  backs.forEach(([outcome, amount], i) => {
    b = addBack(b, { opId: `op-${i}`, account: `a${i}`, outcome, amount });
  });
  return b;
}

describe("book", () => {
  it("pays the spec's formula", () => {
    const s = settle(book([[0, 40n * USDC], [1, 10n * USDC]]), 1);
    expect(s.kind).toBe("paid");
    if (s.kind !== "paid") return;
    expect(s.T).toBe(50n * USDC);
    expect(s.rake).toBe(2_500_000n);
    expect(s.D).toBe(47_500_000n);
    expect(s.payouts).toEqual([{ opId: "op-1", account: "a1", amount: 47_500_000n }]);
    expect(s.dust).toBe(0n);
    expect(s.maskShare).toBe(500_000n);
  });

  it("caps the rake by the losing side", () => {
    const s = settle(book([[0, 1000n * USDC], [1, 1n * USDC]]), 0);
    if (s.kind !== "paid") throw new Error("paid");
    expect(s.rake).toBe(1n * USDC);
    expect(s.payouts[0]!.amount).toBe(1000n * USDC);
  });

  it("sends dust to the house", () => {
    const s = settle(book([[0, 1n], [0, 1n], [0, 1n], [1, 2n]]), 0);
    if (s.kind !== "paid") throw new Error("paid");
    expect(s.rake).toBe(0n);
    expect(s.payouts.map((p) => p.amount)).toEqual([1n, 1n, 1n]);
    expect(s.dust).toBe(2n);
    expect(s.house).toBe(2n);
  });

  it("voids a one-sided book, a book nobody won and an empty book, with full refunds", () => {
    const one = settle(book([[0, 5n], [0, 7n]]), 0);
    expect(one).toMatchObject({ kind: "void", reason: "one_sided" });
    const none = settle(book([[0, 5n], [0, 7n]]), 1);
    expect(none).toMatchObject({ kind: "void", reason: "no_winner_backs" });
    if (none.kind === "void") expect(none.refunds.map((r) => r.amount)).toEqual([5n, 7n]);
    expect(settle(book([]), 0)).toMatchObject({ kind: "void", reason: "empty" });
  });

  it("is idempotent on a replayed op_id and refuses a changed one", () => {
    const b = book([[0, 5n]]);
    expect(addBack(b, { opId: "op-0", account: "a0", outcome: 0, amount: 5n })).toBe(b);
    expect(() => addBack(b, { opId: "op-0", account: "a0", outcome: 1, amount: 5n })).toThrow(CoreError);
  });

  it("refuses bad backs and backs on a closed book", () => {
    const b = book([]);
    expect(() => addBack(b, { opId: "x", account: "a", outcome: 2, amount: 1n })).toThrow(/outcome/);
    expect(() => addBack(b, { opId: "x", account: "a", outcome: 0, amount: 0n })).toThrow(/positive/);
    expect(() => addBack(closeBook(b), { opId: "x", account: "a", outcome: 0, amount: 1n })).toThrow(/closed/);
  });

  it("shows multipliers as D / W_side, two decimals rounded down, sealed backs hidden on request", () => {
    let b = book([[0, 40n * USDC], [1, 10n * USDC]]);
    expect(multipliers(b)).toEqual([118, 475]);
    b = addBack(b, { opId: "late", account: "z", outcome: 1, amount: 40n * USDC, sealed: true });
    expect(multipliers(b, false)).toEqual([118, 475]);
    expect(multipliers(b)).toEqual([213, 171]);
    expect(multipliers(book([[0, 1n]]))).toEqual([100, null]);
  });

  it("runs a 6-outcome season book", () => {
    const s = settle(book([[0, 50n], [1, 40n], [2, 30n], [3, 20n], [4, 1n], [5, 10n]], 6), 4);
    if (s.kind !== "paid") throw new Error("paid");
    expect(s.payouts[0]!.amount).toBe(144n);
  });
});

describe("book properties on random books", () => {
  const next = splitmix64(0xb00cn);
  const books = Array.from({ length: 3000 }, (_, i) => {
    const outcomes = i % 3 === 0 ? 6 : 2;
    const count = 1 + Number(below(next, 30n));
    const scale = [10n, 1000n, 100n * USDC, 2n ** 90n][Number(below(next, 4n))]!;
    const backs: [number, bigint][] = [];
    for (let j = 0; j < count; j++) backs.push([Number(below(next, BigInt(outcomes))), 1n + below(next, scale)]);
    const rakeBps = Number(below(next, 10_001n));
    return { b: book(backs, outcomes, rakeBps), winner: Number(below(next, BigInt(outcomes))) };
  });

  it("Σ payouts + rake + dust = T, every winner gets at least the stake, losers get nothing", () => {
    let paid = 0;
    for (const { b, winner } of books) {
      const s = settle(b, winner);
      if (s.kind === "void") {
        expect(s.refunds.reduce((a, r) => a + r.amount, 0n)).toBe(s.T);
        expect(s.refunds.map((r) => r.amount)).toEqual(b.backs.map((x) => x.amount));
        continue;
      }
      paid++;
      const sum = s.payouts.reduce((a, p) => a + p.amount, 0n);
      expect(sum + s.rake + s.dust).toBe(s.T);
      expect(s.house).toBe(s.rake + s.dust);
      expect(s.dust >= 0n).toBe(true);
      expect(s.rake <= s.T - s.W).toBe(true);
      expect(s.maskShare <= s.house).toBe(true);
      const winners = b.backs.filter((x) => x.outcome === winner);
      expect(s.payouts.length).toBe(winners.length);
      winners.forEach((x, i) => expect(s.payouts[i]!.amount >= x.amount).toBe(true));
      // dust is less than one unit per winning back
      expect(s.dust < BigInt(winners.length)).toBe(true);
    }
    expect(paid).toBeGreaterThan(1000);
  }, 30_000);
});
