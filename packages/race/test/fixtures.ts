import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CHALLENGES_DIR, loadChallenge, type Challenge } from "../src/challenge.ts";
import { localOutcome, type Outcome } from "../src/outcome.ts";
import type { Plan } from "../src/plan.ts";
import type { Sandbox } from "../src/sandbox.ts";

/** The same right and wrong plans the Rust sandbox tests use. */
export async function planText(id: string, kind: "breach" | "miss"): Promise<string> {
  return readFile(join(CHALLENGES_DIR, "runner", "tests", "plans", `${id}.${kind}.json`), "utf8");
}

export function challenge(id: string): Promise<Challenge> {
  return loadChallenge(join(CHALLENGES_DIR, id));
}

/**
 * Stand-in for the Rust runner in race-logic tests: a plan breaks the vault only if it equals the known right plan.
 * The real judgement is covered by the sandbox tests in this package and in `contracts/challenges`.
 */
export class TableSandbox implements Sandbox {
  readonly runs: Plan[] = [];
  readonly #breach: string;
  readonly #delayMs: number;

  constructor(breachPlan: Plan, delayMs = 5) {
    this.#breach = JSON.stringify(breachPlan);
    this.#delayMs = delayMs;
  }

  async attempt(c: Challenge, plan: Plan, signal?: AbortSignal): Promise<Outcome> {
    this.runs.push(plan);
    await new Promise((r) => setTimeout(r, this.#delayMs));
    if (signal?.aborted) return localOutcome(c.manifest.id, "error", "aborted");
    const hit = JSON.stringify(plan) === this.#breach;
    return {
      ...localOutcome(c.manifest.id, hit ? "breach" : "held", hit ? "vault drained of 90.000 NEAR" : "vault held"),
      stolen: hit ? "90000000000000000000000000" : "0",
    };
  }
}
