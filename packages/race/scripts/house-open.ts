/**
 * The house's daily step (src/house.ts): ends yesterday's round on the bounty contract, retires the vault so its NEAR
 * comes home, makes the vault again in one transaction that adds no key, and opens today's sealed round on it. The
 * race on that round is the next job. Every part reads the chain first and repeats nothing, so a run that died is
 * simply started again.
 *
 *   HOUSE_KEY=ed25519:… node scripts/house-open.ts
 *
 * `HOUSE_KEY` is a full key of the house's own account and of nothing else: a secret of the GitHub environment
 * `season-mainnet` (`season` on testnet), never of the repository. With it this script signs the day's transactions
 * without asking, so it is only ever set where the owner decided the house runs on its own. Whoever holds it can spend
 * what the house holds; it has no say over the bounty contract, the masks, or the vault while a round is on.
 *
 * Without `HOUSE_KEY` nothing is signed. The script says which steps wait for a signature (the owner sends them by
 * hand: retire.ps1, which also sends the masks' winnings home, safe-deploy.ps1 -House, open-safe.ps1 -House in
 * scripts/testnet) and exits 0: a day opened by hand is not a failed run. A round that is already open and still
 * sealing, opened by hand or by an earlier run, is handed to the race either way.
 *
 * Writes `bounty` and `challenge` to $GITHUB_OUTPUT when a round is open for the race. With a key it exits 1 when the
 * day is skipped (yesterday's round is not over, the house cannot pay, the bounty contract does not know the vault's
 * code) or when a step failed: the show must not stop quietly.
 *
 * The network is MASKWARS_NETWORK (packages/network): the house, the vault, the sums, the limits and the vault's code
 * hash (`safe_code`) all come from there, and the judge from scripts/<network>/judge-args.json. The vault's wasm is
 * the file in apps/web/public/contracts whose name ends in its sha256, or `SAFE_WASM` (`--wasm <file>`); whichever it
 * is, it is deployed only if it hashes to `safe_code` and the bounty contract lists that code.
 *
 * For the owner's scripts:
 *   --plan [--args-dir <dir>]   the steps that are left, as JSON, each with what near.exe needs; signs nothing, and
 *                               leaves the choice of the time to the owner
 *   --sample                    with --plan: an ordinary day's steps from the network's file alone, nothing read
 *                               from the chain (a dry run)
 *   --any-time                  with a key: open now, whatever the slot
 *   HOUSE_SKIP_HOME=<a,b>       with --plan: masks the owner's script already called home() on this run, left out
 * Optional: `NEAR_RPC`, one endpoint in place of the network's own, which are asked in order when one is down.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeHashHex, NET } from "@maskwars/network";
import { daySummary, houseConfig, planDay, readHouse, roundArgs, runDay, STEP_GAS, stepText, stepTx, vaultInit, wasmInfo, type DayPlan, type DayStep } from "../src/house.ts";
import { FailoverRpc, JsonRpc, NearKey } from "../src/near-tx.ts";

const fail = (why: string): never => {
  console.error(why);
  process.exit(1);
};
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

/** yoctoNEAR as NEAR, cut to the thousandth, for a line the owner reads. */
const near = (y: bigint) => `${y / 10n ** 24n}.${(y % 10n ** 24n).toString().padStart(24, "0").slice(0, 3)} NEAR`;
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const judge = JSON.parse(await readFile(join(REPO, "scripts", NET.id, "judge-args.json"), "utf8")) as { version?: string };
if (!judge.version || !/^[0-9a-f]{64}$/.test(judge.version)) fail(`scripts/${NET.id}/judge-args.json: the judge's version, a sha256 in hex`);
const cfg = houseConfig(NET, judge.version!);

/** The vault's wasm: the file named, or the one in apps/web/public/contracts whose name ends in the code's sha256. */
async function findWasm(): Promise<{ path: string; bytes: Buffer } | null> {
  const named = option("--wasm") ?? process.env.SAFE_WASM;
  if (named) return { path: named, bytes: await readFile(named).catch(() => fail(`${named}: the safe's wasm is not there`)) };
  const hex = cfg.safeCode ? codeHashHex(cfg.safeCode) : null;
  if (!hex) return null;
  const dir = join(REPO, "apps", "web", "public", "contracts");
  const file = (await readdir(dir).catch(() => [] as string[])).find((f) => f.endsWith(`${hex}.wasm`));
  return file ? { path: join(dir, file), bytes: await readFile(join(dir, file)) } : null;
}
const wasm = await findWasm();
// The workflow deploys only the file the repository carries: without it the day says so and no vault is made. On
// stderr, so that --plan still prints its JSON alone.
if (!wasm && cfg.safeCode) {
  console.error(`apps/web/public/contracts holds no ${codeHashHex(cfg.safeCode)}.wasm, the vault's code ${cfg.safeCode}: no vault can be made`);
}
// Every endpoint of the network, the first preferred: a node that is down does not cost the day.
const chain = new FailoverRpc((process.env.NEAR_RPC ? [process.env.NEAR_RPC] : NET.rpc).map((url) => new JsonRpc(url)));

