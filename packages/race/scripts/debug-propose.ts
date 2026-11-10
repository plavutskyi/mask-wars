/**
 * What each mask proposes for a target on its first try, with no sandbox: the plan's steps, or why the reply was not a
 * plan. For finding out why a race ends with "vault held". Needs NEAR_AI_API_KEY in .env.
 *
 *   node scripts/debug-propose.ts live-safe
 */
import { join } from "node:path";
import { NearAiProvider, TEE_MODELS } from "@maskwars/mind";
import { ModelAttacker } from "../src/agent.ts";
import { CHALLENGES_DIR, loadChallenge } from "../src/challenge.ts";

try {
  process.loadEnvFile(join(CHALLENGES_DIR, "..", "..", ".env"));
} catch {
  // no .env: the key may come from the environment
}
const apiKey = process.env.NEAR_AI_API_KEY ?? "";
if (!apiKey) {
  console.error("no NEAR AI key: set NEAR_AI_API_KEY in .env");
  process.exit(2);
}
const challenge = await loadChallenge(join(CHALLENGES_DIR, process.argv[2] ?? "live-safe"));
const provider = new NearAiProvider({ apiKey });
const masks = ["ONYX", "NOVA", "ORACLE"];
await Promise.all(
  Object.keys(TEE_MODELS).map(async (model, i) => {
    const started = Date.now();
    const plan = await new ModelAttacker({ id: masks[i] ?? model, provider, model }).propose(challenge, []);
    const took = `${((Date.now() - started) / 1000).toFixed(0)} s`;
    if (!plan.ok) {
      console.log(`${masks[i]} (${model}, ${took}): NOT A PLAN: ${plan.error}`);
      return;
    }
    console.log(`${masks[i]} (${model}, ${took}):`);
    for (const s of plan.plan.steps) console.log(`  ${JSON.stringify(s)}`);
  }),
);
