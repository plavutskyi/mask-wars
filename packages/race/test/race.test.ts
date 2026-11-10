import { FakeProvider } from "@maskwars/mind";
import { describe, expect, it } from "vitest";
import { ModelAttacker, attackPrompt } from "../src/agent.ts";
import { Plan } from "../src/plan.ts";
import { runRace } from "../src/race.ts";
import { TableSandbox, challenge, planText } from "./fixtures.ts";

const MODEL = "z-ai/glm-5.3-flash";

async function setup() {
  const c = await challenge("over-withdraw");
  const right = await planText("over-withdraw", "breach");
  const wrong = await planText("over-withdraw", "miss");
  return { c, right, wrong, sandbox: new TableSandbox(Plan.parse(JSON.parse(right))) };
}

describe("race of fake agents", () => {
  it("gives a winner, a public journal and a private finding", async () => {
    const { c, right, wrong, sandbox } = await setup();
    // ONYX misses twice. NOVA answers in prose first, then finds the hole on attempt 2.
    const onyx = new ModelAttacker({ id: "ONYX", provider: new FakeProvider([wrong, wrong, wrong]), model: MODEL });
    const novaModel = new FakeProvider(["I would start by reading withdraw()", { delayMs: 20, text: right }]);
    const nova = new ModelAttacker({ id: "NOVA", provider: novaModel, model: MODEL });

    const seen: string[] = [];
    const result = await runRace({ challenge: c, attackers: [onyx, nova], sandbox, maxAttempts: 3, onEntry: (e) => seen.push(`${e.attacker}:${e.attempt}:${e.verdict}`) });

    expect(result.winner).toMatchObject({ attacker: "NOVA", attempt: 2, stolen: "90000000000000000000000000" });
    expect(result.finding?.plan).toEqual(JSON.parse(right));
    expect(result.finding?.replay.verdict).toBe("breach");
    expect(seen).toContain("NOVA:1:invalid");
    expect(seen.at(-1)).toBe("NOVA:2:breach");
    expect(seen.filter((s) => s.startsWith("ONYX")).every((s) => s.endsWith(":held"))).toBe(true);
    // The public journal carries no plan and no method names.
    const board = JSON.stringify(result.journal);
    expect(board).not.toContain("withdraw");
    expect(board).not.toContain("deposit");
    // The winning plan ran twice (attempt + clean replay); after that the race stopped.
    expect(sandbox.runs.filter((p) => JSON.stringify(p) === JSON.stringify(JSON.parse(right)))).toHaveLength(2);
    // NOVA's second prompt carried its own failed first attempt as data.
    const second = JSON.parse(novaModel.requests[1]!.messages[1]!.content);
    expect(second.previous_attempts[0]).toMatchObject({ attempt: 1, plan: null, verdict: "invalid" });
  });

  it("has no winner when nobody breaks through", async () => {
    const { c, wrong, sandbox } = await setup();
    const a = new ModelAttacker({ id: "ONYX", provider: new FakeProvider([], wrong), model: MODEL });
    const b = new ModelAttacker({ id: "VOLT", provider: new FakeProvider([new Error("model down")], wrong), model: MODEL });
    const result = await runRace({ challenge: c, attackers: [a, b], sandbox, maxAttempts: 2 });
    expect(result.winner).toBeNull();
    expect(result.finding).toBeNull();
    expect(result.journal).toHaveLength(4);
    expect(result.journal.find((e) => e.attacker === "VOLT" && e.attempt === 1)?.verdict).toBe("invalid");
  });

  it("does not wait for a slow loser once someone has won", async () => {
    const { c, right, sandbox } = await setup();
    const slow = new ModelAttacker({ id: "RONIN", provider: new FakeProvider([{ delayMs: 3_000, text: right }]), model: MODEL });
    const fast = new ModelAttacker({ id: "VOLT", provider: new FakeProvider([right]), model: MODEL });
    const t0 = Date.now();
    const result = await runRace({ challenge: c, attackers: [slow, fast], sandbox, maxAttempts: 1 });
    expect(result.winner?.attacker).toBe("VOLT");
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(result.journal.map((e) => e.attacker)).toEqual(["VOLT"]);
  });

  it("refuses duplicate names", async () => {
    const { c, sandbox } = await setup();
    const a = new ModelAttacker({ id: "ONYX", provider: new FakeProvider(), model: MODEL });
    await expect(runRace({ challenge: c, attackers: [a, a], sandbox, maxAttempts: 1 })).rejects.toThrow(/unique/);
  });
});

describe("attack prompt", () => {
  it("keeps the target's source in the data, never in the rules", async () => {
    const c = await challenge("open-admin");
    const [system, user] = attackPrompt(c, []);
    expect(system!.role).toBe("system");
    expect(system!.content).not.toContain("set_owner");
    const data = JSON.parse(user!.content);
    expect(data.target.account).toBe("vault.test.near");
    expect(data.you.account).toBe("attacker.test.near");
    expect(data.target.source[0].text).toContain("pub fn set_owner");
  });

  it("hands the attacker the public kit", async () => {
    const c = await challenge("proof-replay");
    const data = JSON.parse(attackPrompt(c, [])[1]!.content);
    expect(data.public_kit.proof.nonce).toBe(7);
  });
});