if (flag("--plan")) {
  // For the owner's scripts: what is left, each step with what near.exe needs to send it. Nothing is signed here.
  const sample = flag("--sample");
  const state = sample ? null : await readHouse(chain, cfg).catch((e: Error) => fail(`the chain did not answer: ${e.message}`));
  const plan: DayPlan = state
    ? planDay(state, cfg, { wasm: wasm ? wasmInfo(wasm.bytes) : null, anyTime: true, skipHome: (process.env.HOUSE_SKIP_HOME ?? "").split(",").filter((m) => m) })
    : { kind: "steps", steps: [{ kind: "retire" }, { kind: "create" }, { kind: "open", id: "race-0000" }], note: "a dry run: the steps of an ordinary day; a real run reads the chain and takes the first free id" };
  // What stands on the vault's name: nothing, a safe armed for a round, or a safe no round was opened on.
  const vault = !state ? "armed" : !state.vault ? "none" : state.vault.safe?.lock ? "armed" : "idle";
  const dir = option("--args-dir");
  if (dir) await mkdir(dir, { recursive: true });
  const tgas = (n: number) => `${n}.0 Tgas`;
  const steps = plan.kind !== "steps" ? [] : await Promise.all(plan.steps.map(async (step: DayStep, i) => {
    const args = step.kind === "create" ? vaultInit(cfg) : step.kind === "open" ? roundArgs(cfg, step.id) : step.kind === "retire" || step.kind === "home" ? {} : step.kind === "unstick" ? { id: step.id, claim: String(step.claim) } : { id: step.id };
    const file = dir ? join(dir, `house-${i + 1}-${step.kind}-args.json`) : null;
    if (file) await writeFile(file, JSON.stringify(args));
    return {
      kind: step.kind,
      text: stepText(step, cfg),
      receiver: step.kind === "create" ? cfg.vault : stepTx(step, cfg).receiver,
      method: step.kind === "create" ? "new" : step.kind === "open" ? "open_safe" : step.kind,
      args,
      args_file: file,
      gas: tgas(step.kind === "create" ? STEP_GAS.new : STEP_GAS[step.kind]),
      // The network's own figures, to the last digit: what near.exe is told is what packages/network says.
      deposit: `${step.kind === "open" ? NET.round.deposit : "0"} NEAR`,
      ...(step.kind === "create" ? { near: `${NET.round.safe} NEAR`, wasm: wasm?.path ?? null, wasm_sha256: cfg.safeCode ? codeHashHex(cfg.safeCode) : null } : {}),
      ...(step.kind === "open" ? { id: step.id } : {}),
      ...(step.kind === "home" ? { mask: step.mask } : {}),
    };
  }));
  console.log(JSON.stringify({
    network: NET.id,
    house: cfg.house,
    vault: cfg.vault,
    bounty: cfg.bounty,
    vault_on_chain: vault,
    house_free: state?.house ? near(state.house.free) : null,
    kind: plan.kind,
    why: "why" in plan ? plan.why : null,
    stop: plan.kind === "steps" ? plan.stop ?? null : null,
    note: plan.kind === "steps" ? plan.note ?? null : null,
    round: plan.kind === "race" ? { id: plan.round.id, safe: plan.round.safe, challenge: plan.round.challenge } : null,
    steps,
  }));
} else {
  process.exitCode = await theDay();
}
// Either way the process ends on its own, with that code. Not process.exit: on Windows (where the owner's scripts run
// --plan), Node 24 trips an assertion in libuv when it exits that way with fetch's sockets open, and dies with another.

/** The day, run with the house's key if there is one; the exit code. */
async function theDay(): Promise<number> {
  const secret = (process.env.HOUSE_KEY ?? "").trim();
  // The line that tells GitHub to hide the key in the job's log, and only there: anywhere else it would print the key.
  if (secret && process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${secret}`);
  const key = secret
    ? (() => {
        try {
          return new NearKey(secret);
        } catch (e) {
          return fail(`HOUSE_KEY: ${(e as Error).message}`);
        }
      })()
    : undefined;

  const day = await runDay({ chain, config: cfg, key, wasm: wasm?.bytes ?? null, anyTime: flag("--any-time"), log: (line) => console.log(line) }).catch((e: Error) => fail(e.message));

  const summary = daySummary(day, cfg);
  if (day.kind === "unsigned") {
    summary.push(
      "",
      `\`HOUSE_KEY\` is not set in this job's environment, so nothing was signed. The owner sends these by hand from scripts/testnet with \`-Network ${NET.id}\`: \`retire.ps1\`, \`safe-deploy.ps1 -House\`, \`open-safe.ps1 -House\`; this workflow then races the round it finds open.`,
    );
  }
  console.log(summary.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);

  if (day.kind === "opened" || day.kind === "open") {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `bounty=${day.round.id}\nchallenge=${day.round.challenge}\n`);
    return 0;
  }
  // Without a key the day is the owner's to open: nothing here failed. With one, a skipped day turns the run red.
  return day.kind === "skipped" && key ? 1 : 0;
}
