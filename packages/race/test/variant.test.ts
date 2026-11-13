/**
 * The vault's kinds (live-safe's `variant`): the masks get the copy of the kind the round's vault is, nothing they are
 * shown names that kind's planted hole, and the daily round's copy is the one it always was.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "@maskwars/mind";
import { describe, expect, it } from "vitest";
import { ModelAttacker, attackPrompt, RULES } from "../src/agent.ts";
import { CHALLENGES_DIR, DEFAULT_VARIANT, listVariants, loadChallenge } from "../src/challenge.ts";
import { vaultInit, type HouseConfig } from "../src/house.ts";
import type { Chain } from "../src/near-tx.ts";
import { localOutcome } from "../src/outcome.ts";
import { Plan } from "../src/plan.ts";
import { runRace } from "../src/race.ts";
import { RunnerSandbox } from "../src/sandbox.ts";
import { roundVariant, vaultVariant, withoutFailed } from "../src/variant.ts";
import { challenge, planText } from "./fixtures.ts";

const DIR = join(CHALLENGES_DIR, "live-safe");
const KINDS = ["limit", "pause"] as const;
const real = new RunnerSandbox();
const ready = await real.available();

describe("the kinds of a challenge", () => {
  it("live-safe has three: the default one and a file for each other", async () => {
    expect(await listVariants(DIR)).toEqual(["owner", "limit", "pause"]);
    expect(await listVariants(join(CHALLENGES_DIR, "open-admin"))).toEqual(["owner"]);
  });

  it("no kind, or the default one, is challenge.json as it was: the daily round's copy names no kind", async () => {
    const plain = await loadChallenge(DIR);
    const named = await loadChallenge(DIR, DEFAULT_VARIANT);
    expect(named).toEqual(plain);
    expect(plain.variant).toBeUndefined();
    expect(plain.manifest.init.args).toEqual({ owner: "alice.test.near", masks: ["attacker.test.near"] });
    expect(plain.manifest.kit).toEqual({});
  });

  it("another kind is the same target, source and accounts, with its kind in new and in the kit", async () => {
    const plain = await loadChallenge(DIR);
    for (const kind of KINDS) {
      const c = await loadChallenge(DIR, kind);
      expect(c.variant).toBe(kind);
      expect(c.source).toEqual(plain.source);
      expect(c.manifest).toEqual({ ...plain.manifest, init: { method: "new", args: { ...plain.manifest.init.args, variant: kind } }, kit: { variant: kind } });
      expect([c.targetId, c.attackerId]).toEqual([plain.targetId, plain.attackerId]);
    }
  });

  it("refuses a kind the target does not have, and a name that is no kind", async () => {
    await expect(loadChallenge(DIR, "vault")).rejects.toThrow("has no kind vault");
    await expect(loadChallenge(DIR, "../open-admin/challenge")).rejects.toThrow("lowercase letters");
    await expect(loadChallenge(join(CHALLENGES_DIR, "open-admin"), "pause")).rejects.toThrow("has no kind pause");
  });
});

describe("what a mask is shown", () => {
  /** The hidden column of the kinds' table: contracts/challenges/live-safe/README.md, which no mask reads. */
  const hidden = () => {
    const rows = readFileSync(join(DIR, "README.md"), "utf8").split("\n").filter((l) => /^\| `(owner|limit|pause)` \|/.test(l));
    return Object.fromEntries(rows.map((r) => r.split("|").map((c) => c.trim())).map((c) => [c[1]!.replaceAll("`", ""), { hole: c[6]!, plan: c[7]! }]));
  };

  it("the kind, as the vault's own view says it, and not a word of that kind's hole", async () => {
    const secret = hidden();
    expect(Object.keys(secret)).toEqual(["owner", "limit", "pause"]);
    for (const kind of KINDS) {
      const c = await loadChallenge(DIR, kind);
      const [system, user] = attackPrompt(c, []);
      expect(system!.content).toBe(RULES);
      const data = JSON.parse(user!.content) as { target: { title: string; source: { path: string; text: string }[] }; public_kit: unknown };
      expect(data.public_kit).toEqual({ variant: kind });
      expect(data.target.title).toBe("Live safe");
      expect(data.target.source.map((f) => f.path)).toEqual(["src/lib.rs"]);
      const shown = `${system!.content}\n${user!.content}`;
      // The README's own sentence about the hole, its plan, and the tests that play it are nowhere in the prompt.
      expect(shown).not.toContain(secret[kind]!.hole.replaceAll("`", ""));
      expect(shown).not.toContain(secret[kind]!.hole);
      expect(shown).not.toContain("the_planted_hole_of_the");
      expect(shown).not.toContain("live-safe/README");
    }
  });

  it("the source names one planted hole, the owner kind's as before, and says the others are not named", async () => {
    const text = (await loadChallenge(DIR)).source[0]!.text;
    const head = text.slice(0, text.indexOf("\nuse near_sdk"));
    expect(head.match(/PLANTED HOLE/g)).toHaveLength(1);
    expect(head).toContain("`set_owner` lets any mask of the round in, but never checks");
    expect(head).toContain("A safe of another kind has a planted hole of its own, and this file does");
    // No comment in the file ties the word to a call of the new desks.
    const about = text.split("\n").filter((l) => /hole|bug|vulnerab|exploit|bypass/i.test(l) && l.trim().startsWith("//"));
    for (const line of about) expect(line).not.toMatch(/request_exit|check_exit|withdraw|claim|book|cash_out|unpause|cleared|paused/);
    // The tests that play the new holes are kept out of the file the masks read.
    expect(text).toContain("mod variants;");
    expect(text).not.toMatch(/fn [a-z_]*(limit|pause)[a-z_]*\(\) \{/);
  });
});

