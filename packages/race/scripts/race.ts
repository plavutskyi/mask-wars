/**
 * Live race with models on NEAR AI Cloud:
 *
 *   pnpm --filter @maskwars/race race <challenge> [--attempts 5] [--variant limit]
 *
 * `--variant <kind>` (or `VARIANT`) races the target as another of its kinds: the same code and source, the world of
 * `challenge.<kind>.json` (live-safe: `owner`, the default, `limit`, `pause`). With a round's id in `BOUNTY` the kind is
 * read from the round's vault on chain (src/variant.ts), so the masks always race the copy of the vault they will
 * play; a kind named by hand that the chain contradicts stops the race before any model is asked. A chain that does
 * not answer changes nothing: the race runs the kind named, or the default.
 *
 * Needs `NEAR_AI_API_KEY` (or `NEARAI_CLOUD_API_KEY`) in the environment or in the repo's `.env`, and a built runner
 * (`pnpm --filter @maskwars/race build:runner`). One agent per mask of the arena, each with its own Private TEE model
 * (`ARENA_MODELS`), all on the same target. Prints the public board as it fills, then the winner. The winning plan is
 * written only to `--finding <file>` if asked; `--result <file>` gets the public outcome (`{"winner":"NOVA"}` or
 * `{"winner":null}`) for the bounty judge. `--minds <file>` gets the race's tab of its minds (src/minds.ts, `MindTab`):
 * every answer each mask's mind got, with its id on NEAR AI's bill; it needs the race's id in `BOUNTY`. The tab waits for
 * the calls still on their way when the race ends (each up to its 300 s deadline), and the script ends only after it, so
 * the seal that follows this step can wait that long. It asks nothing of the network: scripts/minds.ts prices it later.
 *
 * As the race begins, each of our models is attested with a fresh nonce beside it (src/minds.ts, `trustAttested`): the
 * nodes that pass become the signers each answer's TEE signature is checked against, and the tab says which answers
 * passed. A model whose attestation does not pass races all the same; its answers count as not verified.
 *
 * The people's masks the keeper armed for the round (`HUMAN_MASKS`, from the `arm` job of `Live race`) race beside
 * ours: each thinks on OutLayer in its own mind's TEE (src/brain.ts), where its owner's strategy opens and nowhere else.
 * That needs `OUTLAYER_PAYMENT_KEY` and the round's id in `BOUNTY`. `--costs <file>` gets the round and what each one's
 * mind spent in it, for the keeper to settle (`{"bounty":"human-0001","costs":{"kira.masks.…":{"usd":0.0021,"calls":5}}}`).
 *
 * With `OUTLAYER_PAYMENT_KEY` set, the run ends with what is left on that key (src/payment-key.ts), in the log and the
 * job's summary, and a warning with the owner's top-up step when it runs low. Nothing tops it up by itself.
 */
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARENA_MODELS, NearAiProvider } from "@maskwars/mind";
import { NET } from "@maskwars/network";
import { ModelAttacker, type Attacker } from "../src/agent.ts";
import { trustAttested, type MindTab } from "../src/minds.ts";
import { BrainAttacker, humanMasksFrom } from "../src/brain.ts";
import type { CostsFile } from "../src/keeper.ts";
import { CHALLENGES_DIR, DEFAULT_VARIANT, listChallenges, listVariants, loadChallenge } from "../src/challenge.ts";
import { JsonRpc } from "../src/near-tx.ts";
import { roundVariant } from "../src/variant.ts";
import { formatEntry, formatJournal } from "../src/journal.ts";
import { nearString } from "../src/outcome.ts";
import { keyRef, keyReport, readKeyBalance } from "../src/payment-key.ts";
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
  console.error(`usage: race <challenge> [--attempts N] [--variant kind] [--finding file] [--result file]\nchallenges: ${ids.join(", ")}`);
  process.exit(2);
}
// The target's kind: named by hand, or the default one. A name that is no kind of this target stops here.
const named = (flag("--variant") ?? process.env.VARIANT ?? "").trim() || undefined;
const kinds = await listVariants(join(CHALLENGES_DIR, id));
if (named !== undefined && !kinds.includes(named)) {
  console.error(`${id} has no kind ${JSON.stringify(named)}: ${kinds.join(", ")}`);
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
// The models' attestation with a fresh nonce, beside the race: a model's first answer takes far longer than it.
const attested = trustAttested(provider, Object.values(ARENA_MODELS), { apiKey, log: (line) => console.log(`attestation: ${line}`) }).catch((e: Error) => {
  console.log(`attestation: ${e.message}: no answer counts as verified`);
  return {} as Record<string, number>;
});
const own = Object.entries(ARENA_MODELS).map(([id, model]) => new ModelAttacker({ id, provider, model }));
const attackers: Attacker[] = [...own];

// A round on chain: its vault says which kind it is, and that is the copy the masks race. Only a target with kinds
// asks, with a few seconds for the answer; without one the race goes on as named.
let variant = named;
if (kinds.length > 1 && process.env.BOUNTY) {
  const onChain = await roundVariant(new JsonRpc(process.env.NEAR_RPC || NET.rpc[0]!, 8_000), process.env.BOUNTY_CONTRACT || NET.bounty, process.env.BOUNTY).catch((e: Error) => {
    console.log(`the vault's kind: the chain did not say (${e.message}); racing ${named ?? DEFAULT_VARIANT}`);
    return null;
  });
  if (onChain !== null && named !== undefined && onChain !== named) {
    console.error(`the vault of ${process.env.BOUNTY} is of the ${onChain} kind, and the race was asked for ${named}: nothing raced`);
    process.exit(2);
  }
  if (onChain !== null && !kinds.includes(onChain)) {
    console.error(`the vault of ${process.env.BOUNTY} is of the ${onChain} kind, which this checkout has no copy of (${kinds.join(", ")}): nothing raced`);
    process.exit(2);
  }
  if (onChain !== null) variant = onChain;
}
const challenge = await loadChallenge(join(CHALLENGES_DIR, id), variant);
if (challenge.variant) console.log(`the vault's kind: ${challenge.variant}`);

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

// What the minds cost in this race. A race is over the moment one mask wins; the calls of the others still on their way
// are answered and paid for all the same, so the record waits for them (each up to its own deadline, 300 s).
await attested;
const mindsFile = flag("--minds");
const race = process.env.BOUNTY ?? "";
if (mindsFile && race) {
  await Promise.all(own.map((m) => m.idle()));
  for (const m of own) {
    const verified = m.answers.filter((a) => a.verified).length;
    console.log(`${m.id.padEnd(7)} mind: ${m.answers.length} answers, ${verified} with a TEE signature checked against the race's attestation`);
  }
  const accounts: Readonly<Record<string, string>> = NET.masks;
  const tab: MindTab = {
    network: NET.id,
    race,
    own: own.flatMap((m) => (accounts[m.id] ? [{ name: m.id, account: accounts[m.id]!, model: m.model, answers: m.answers, unanswered: m.unanswered }] : [])),
    people: minds.map((m) => ({
      name: m.id,
      account: m.mask,
      model: m.model,
      calls: m.spent.calls,
      unanswered: m.stops["out-of-time"] + m.stops.refused + m.stops.unreachable,
      usd: m.spent.usd,
      tokens: m.spent.tokens,
    })),
  };
  await writeFile(mindsFile, JSON.stringify(tab));
}

// The day's report on the key that pays the people's minds: what is left on it, and the owner's step when it runs low.
// It is read by the key's owner and number only; nothing tops it up but the owner, by hand.
const payKey = (process.env.OUTLAYER_PAYMENT_KEY ?? "").trim();
if (payKey) {
  const ref = keyRef(payKey);
  const balance = ref ? await readKeyBalance(process.env.OUTLAYER_API || NET.outlayer.api, ref) : null;
  const report = keyReport(ref, balance);
  console.log(report.lines.join("\n"));
  if (process.env.GITHUB_ACTIONS === "true" && report.low) console.log(`::warning::${report.lines[0]!.replace(/^- /, "")}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report.lines.join("\n")}\n`);
}
