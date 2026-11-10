/**
 * Simulation mode end to end: a sealed round in a real local sandbox with scripted masks, the real contracts and the
 * real judge. Skipped when the runner is not built (`pnpm --filter @maskwars/race build:runner`).
 */
import { describe, expect, it } from "vitest";
import { formatRound, simulateRound } from "../src/round.ts";
import { RunnerSandbox } from "../src/sandbox.ts";

const ready = await new RunnerSandbox().available();

describe.skipIf(!ready)("a simulated sealed round", () => {
  it("pays the mask that sealed and played its own plan, and no one who peeked or sabotaged", { timeout: 300_000 }, async () => {
    const board = await simulateRound();
    expect(board.winner).toBe("nova");
    const refused = (mask: string) => board.events.filter((e) => e.mask === mask && !e.ok).map((e) => e.note);
    expect(refused("onyx").join("\n")).toContain("the plan did not start the mask's own turn on the safe");
    // The saboteur tried to empty the safe in the commit window and kept a junk claim with the judge: the locked safe
    // refused it, and NOVA was paid anyway.
    expect(refused("jinx").join("\n")).toContain("the safe is locked until the commit window closes");
    expect(refused("jinx").join("\n")).toContain("the drain happened outside the race");
    expect(refused("oracle").join("\n")).toContain("this mask sealed no plan");
    expect(refused("volt").join("\n")).toContain("the commit window is closed");
    const lines = formatRound(board);
    expect(lines.at(-1)).toMatch(/^NOVA\s+PAID\s+✓/);
  });
});