describe("the masks' keys reach every desk", () => {
  it("each call of each kind is a name the keys on a vault are given", () => {
    const text = readFileSync(join(DIR, "src", "lib.rs"), "utf8");
    const desks = ["set_owner", "sweep", "request_exit", "check_exit", "withdraw", "claim", "book", "cash_out", "pause", "unpause"];
    for (const net of ["mainnet", "testnet"]) {
      // The list season-keys.ps1 gives a mask's key on a vault: NEAR refuses any other call of that key.
      const reach = (JSON.parse(readFileSync(join(CHALLENGES_DIR, "..", "..", "scripts", net, "season-args.json"), "utf8")) as { safe_methods: string }).safe_methods.split(", ");
      for (const method of desks) {
        expect(text, method).toMatch(new RegExp(`\\n    pub fn ${method}\\(&mut self`));
        expect(reach, `${net}: ${method}`).toContain(method);
      }
    }
    // And those are all the calls a mask sends a vault: every other `&mut self` method is the bounty contract's, the
    // team's or the vault's own answer to itself.
    const changing = [...text.slice(0, text.indexOf("#[cfg(test)]")).matchAll(/\n    pub fn ([a-z_]+)\(\s*&mut self/g)].map((m) => m[1]!);
    expect(changing.filter((m) => !desks.includes(m)).sort()).toEqual(["arm", "on_bounty", "on_retire", "queue", "reclaim", "retire"]);
  });
});

describe("the sandbox builds the kind's world", () => {
  // The stand-in runner is a shell script: Windows starts no such file, and the runner itself is built for Linux and
  // macOS only (README, "Run it on your machine").
  it.skipIf(process.platform === "win32")("names the kind to the runner, and nothing for the default one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runner-"));
    const bin = join(dir, "race-runner");
    const outcome = { ...localOutcome("live-safe", "held", "ARGS"), steps: [] };
    writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\nprintf 'RACE_OUTCOME %s\\n' "$(printf '%s' '${JSON.stringify(outcome)}' | sed "s|ARGS|$*|")"\n`);
    chmodSync(bin, 0o755);
    const sandbox = new RunnerSandbox({ bin });
    const plan = Plan.parse({ steps: [{ kind: "view", method: "variant" }] });
    expect((await sandbox.attempt(await loadChallenge(DIR), plan)).reason).toBe(`run ${DIR}`);
    expect((await sandbox.attempt(await loadChallenge(DIR, "owner"), plan)).reason).toBe(`run ${DIR}`);
    expect((await sandbox.attempt(await loadChallenge(DIR, "pause"), plan)).reason).toBe(`run ${DIR} --variant pause`);
    expect((await new RunnerSandbox({ bin, wasm: "/tmp/x.wasm" }).attempt(await loadChallenge(DIR, "limit"), plan)).reason).toBe(`run ${DIR} --variant limit --wasm /tmp/x.wasm`);
  });

  describe.skipIf(!ready)("real sandbox", () => {
    for (const kind of KINDS) {
      it(`${kind}: its plan breaks the copy, the plain way out and another kind's plan take nothing`, { timeout: 180_000 }, async () => {
        const c = await challenge("live-safe", kind);
        const other = kind === "limit" ? "live-safe.pause" : "live-safe.limit";
        const [win, miss, wrongKind, ownerPlan] = await Promise.all(
          [`live-safe.${kind}:breach`, `live-safe.${kind}:miss`, `${other}:breach`, "live-safe:breach"].map(async (name) => {
            const [id, which] = name.split(":") as [string, "breach" | "miss"];
            return real.attempt(c, Plan.parse(JSON.parse(await planText(id, which))));
          }),
        );
        expect(win!.verdict, win!.reason).toBe("breach");
        expect(BigInt(win!.stolen)).toBeGreaterThanOrEqual(10n ** 24n);
        for (const held of [miss!, wrongKind!, ownerPlan!]) {
          expect(held.verdict, held.reason).toBe("held");
          expect(held.stolen).toBe("0");
        }
        expect(ownerPlan!.steps.filter((s) => !s.ok).map((s) => s.error).join("\n")).toContain("this safe is of another kind");
      });
    }

    it("a race on the pause kind: the mask that reads the kind's own desk wins, the owner kind's plan does not", { timeout: 240_000 }, async () => {
      const c = await challenge("live-safe", "pause");
      const right = await planText("live-safe.pause", "breach");
      const daily = await planText("live-safe", "breach");
      const result = await runRace({
        challenge: c,
        sandbox: real,
        maxAttempts: 2,
        attackers: [
          new ModelAttacker({ id: "ORACLE", provider: new FakeProvider([daily, daily]), model: "m" }),
          new ModelAttacker({ id: "NOVA", provider: new FakeProvider([daily, right]), model: "m" }),
        ],
      });
      expect(result.winner).toMatchObject({ attacker: "NOVA", attempt: 2 });
      expect(result.finding?.plan.steps.filter((s) => s.kind === "call").map((s) => s.method)).toEqual(["book", "cash_out"]);
    });
  });
});

