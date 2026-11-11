/**
 * Where the keys live. `MASK_KEYS` and `KEEPER_SEED` sign for the masks, `OUTLAYER_PAYMENT_KEY` pays for the people's
 * minds, `NEAR_AI_API_KEY` pays for our masks' models, `HOUSE_KEY` signs for the house, which opens the daily round on
 * mainnet, and `SCHEDULER_KEY` opens the season's round on testnet. A repository secret is read by any workflow on any
 * branch, so each of them lives only in an environment that only `main` deploys to, and only the jobs that name it read
 * it. These tests read the workflow files themselves: a job that reads a key without its environment, a caller that
 * could hand a key in, a guard that misses a key its workflow receives, or a job with a key that does not wait for
 * `guard`, fails here before it ever reaches GitHub.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../../.github/workflows/", import.meta.url);
/** The environment a job must name to read each key. */
const HOME: Readonly<Record<string, string>> = {
  MASK_KEYS: "live-race",
  KEEPER_SEED: "live-race",
  OUTLAYER_PAYMENT_KEY: "outlayer",
  NEAR_AI_API_KEY: "outlayer",
  HOUSE_KEY: "season",
  SCHEDULER_KEY: "season",
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

/** The text of one job of a workflow: from its name to the next job's. */
function block(t: string, name: string): string {
  const lines = t.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^ {2}[a-z][\w-]*:\s*$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

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
          if (j.name === "guard" || (f === "ci.yml" && j.name === "keys")) continue;
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
        "live-race.yml/race/NEAR_AI_API_KEY",
        "keeper.yml/keeper/KEEPER_SEED",
        "live-race.yml/guard/MASK_KEYS",
        "keeper.yml/guard/KEEPER_SEED",
        "jobs.yml/take/MASK_KEYS",
        "jobs.yml/finish/MASK_KEYS",
        "jobs.yml/guard/MASK_KEYS",
        "jobs.yml/guard/OUTLAYER_PAYMENT_KEY",
        "season.yml/open/HOUSE_KEY",
        "season.yml/open/SCHEDULER_KEY",
        "season.yml/guard/HOUSE_KEY",
      ]),
    );
    // The house's key signs in one job of one workflow, and nowhere else; the guards only look.
    expect(readers.filter((r) => r.endsWith("/HOUSE_KEY")).sort()).toEqual(["ci.yml/keys/HOUSE_KEY", "season.yml/guard/HOUSE_KEY", "season.yml/open/HOUSE_KEY"]);
    // The models' key pays in the race job and nowhere else.
    expect(readers.filter((r) => r.endsWith("/NEAR_AI_API_KEY") && !/\/(guard|keys)\//.test(r)).sort()).toEqual(["live-race.yml/race/NEAR_AI_API_KEY"]);
  });

  it("no job with a mask's key ever runs the race: the models and the sandbox never share a runner with one", () => {
    const race = job("live-race.yml", "race");
    expect(race.secrets.filter((s) => s === "MASK_KEYS" || s === "KEEPER_SEED")).toEqual([]);
    expect(race.environment).toBe(onNetwork("outlayer"));
  });

  it("guard sees a key only if it is a repository secret, runs no code of the repository, and every job with a key waits for it", () => {
    for (const f of ["live-race.yml", "keeper.yml", "jobs.yml", "season.yml"]) {
      const jobs = jobsOf(text(f));
      const guard = jobs.find((j) => j.name === "guard")!;
      expect(guard.environment, f).toBeNull();
      expect(guard.checkout, `${f}: guard checks out no code`).toBe(false);
      for (const j of jobs.filter((j) => j.environment !== null && j.environment !== "live-race-hand")) {
        expect(waitsForGuard(j), `${f}: ${j.name} waits for guard (${j.needs.join(",")} / ${j.cond})`).toBe(true);
      }
    }
    // Each guard checks every key its workflow can receive: its own jobs' keys and, where it inherits into the race,
    // the race's. A key a guard does not name would reach the jobs as a repository secret unnoticed.
    const race = ["MASK_KEYS", "KEEPER_SEED", "OUTLAYER_PAYMENT_KEY", "NEAR_AI_API_KEY"];
    const want: Record<string, string[]> = {
      "live-race.yml": race,
      "keeper.yml": ["MASK_KEYS", "KEEPER_SEED"],
      "jobs.yml": race,
      "season.yml": ["HOUSE_KEY", "SCHEDULER_KEY", ...race],
    };
    for (const [f, keys] of Object.entries(want)) {
      const guard = block(text(f), "guard");
      expect(guard, f).toContain(`for name in ${keys.join(" ")}; do`);
      for (const key of keys) expect(guard, `${f}: guard reads ${key}`).toContain(`${key}: \${{ secrets.${key} }}`);
      const received = new Set(jobsOf(text(f)).flatMap((j) => j.secrets).filter((s) => KEYS.includes(s)));
      for (const key of received) expect(keys, `${f} reads ${key}, so its guard checks it`).toContain(key);
    }
  });

  // A cloud session or a stolen token that can push a branch could run a workflow of its own; a key that is a
  // repository secret would go with it. CI runs on every pull request and every push to main, so it is where such a key
  // shows first.
  it("CI is red whenever any key is a repository secret, and never runs code where it looks", () => {
    const keys = jobsOf(text("ci.yml")).find((j) => j.name === "keys")!;
    expect(keys.environment).toBeNull();
    expect(keys.checkout).toBe(false);
    expect([...keys.secrets].sort()).toEqual([...KEYS].sort());
    expect(block(text("ci.yml"), "keys")).toContain(`for name in ${["MASK_KEYS", "KEEPER_SEED", "HOUSE_KEY", "SCHEDULER_KEY", "OUTLAYER_PAYMENT_KEY", "NEAR_AI_API_KEY"].join(" ")}; do`);
    expect(job("ci.yml", "ci-ok").needs).toContain("keys");
    // The one other secret CI reads is the 1Click partner key: it moves no money and the live 1Click job needs it on
    // pull requests, where an environment limited to main would hide it.
    const other = jobsOf(text("ci.yml")).flatMap((j) => j.secrets).filter((s) => !KEYS.includes(s));
    expect([...new Set(other)]).toEqual(["ONE_CLICK_API_KEY"]);
  });

  // The season inherits: only then does GitHub give the called drain job the secrets of its own environment (with a
  // list of secrets it read an empty MASK_KEYS in the season's first two rounds). Inheriting hands on the repository's
  // secrets, so none of the keys may ever be one: guard checks that at every run, and no other workflow inherits.
  it("only the season and the jobs inherit, each once and only into the race; the season names no key itself", () => {
    const callers = ["season.yml", "jobs.yml"];
    for (const f of files.filter((f) => !callers.includes(f))) expect(text(f), `${f} hands every secret on`).not.toMatch(/secrets:\s*inherit/);
    for (const f of callers) {
      expect(text(f).match(/secrets:\s*inherit/g), f).toHaveLength(1);
      expect(block(text(f), "race"), f).toMatch(/uses: \.\/\.github\/workflows\/live-race\.yml[\s\S]*secrets: inherit/);
    }
    // The season's own jobs sign with the house's and the scheduler's keys only; the race's keys are named by guard alone.
    for (const j of jobsOf(text("season.yml")).filter((j) => j.name !== "guard")) {
      expect(j.secrets.filter((s) => s !== "HOUSE_KEY" && s !== "SCHEDULER_KEY"), `season.yml/${j.name}`).toEqual([]);
    }
    // The jobs' own jobs sign with the masks' keys and nothing else: the keeper's seed and the minds' payment key are
    // named only by guard, which checks they are not repository secrets.
    for (const j of jobsOf(text("jobs.yml")).filter((j) => j.name !== "guard")) {
      expect(j.secrets.filter((s) => s !== "MASK_KEYS"), `jobs.yml/${j.name}`).toEqual([]);
    }
  });

  // Mainnet's daily round is the house's: the same job, in mainnet's own environment, runs the house's step there and
  // the season's on testnet, and the race takes whichever round opened.
  it("the season's open job runs the house's day on mainnet and the treasury's on testnet, a few minutes after 18:00 UTC", () => {
    const t = text("season.yml");
    // Three starts a day: one GitHub drops does not cost the day, and a run after the round opened sends nothing.
    expect(t).toContain('  schedule:\n    - cron: "4 18 * * *"\n    - cron: "4 19 * * *"\n    - cron: "4 21 * * *"\n  workflow_dispatch:\n');
    const step = (name: string) => {
      const from = t.indexOf(`      - name: ${name}\n`);
      expect(from, name).toBeGreaterThan(0);
      const rest = t.slice(from + 1);
      const end = rest.search(/\n {6}- |\n {2}[a-z][\w-]*:\n/);
      return rest.slice(0, end < 0 ? undefined : end);
    };
    const season = step("Open the season's round that is due");
    expect(season).toContain("        if: ${{ vars.MASKWARS_NETWORK != 'mainnet' && !inputs.house }}\n");
    expect(season).toContain("        run: node packages/race/scripts/season-open.ts");
    expect(season).not.toContain("HOUSE_KEY");
    const house = step("Open the house's round");
    expect(house).toContain("        if: ${{ vars.MASKWARS_NETWORK == 'mainnet' || inputs.house }}\n");
    expect(house).toContain("          HOUSE_KEY: ${{ secrets.HOUSE_KEY }}\n");
    expect(house).toContain("        run: node packages/race/scripts/house-open.ts $ANY_TIME\n");
    // Any hour only for a rehearsal by hand on testnet; on schedule, on the site's tick, and on mainnet always, the
    // slot holds.
    expect(house).toContain("          ANY_TIME: ${{ github.event_name == 'workflow_dispatch' && !inputs.tick && vars.MASKWARS_NETWORK != 'mainnet' && '--any-time' || '' }}\n");
    // The site's clock (apps/web/lib/season.ts) starts the workflow by hand with `tick`; its run is the schedule's run,
    // so it waits for SEASON_LIVE as the schedule does. A run by the owner's hand does not.
    expect(t).toContain("      tick:\n        description: \"Sent by the site's clock: run as the schedule does\"\n        type: boolean\n        default: false\n");
    expect(job("season.yml", "open").cond).toBe("(github.event_name == 'workflow_dispatch' && !inputs.tick) || vars.SEASON_LIVE == 'true'");
    expect(house).not.toContain("SCHEDULER_KEY");
    // The race starts on the round either step opened.
    expect(t).toContain("      bounty: ${{ steps.season.outputs.bounty || steps.house.outputs.bounty }}\n");
    expect(t).toContain("      challenge: ${{ steps.season.outputs.challenge || steps.house.outputs.challenge }}\n");
    expect(job("season.yml", "open").environment).toBe(onNetwork("season"));
    expect(job("season.yml", "open").needs).toEqual(["guard"]);
  });

  // A called workflow reads a secret only if its `workflow_call` names it. Named and not required, the key comes from
  // the job's environment, which wins over anything a caller passes.
  it("the called race names each key so its jobs read it from their environments, and requires none from a caller", () => {
    const t = text("live-race.yml");
    const call = t.slice(t.indexOf("  workflow_call:"), t.indexOf("\nenv:"));
    for (const key of ["MASK_KEYS", "KEEPER_SEED", "OUTLAYER_PAYMENT_KEY", "NEAR_AI_API_KEY"]) expect(call, `live-race.yml names ${key}`).toContain(`      ${key}:\n        required: false\n`);
    // A required key would make every caller hold it where a caller can: as a repository secret.
    expect(call.slice(call.indexOf("    secrets:"))).not.toContain("required: true");
    // The house's key opens the round and goes no further: the race, which runs the models and the sandbox, never
    // names it, so no job of it can read it even from a caller that inherits.
    for (const f of files.filter((f) => f !== "season.yml" && f !== "ci.yml")) expect(text(f), f).not.toContain("HOUSE_KEY");
    expect(text("live-race.yml")).not.toContain("SCHEDULER_KEY");
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
    const jobsHand = job("jobs.yml", "hand");
    expect(jobsHand.environment).toBe("live-race-hand");
    expect(jobsHand.cond).toBe("github.event_name == 'workflow_dispatch'");
    expect(job("jobs.yml", "take").needs).toEqual(["guard", "hand"]);
    expect(job("jobs.yml", "take").cond).toContain("needs.hand.result != 'failure'");
  });

  it("the jobs run on schedule only once the owner turns them on, and race only a round the pass named", () => {
    const t = text("jobs.yml");
    expect(t).toMatch(/schedule:\n(\s+#.*\n)*\s+- cron: "[^"]+"\n\s+workflow_dispatch:/);
    expect(job("jobs.yml", "take").cond).toContain("(github.event_name == 'workflow_dispatch' || vars.JOBS_LIVE == 'true')");
    expect(job("jobs.yml", "race").cond).toBe("${{ !cancelled() && needs.take.outputs.bounty != '' }}");
    // Alongside the race: a reveal window that opens while the race runs is not missed.
    expect(job("jobs.yml", "finish").needs).toEqual(["guard", "take"]);
    expect(t).toMatch(/concurrency:\n\s+group: jobs\n\s+cancel-in-progress: false/);
  });
});
