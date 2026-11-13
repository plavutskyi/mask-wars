/**
 * The real thing: the Rust runner and a local `neard`. Skipped when the runner is not built
 * (`pnpm --filter @maskwars/race build:runner`). Each attempt starts its own sandbox, so this takes a while.
 */
import { FakeProvider } from "@maskwars/mind";
import { describe, expect, it } from "vitest";
import { ModelAttacker } from "../src/agent.ts";
import { formatJournal } from "../src/journal.ts";
import { Plan } from "../src/plan.ts";
import { runRace } from "../src/race.ts";
import { RunnerSandbox } from "../src/sandbox.ts";
import { challenge, planText } from "./fixtures.ts";

const sandbox = new RunnerSandbox();
const ready = await sandbox.available();
const MODEL = "z-ai/glm-5.3-flash";

describe.skipIf(!ready)("real sandbox", () => {
  for (const id of ["open-admin", "over-withdraw", "proof-replay"]) {
    it(`${id}: right plan breaks the vault, wrong plan does not`, { timeout: 120_000 }, async () => {
      const c = await challenge(id);
      const [win, miss] = await Promise.all([
        sandbox.attempt(c, Plan.parse(JSON.parse(await planText(id, "breach")))),
        sandbox.attempt(c, Plan.parse(JSON.parse(await planText(id, "miss")))),
      ]);
      expect(win.verdict, win.reason).toBe("breach");
      expect(BigInt(win.stolen)).toBeGreaterThanOrEqual(10n ** 24n);
      expect(miss.verdict, miss.reason).toBe("held");
      expect(miss.stolen).toBe("0");
    });
  }

  it("two fake agents race: one wins, the board shows it", { timeout: 180_000 }, async () => {
    const c = await challenge("proof-replay");
    const right = await planText("proof-replay", "breach");
    const wrong = await planText("proof-replay", "miss");
    const result = await runRace({
      challenge: c,
      sandbox,
      maxAttempts: 2,
      attackers: [
        new ModelAttacker({ id: "WRAITH", provider: new FakeProvider([wrong, wrong]), model: MODEL }),
        new ModelAttacker({ id: "ORACLE", provider: new FakeProvider([wrong, right]), model: MODEL }),
      ],
    });
    expect(result.winner?.attacker).toBe("ORACLE");
    expect(result.winner?.attempt).toBe(2);
    expect(BigInt(result.winner!.stolen)).toBe(10n * 10n ** 24n);
    const board = formatJournal(result.journal);
    expect(board.find((l) => l.startsWith("ORACLE"))).toMatch(/^ORACLE {2}attempt 1: ×, attempt 2: breach in \d/);
    console.log(board.join("\n"));
  });

  it("a plan that breaks the rules never reaches a contract", async () => {
    const c = await challenge("open-admin");
    const long = Plan.parse({ steps: Array(13).fill({ kind: "view", method: "get_owner" }) });
    const out = await sandbox.attempt(c, long);
    expect(out.verdict).toBe("invalid");
  });
});