describe("the kind of a round's vault, from the chain", () => {
  const b64 = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
  /** A chain with one sealed round on `vault.near`, whose `variant` view answers `kind` (or fails as `kind` throws). */
  const chain = (kind: unknown | (() => never), asked: string[] = []): Chain => ({
    async rpc(_method, params) {
      const p = params as { account_id: string; method_name: string; args_base64: string };
      asked.push(`${p.account_id}.${p.method_name}`);
      if (p.method_name === "get_safe") {
        const { id } = JSON.parse(Buffer.from(p.args_base64, "base64").toString()) as { id: string };
        return { result: b64(id === "race-0009" ? { safe: "vault.near", masks: [], min_loot: "1" } : null) };
      }
      if (typeof kind === "function") return (kind as () => never)();
      return { result: b64(kind) };
    },
  });
  const notFound = () => {
    throw new Error("query: CONTRACT_EXECUTION_ERROR wasm execution failed with error: MethodResolveError(MethodNotFound)");
  };

  it("reads the vault's own word", async () => {
    const asked: string[] = [];
    expect(await roundVariant(chain("pause", asked), "bounty.near", "race-0009")).toBe("pause");
    expect(asked).toEqual(["bounty.near.get_safe", "vault.near.variant"]);
    expect(await vaultVariant(chain("limit"), "vault.near")).toBe("limit");
  });

  it("a vault from before kinds has no such view and is of the owner kind", async () => {
    expect(await roundVariant(chain(notFound), "bounty.near", "race-0009")).toBe("owner");
    const old = chain(() => {
      throw new Error("vault.near.variant: wasm execution failed with error: MethodResolveError(MethodNotFound)");
    });
    expect(await vaultVariant(old, "vault.near")).toBe("owner");
  });

  it("no sealed round under that id: nothing to read", async () => {
    expect(await roundVariant(chain("pause"), "bounty.near", "practice-0001")).toBeNull();
  });

  it("a chain that does not say is not taken for an answer", async () => {
    const down = chain(() => {
      throw new TypeError("fetch failed");
    });
    await expect(vaultVariant(down, "vault.near")).rejects.toThrow("fetch failed");
    await expect(vaultVariant(chain({ kind: "pause" }), "vault.near")).rejects.toThrow("not a kind");
    await expect(vaultVariant(chain("PAUSE; drop"), "vault.near")).rejects.toThrow("not a kind");
  });
});

describe("a plan without the calls the sandbox refused", () => {
  const plan = Plan.parse({
    steps: [
      { kind: "view", method: "is_paused" },
      { kind: "call", method: "claim", args: { amount: "1" } },
      { kind: "call", method: "book", args: { amount: "1" } },
      { kind: "call", method: "cash_out" },
    ],
  });
  const report = (oks: boolean[]) => ({ steps: plan.steps.map((s, index) => ({ index, method: s.method, ok: oks[index]! })) });

  it("drops them and keeps the order of the rest", () => {
    expect(withoutFailed(plan, report([true, false, true, true])).steps.map((s) => s.method)).toEqual(["is_paused", "book", "cash_out"]);
  });

  it("leaves a plan played whole as it is, the same object", () => {
    expect(withoutFailed(plan, report([true, true, true, true]))).toBe(plan);
  });

  it("changes nothing without a replay of this very plan", () => {
    expect(withoutFailed(plan, null)).toBe(plan);
    expect(withoutFailed(plan, undefined)).toBe(plan);
    expect(withoutFailed(plan, { steps: [] })).toBe(plan);
    expect(withoutFailed(plan, { steps: "none" } as never)).toBe(plan);
    const other = report([true, false, true, true]);
    other.steps[2]!.method = "sweep";
    expect(withoutFailed(plan, other)).toBe(plan);
    // Every call refused: there is no plan in what is left, so the plan stays whole and the chain refuses it.
    expect(withoutFailed(plan, report([true, false, false, false]))).toBe(plan);
  });
});

describe("the house's day", () => {
  it("makes its vault with no kind named: the owner kind, as every day so far", () => {
    const cfg = { vault: "vault.house.near", masks: ["a.near"], bounty: "bounty.near", house: "house.near" } as unknown as HouseConfig;
    expect(vaultInit(cfg, ["guest.near"])).toEqual({ owner: "vault.house.near", masks: ["a.near", "guest.near"], arbiter: "bounty.near", team: "house.near" });
    expect(Object.keys(vaultInit(cfg))).not.toContain("variant");
  });
});
