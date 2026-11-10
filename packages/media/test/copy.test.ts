import { describe, expect, it } from "vitest";
import { CardGrid, gridText, loseText, parseEvent, usd, usdCard, winText } from "../src/index.ts";
import { examples } from "./helpers.ts";

const ex = examples();

describe("drafts", () => {
  it("The Card reads like Wordle: day and score first, squares, streak, no link", () => {
    const g = gridText(CardGrid.parse(ex.card_grid));
    expect(g.text).toBe("MASK WARS #4 4/5\n🟧🟪🟧⬛🟪\n4 days straight");
    expect(g.text.split("\n")[0]).not.toMatch(/\.xyz|http/);
    expect(g.reply).toMatch(/maskwars\.xyz/);
  });

  it("a streak of one says nothing about a streak", () => {
    const g = gridText(CardGrid.parse({ ...ex.card_grid, streak: 1 }));
    expect(g.text.split("\n")).toHaveLength(2);
  });

  it("numbers come from the event", () => {
    const w = winText(parseEvent(ex.win_card) as any);
    expect(w.text).toContain("$5");
    expect(w.text).toContain("$41.20");
    expect(w.text).toContain("@kaito_trades");
    expect(loseText(parseEvent(ex.lose_card) as any).text).toContain(ex.lose_card.line);
  });

  it("money formats", () => {
    expect(usd(5_000_000n)).toBe("$5");
    expect(usd(41_200_000n)).toBe("$41.20");
    expect(usd(1_240_500_000n)).toBe("$1,240");
    expect(usdCard(41_990_000n)).toBe("$41");
    expect(usdCard(4_600_000n)).toBe("$4.60");
  });
});
