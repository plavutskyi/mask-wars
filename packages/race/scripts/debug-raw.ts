/**
 * The raw shape of one model answer for a target: finish reason, token counts and which fields carry text. For telling
 * "the model ran out of tokens while reasoning" from "the provider changed its answer". Needs NEAR_AI_API_KEY in .env.
 *
 *   node scripts/debug-raw.ts live-safe 4000
 */
import { join } from "node:path";
import { TEE_MODELS } from "@maskwars/mind";
import { attackPrompt } from "../src/agent.ts";
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
const maxTokens = Number(process.argv[3] ?? 4000);
const messages = attackPrompt(challenge, []);
console.log(`prompt: ${JSON.stringify(messages).length} characters, max_tokens ${maxTokens}`);
await Promise.all(
  Object.keys(TEE_MODELS).map(async (model) => {
    const started = Date.now();
    const res = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, temperature: 0.4 }),
      signal: AbortSignal.timeout(280_000),
    }).catch((e: Error) => e);
    const took = `${((Date.now() - started) / 1000).toFixed(0)} s`;
    if (res instanceof Error) return console.log(`${model} (${took}): ${res.message}`);
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return console.log(`${model} (${took}): HTTP ${res.status}, not JSON: ${text.slice(0, 160)}`);
    }
    const choice = body.choices?.[0];
    const message = choice?.message ?? {};
    const fields = Object.entries(message).map(([k, v]) => `${k}:${typeof v === "string" ? `${v.length} chars` : v === null ? "null" : typeof v}`);
    console.log(`${model} (${took}): HTTP ${res.status}, finish ${choice?.finish_reason}, usage ${JSON.stringify(body.usage)}, message {${fields.join(", ")}}${body.error ? `, error ${JSON.stringify(body.error).slice(0, 200)}` : ""}`);
  }),
);
