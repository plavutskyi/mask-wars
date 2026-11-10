/** Builds `race-runner` (release) and the training targets' wasm with cargo. Needs Rust 1.97 and the wasm target. */
import { spawn } from "node:child_process";
import { CHALLENGES_DIR } from "./challenge.ts";
import { RUNNER_BIN } from "./sandbox.ts";

export async function buildRunner(options: { log?: (line: string) => void } = {}): Promise<string> {
  const log = options.log ?? (() => {});
  log("cargo build --release -p race-runner");
  await run("cargo", ["build", "--release", "-p", "race-runner"]);
  log("race-runner build (training targets → wasm)");
  await run(RUNNER_BIN, ["build"]);
  return RUNNER_BIN;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: CHALLENGES_DIR, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}
