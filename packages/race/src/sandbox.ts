/**
 * The sandbox: every attempt is a fresh `race-runner` process, which starts its own private `neard` on localhost,
 * rebuilds the challenge world from scratch and runs one plan. No state carries over between attempts or agents.
 *
 * The runner is spawned in its own process group, so an abort or a deadline kills it together with its `neard`. It
 * gets only the environment it needs to run (`runnerEnv`): no model key, no mask key, nothing else the job holds.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { CHALLENGES_DIR, type Challenge } from "./challenge.ts";
import { Outcome, localOutcome } from "./outcome.ts";
import type { Plan } from "./plan.ts";

export interface Sandbox {
  /** Runs `plan` against a clean copy of `challenge`. Never rejects: every failure is an outcome. */
  attempt(challenge: Challenge, plan: Plan, signal?: AbortSignal): Promise<Outcome>;
}

export const RUNNER_BIN = join(CHALLENGES_DIR, "target", "release", "race-runner");

/** What `race-runner` and its `neard` read: the system, Rust, the sandbox's own settings, the proxy. Nothing else. */
const RUNNER_VARS =
  /^(PATH|HOME|USER|TMPDIR|TMP|TEMP|LANG|LC_[A-Z]+|TZ|RUST_[A-Z_]+|CARGO_HOME|RUSTUP_HOME|NEAR_SANDBOX_[A-Z_]+|NEAR_ENABLE_SANDBOX_LOG|NEAR_RPC_TIMEOUT_SECS|SANDBOX_ARTIFACT_URL|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS)$/;

/** The environment a runner gets: `env` with every variable it does not need left out, keys and tokens above all. */
export function runnerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && RUNNER_VARS.test(k)));
}

export interface RunnerOptions {
  /** Path to the `race-runner` binary. */
  readonly bin?: string;
  /** Wasm to deploy instead of the challenge's default build (a team's own contract). */
  readonly wasm?: string;
  /** Extra slack on top of the challenge's own `timeout_s` for process start and teardown. */
  readonly graceMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export class RunnerSandbox implements Sandbox {
  readonly #bin: string;
  readonly #wasm: string | undefined;
  readonly #graceMs: number;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: RunnerOptions = {}) {
    this.#bin = options.bin ?? RUNNER_BIN;
    this.#wasm = options.wasm;
    this.#graceMs = options.graceMs ?? 15_000;
    this.#env = runnerEnv(options.env ?? process.env);
  }

  /** True when the runner binary exists. It does not prove `neard` can start here. */
  async available(): Promise<boolean> {
    return access(this.#bin).then(
      () => true,
      () => false,
    );
  }

  attempt(challenge: Challenge, plan: Plan, signal?: AbortSignal): Promise<Outcome> {
    const id = challenge.manifest.id;
    if (signal?.aborted) return Promise.resolve(localOutcome(id, "error", "aborted"));
    // A target of another kind than the default one: the runner builds that kind's world from the same code.
    const args = ["run", challenge.dir, ...(challenge.variant ? ["--variant", challenge.variant] : []), ...(this.#wasm ? ["--wasm", this.#wasm] : [])];
    const deadlineMs = challenge.manifest.limits.timeout_s * 1000 + this.#graceMs;

    return new Promise((resolve) => {
      const child = spawn(this.#bin, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: this.#env });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        killGroup(child.pid);
        resolve(outcome);
      };
      const onAbort = () => finish(localOutcome(id, "error", "aborted"));
      const timer = setTimeout(() => finish(localOutcome(id, "timeout", `runner gave no answer in ${deadlineMs} ms`)), deadlineMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
      child.on("error", (e) => finish(localOutcome(id, "error", `runner did not start: ${e.message}`)));
      child.on("close", (code) => {
        const line = stdout.split("\n").find((l) => l.startsWith("RACE_OUTCOME "));
        if (!line) {
          const tail = stderr.trim().split("\n").slice(-3).join(" | ");
          return finish(localOutcome(id, "error", `runner exited ${code} without an outcome: ${tail}`));
        }
        let raw: unknown;
        try {
          raw = JSON.parse(line.slice("RACE_OUTCOME ".length));
        } catch {
          return finish(localOutcome(id, "error", "runner outcome is not JSON"));
        }
        const parsed = Outcome.safeParse(raw);
        finish(parsed.success ? parsed.data : localOutcome(id, "error", "runner outcome has an unknown shape"));
      });
      child.stdin.on("error", () => {}); // the runner may exit before reading a rejected plan
      child.stdin.end(JSON.stringify(plan));
    });
  }
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}
