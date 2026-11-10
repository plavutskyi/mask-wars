import { join } from "node:path";
import { CHALLENGES_DIR, type Challenge, listChallenges, loadChallenge } from "@maskwars/race";
import { beforeAll, describe, expect, it } from "vitest";
import { CompetitionError, competitionProblems, planFromWork, raceBrief, raceCompetition, raceTitle } from "../src/competition.ts";
import { violations } from "./schema.ts";

const NOW = new Date("2026-11-08T12:00:00Z");
const challenges: Record<string, Challenge> = {};

beforeAll(async () => {
  for (const id of await listChallenges()) challenges[id] = await loadChallenge(join(CHALLENGES_DIR, id));
});

const get = (id: string): Challenge => {
  const c = challenges[id];
  if (!c) throw new Error(`no challenge ${id}`);
  return c;
};

describe("raceCompetition", () => {
  it("is a body POST /v1/jobs/competition takes, field for field", () => {
    const body = raceCompetition(get("open-admin"), { pool: "50", hours: 72, now: NOW });
    expect(violations("CreateCompetitionRequest", body, { strict: true })).toEqual([]);
    expect(body).toMatchObject({
      title: "MASK WARS race: drain the savings vault with an owner (NEAR contract, planted hole)",
      poolAmount: "50",
      poolToken: "USDC",
      entriesCloseAt: "2026-11-11T12:00:00Z",
      minBuilderVerification: "none",
    });
    expect(body.tags?.length).toBeLessThanOrEqual(10);
  });

  it("every training target except the one whose source names its hole can be posted", () => {
    const ids = Object.keys(challenges);
    expect(ids).toEqual(expect.arrayContaining(["open-admin", "over-withdraw", "proof-replay", "live-safe"]));
    for (const id of ids) {
      const problems = competitionProblems(get(id), { pool: "25", hours: 48 });
      if (id === "live-safe") expect(problems).toEqual(["live-safe: its source names the hole, so every work would find it at once"]);
      else expect(problems).toEqual([]);
    }
  });

  it("refuses a pool or a deadline the marketplace would refuse", () => {
    const c = get("open-admin");
    expect(() => raceCompetition(c, { pool: "0", hours: 72 })).toThrow(CompetitionError);
    expect(competitionProblems(c, { pool: "10.1234567", hours: 72 })[0]).toMatch(/at most 6 decimals/);
    expect(competitionProblems(c, { pool: "-5", hours: 72 })).toHaveLength(1);
    expect(competitionProblems(c, { pool: "10", hours: 1 })[0]).toMatch(/2 to 719/);
    expect(competitionProblems(c, { pool: "10", hours: 720 })).toHaveLength(1);
    expect(competitionProblems(c, { pool: "10", hours: 2.5 })).toHaveLength(1);
  });
});

describe("raceBrief", () => {
  it("carries the whole source, the world, the only win and the plan format", () => {
    const c = get("proof-replay");
    const brief = raceBrief(c);
    for (const f of c.source) expect(brief).toContain(f.text.trimEnd());
    expect(brief).toContain("- `vault.test.near`, 5 NEAR: the target. Its whole balance is the vault.");
    expect(brief).toContain("- `attacker.test.near`, 5 NEAR: you. Every step of your plan is sent from here.");
    expect(brief).toContain("- `alice.test.near`, 60 NEAR: an honest user.");
    expect(brief).toContain("1. `alice.test.near` calls `deposit` on the target with 50 NEAR attached.");
    expect(brief).toContain("3. `attacker.test.near` calls `claim` on the target, with these arguments:");
    expect(brief).toContain('The target sets itself up with `new` and these arguments:');
    expect(brief).toContain('"signature": "SKZxWLE21');
    expect(brief).toContain("at least 1 NEAR less than before them");
    expect(brief).toContain("at most 12 steps");
    expect(brief).toMatch(/planted on purpose/);
    expect(brief).not.toMatch(/<!--/);
  });

  it("names the target in the title as a planted hole", () => {
    expect(raceTitle(get("over-withdraw"))).toBe("MASK WARS race: drain the savings vault (NEAR contract, planted hole)");
  });
});

describe("planFromWork", () => {
  const work = (plan: string): string =>
    ["# Drain", "", "The plan:", "", "```json", plan, "```", "", "Why: `set_owner` never checks the caller.", "", "```rust", "require!(env::predecessor_account_id() == self.owner);", "```"].join("\n");

  it("takes the plan out of a work and holds it to the race's format", () => {
    const plan = JSON.stringify({
      steps: [
        { kind: "call", method: "set_owner", args: { new_owner: "attacker.test.near" } },
        { kind: "call", method: "sweep", args: { to: "attacker.test.near", amount: "90000000000000000000000000" } },
      ],
    });
    const out = planFromWork(work(plan), get("open-admin"));
    expect(out).toEqual({ ok: true, plan: JSON.parse(plan) });
  });

  it("refuses a plan the runner would refuse", () => {
    const bad = planFromWork(work(JSON.stringify({ steps: [{ kind: "deploy", code: "…" }] })), get("open-admin"));
    expect(bad.ok).toBe(false);
    const long = planFromWork(work(JSON.stringify({ steps: Array.from({ length: 13 }, () => ({ kind: "view", method: "get_owner" })) })), get("open-admin"));
    expect(long).toEqual({ ok: false, error: "plan has 13 steps, limit is 12" });
    expect(planFromWork("no plan at all", get("open-admin")).ok).toBe(false);
  });
});
