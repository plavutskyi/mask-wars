/**
 * Where the keys live. `MASK_KEYS` and `KEEPER_SEED` sign for the masks, and
 * `OUTLAYER_PAYMENT_KEY` pays for the people's minds. A repository secret is read by any workflow on any branch, so each
 * of them lives only in an environment that only `main` deploys to, and only the jobs that name it read it. These tests
 * read the workflow files themselves: a job that reads a key without its environment, a caller that could hand a key
 * in, or a job with a key that does not wait for `guard`, fails here before it ever reaches GitHub.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../../.github/workflows/", import.meta.url);
/** The environment a job must name to read each key. */
const HOME: Readonly<Record<string, string>> = {
  MASK_KEYS: "live-race",
  KEEPER_SEED: "live-race",
  OUTLAYER_PAYMENT_KEY: "outlayer",
};
const KEYS = Object.keys(HOME);
/**
 * How a job names a key's environment: the network's own. Mainnet keeps its keys in `<name>-mainnet`, picked by the
 * exact value of the repository variable, so neither network ever reads the other's keys.
 */
const onNetwork = (name: string) => `\${{ vars.MASKWARS_NETWORK == 'mainnet' && '${name}-mainnet' || '${name}' }}`;

interface Job {
  readonly name: string;
  environment: string | null;
  needs: string[];
  cond: string;
  readonly secrets: string[];
  checkout: boolean;
}

/** The jobs of a workflow file as far as these checks need: GitHub's own layout, two spaces a level. */
function jobsOf(text: string): Job[] {
  const lines = text.split("\n");
  const out: Job[] = [];
  let job: Job | null = null;
  let folded = false;
  for (const line of lines.slice(lines.indexOf("jobs:") + 1)) {
    const head = /^ {2}([a-z][\w-]*):\s*$/.exec(line);
    if (head) {
      job = { name: head[1]!, environment: null, needs: [], cond: "", secrets: [], checkout: false };
      out.push(job);
      folded = false;
      continue;
    }
    if (!job) continue;
    const prop = /^ {4}([a-z-]+):\s*(.*)$/.exec(line);
    if (prop) {
      const [, key, value = ""] = prop;
      folded = key === "if" && value === ">-";
      if (key === "environment") job.environment = value.trim();
      if (key === "needs") job.needs = value.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      if (key === "if" && !folded) job.cond = value;
    } else if (folded && /^ {6}\S/.test(line)) {
      job.cond += ` ${line.trim()}`;
    }
    for (const m of line.matchAll(/secrets\.([A-Z_]+)/g)) job.secrets.push(m[1]!);
    if (/uses: actions\/checkout@/.test(line)) job.checkout = true;
  }
  return out;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml"));
const text = (f: string) => readFileSync(new URL(f, DIR), "utf8");
const job = (f: string, name: string) => jobsOf(text(f)).find((j) => j.name === name)!;

/** The job runs only when `guard` succeeded: a status check that says so, or none, which GitHub reads as success(). */
function waitsForGuard(j: Job): boolean {
  if (!j.needs.includes("guard")) return false;
  const implicit = !/\b(always|cancelled|failure|success)\(\)/.test(j.cond);
  return implicit || j.cond.includes("needs.guard.result == 'success'");
}

describe("the masks' keys and the minds' payment key live in environments only", () => {
  it("every job that reads a key names the key's environment, and nothing else reads one but guard", () => {
    const readers: string[] = [];
    for (const f of files) {
      for (const j of jobsOf(text(f))) {
        for (const key of j.secrets.filter((s) => KEYS.includes(s))) {
          readers.push(`${f}/${j.name}/${key}`);
          if (j.name === "guard") continue;
          expect(j.environment, `${f}: job ${j.name} reads ${key}`).toBe(onNetwork(HOME[key]!));
        }
      }
    }
    // The ones that sign, the one that pays, and the guards.
    expect(readers).toEqual(
      expect.arrayContaining([
        "live-race.yml/arm/KEEPER_SEED",
        "live-race.yml/drain/MASK_KEYS",
        "live-race.yml/drain/KEEPER_SEED",
        "live-race.yml/settle/KEEPER_SEED",
        "live-race.yml/race/OUTLAYER_PAYMENT_KEY",
        "keeper.yml/keeper/KEEPER_SEED",
        "live-race.yml/guard/MASK_KEYS",
        "keeper.yml/guard/KEEPER_SEED",
      ]),
    );
  });

  it("no job with a mask's key ever runs the race: the models and the sandbox never share a runner with one", () => {
    const race = job("live-race.yml", "race");
    expect(race.secrets.filter((s) => s === "MASK_KEYS" || s === "KEEPER_SEED")).toEqual([]);
    expect(race.environment).toBe(onNetwork("outlayer"));
  });

  it("guard sees a key only if it is a repository secret, runs no code of the repository, and every job with a key waits for it", () => {
    for (const f of ["live-race.yml", "keeper.yml"]) {
      const jobs = jobsOf(text(f));
      const guard = jobs.find((j) => j.name === "guard")!;
      expect(guard.environment, f).toBeNull();
      expect(guard.checkout, `${f}: guard checks out no code`).toBe(false);
      for (const j of jobs.filter((j) => j.environment !== null && j.environment !== "live-race-hand")) {
        expect(waitsForGuard(j), `${f}: ${j.name} waits for guard (${j.needs.join(",")} / ${j.cond})`).toBe(true);
      }
    }
    expect(text("live-race.yml")).toMatch(/for name in MASK_KEYS KEEPER_SEED OUTLAYER_PAYMENT_KEY; do/);
    expect(text("keeper.yml")).toMatch(/for name in MASK_KEYS KEEPER_SEED; do/);
  });

  // The season inherits: only then does GitHub give the called drain job the secrets of its own environment (with a
  // list of secrets it read an empty MASK_KEYS in the season's first two rounds). Inheriting hands on the repository's
  // secrets, so none of the keys may ever be one: guard checks that at every run, and no other workflow inherits.
  it("only the season inherits, and it names no key itself", () => {
    for (const f of files.filter((f) => f !== "season.yml")) expect(text(f), `${f} hands every secret on`).not.toMatch(/secrets:\s*inherit/);
    expect(text("season.yml").match(/secrets:\s*inherit/g)).toHaveLength(1);
    expect(text("season.yml")).not.toMatch(/OUTLAYER_PAYMENT_KEY|MASK_KEYS|KEEPER_SEED/);
  });

  // A called workflow reads a secret only if its `workflow_call` names it. Named and not required, the key comes from
  // the job's environment, which wins over anything a caller passes.
  it("the called race names each key so its jobs read it from their environments, and requires none from a caller", () => {
    const t = text("live-race.yml");
    const call = t.slice(t.indexOf("  workflow_call:"), t.indexOf("\nenv:"));
    for (const key of KEYS) expect(call, `live-race.yml names ${key}`).toContain(`      ${key}:\n        required: false\n`);
  });

  it("a run started by hand waits for the owner's yes; the season's run does not", () => {
    const hand = job("live-race.yml", "hand");
    expect(hand.environment).toBe("live-race-hand");
    expect(hand.cond).toBe("github.event_name == 'workflow_dispatch' && github.workflow == 'Live race'");
    for (const name of ["arm", "race"]) {
      const j = job("live-race.yml", name);
      expect(j.needs, name).toContain("hand");
      expect(j.cond, name).toContain("needs.hand.result != 'failure'");
    }
    expect(job("keeper.yml", "keeper").needs).toEqual(["guard", "hand"]);
    expect(job("keeper.yml", "hand").environment).toBe("live-race-hand");
  });
});
