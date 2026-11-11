// A track for a film from its plan: ElevenLabs Music with a composition plan, so every section lasts exactly what the
// cut needs. The key is the owner's, read from ELEVENLABS_API_KEY and never printed.
//
//   node scripts/music.mjs audio/promo-150.plan.json audio/promo-150.mp3 [--seed 7]
//
// On Windows the owner keeps the key in his user environment; a shell started before he set it does not see it:
//   $env:ELEVENLABS_API_KEY = [Environment]::GetEnvironmentVariable('ELEVENLABS_API_KEY','User'); node scripts/music.mjs …
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const [planFile, out] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--seed");
if (!planFile || !out) {
  console.error("usage: music <plan.json> <out.mp3> [--seed n]");
  process.exit(2);
}
const key = (process.env.ELEVENLABS_API_KEY ?? "").trim();
if (!key.startsWith("sk_")) {
  console.error("ELEVENLABS_API_KEY is not set to an API key (it starts with sk_)");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(resolve(planFile), "utf8"));
const seed = argv.includes("--seed") ? Number(argv[argv.indexOf("--seed") + 1]) : undefined;
const body = { ...plan, ...(seed !== undefined ? { seed } : {}) };
const total = (plan.composition_plan?.chunks ?? plan.composition_plan?.sections ?? []).reduce((s, c) => s + c.duration_ms, 0);
console.log(`asking for ${(total / 1000).toFixed(1)} s with ${plan.model_id}`);
const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_48000_192", {
  method: "POST",
  headers: { "xi-api-key": key, "content-type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(600_000),
});
if (!res.ok) {
  console.error(`ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const file = resolve(out);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, Buffer.from(await res.arrayBuffer()));
console.log(file);
