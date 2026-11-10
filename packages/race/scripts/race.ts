/**
 * Live race with models on NEAR AI Cloud:
 *
 *   pnpm --filter @maskwars/race race <challenge> [--attempts 5]
 *
 * Needs `NEAR_AI_API_KEY` (or `NEARAI_CLOUD_API_KEY`) in the environment or in the repo's `.env`, and a built runner
 * (`pnpm --filter @maskwars/race build:runner`). One agent per Private TEE model, all on the same target. Prints the
 * public board as it fills, then the winner. The winning plan is written only to `--finding <file>` if asked;
 * `--result <file>` gets the public outcome (`{"winner":"NOVA"}` or `{"winner":null}`) for the bounty judge.
 *
 * The people's masks the keeper armed for the round (`HUMAN_MASKS`, from the `arm` job of `Live race`) race beside
 * ours: each thinks on OutLayer in its own mind's TEE (src/brain.ts), where its owner's strategy opens and nowhere else.
 * That needs `OUTLAYER_PAYMENT_KEY` and the round's id in `BOUNTY`. `--costs <file>` gets the round and what each one's
 * mind spent in it, for the keeper to settle (`{"bounty":"human-0001","costs":{"kira.masks.…":{"usd":0.0021,"calls":5}}}`).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NearAiProvider, TEE_MODELS } from "@maskwars/mind";
import { NET } from "@maskwars/network";
import { ModelAttacker, type Attacker } from "../src/agent.ts";
import { BrainAttacker, humanMasksFrom } from "../src/brain.ts";
import type { CostsFile } from "../src/keeper.ts";
import { CHALLENGES_DIR, listChallenges, loadChallenge } from "../src/challenge.ts";
import { formatEntry, formatJournal } from "../src/journal.ts";
import { nearString } from "../src/outcome.ts";
import { runRace } from "../src/race.ts";
import { RunnerSandbox } from "../src/sandbox.ts";

try {
  process.loadEnvFile(join(CHALLENGES_DIR, "..", "..", ".env"));
} catch {
  // no .env: environment only
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const id = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const ids = await listChallenges();
if (!id || !ids.includes(id)) {
  console.error(`usage: race <challenge> [--attempts N] [--finding file] [--result file]\nchallenges: ${ids.join(", ")}`);
  process.exit(2);
}
const apiKey = process.env.NEAR_AI_API_KEY || process.env.NEARAI_CLOUD_API_KEY;
if (!apiKey) {
  console.error("no NEAR AI key: set NEAR_AI_API_KEY in .env");
  process.exit(2);
}
const sandbox = new RunnerSandbox();
if (!(await sandbox.available())) {
  console.error("runner not built: pnpm --filter @maskwars/race build:runner");
  process.exit(2);
}

const provider = new NearAiProvider({ apiKey });
const masks = ["ONYX", "NOVA", "ORACLE"];
const attackers: Attacker[] = Object.keys(TEE_MODELS).map((model, i) => new ModelAttacker({ id: masks[i] ?? model, provider, model }));
const challenge = await loadChallenge(join(CHALLENGES_DIR, id));

// The people's masks of this round, each with its own mind in its own TEE.
const humans = humanMasksFrom(process.env.HUMAN_MASKS);
const minds: BrainAttacker[] = [];
if (humans.length > 0) {
  const paymentKey = process.env.OUTLAYER_PAYMENT_KEY ?? "";
  const round = process.env.BOUNTY ?? "";
  if (!paymentKey || !round) {
    console.error("the people's masks race only with OUTLAYER_PAYMENT_KEY and the round's id in BOUNTY");
    process.exit(2);
  }
  for (const h of humans) {
    const mind = new BrainAttacker({
      id: h.name.toUpperCase(),
      mask: h.account,
      round,
      model: h.model,
      project: process.env.BRAIN_PROJECT || `${NET.admin}/brain`,
      paymentKey,
      api: process.env.OUTLAYER_API || NET.outlayer.api,
      // Why an attempt of a mind gave no plan: out of time, out of tokens, no plan, refused, unreachable.
      log: (line) => console.log(line),
    });
    minds.push(mind);
    attackers.push(mind);
  }
}
const attempts = Number(flag("--attempts") ?? 5);

console.log(`${challenge.manifest.title} · ${attackers.map((a) => a.id).join(" vs ")} · ${attempts} attempts each\n`);
const result = await runRace({
  challenge,
  attackers,
  sandbox,
  maxAttempts: attempts,
  onEntry: (e) => console.log(`${e.attacker.padEnd(7)} ${formatEntry(e)}`),
});

console.log(`\n${formatJournal(result.journal).join("\n")}\n`);
if (result.winner) {
  console.log(`${result.winner.attacker} broke the vault on attempt ${result.winner.attempt}: ${nearString(result.winner.stolen)}`);
} else {
  console.log("vault held");
}
const out = flag("--finding");
if (out && result.finding) await writeFile(out, JSON.stringify(result.finding, null, 2));
const costs = flag("--costs");
if (costs) {
  const spent = Object.fromEntries(minds.map((m) => [m.mask, { usd: m.spent.usd, calls: m.spent.calls }]));
  const file: CostsFile = { bounty: process.env.BOUNTY ?? "", costs: spent };
  await writeFile(costs, JSON.stringify(file, null, 2));
  for (const m of minds) {
    const stops = Object.entries(m.stops)
      .filter(([, n]) => n > 0)
      .map(([stop, n]) => `${stop} ${n}`);
    console.log(`${m.id.padEnd(7)} mind: asked ${m.asked}, ${m.spent.calls} answers counted, $${m.spent.usd.toFixed(5)}${stops.length ? `; ${stops.join(", ")}` : ""}`);
  }
}
const resultFile = flag("--result");
if (resultFile) await writeFile(resultFile, JSON.stringify({ winner: result.winner?.attacker ?? null }));
