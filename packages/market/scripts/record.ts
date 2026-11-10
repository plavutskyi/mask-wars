/**
 * Records what the tests stand on, live from market.near.ai: the public answers MASK WARS reads, the API's refusals,
 * and the published schemas of every body we read or send. Needs no token and writes nothing to the marketplace.
 * A builder's display name is replaced; everything else is kept as the API sent it.
 *
 *   pnpm --filter @maskwars/market record
 *
 * Then `pnpm --filter @maskwars/market test`: a test that fails after a fresh recording means the API changed under us.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = process.env["MARKET_ORIGIN"] ?? "https://market.near.ai";
const FIXTURES = fileURLToPath(new URL("../test/fixtures/", import.meta.url));

/** The schemas MASK WARS depends on; everything they reference comes along. */
const ROOTS = [
  "AgentPublic",
  "BrowseAgentsResponse",
  "PricingPlan",
  "PlatformStatsResponse",
  "X402RecipientsResponse",
  "MyAssignmentsResponse",
  "JobAssignment",
  "SubmitRequest",
  "DeclineAssignmentRequest",
  "StartAssignmentResponse",
  "CreateCompetitionRequest",
  "CompetitionResponse",
  "JobView",
  "PatchAgentRequest",
  "CreatePricingPlanRequest",
];

const RECORD: Array<{ name: string; method: string; path: string }> = [
  { name: "platform-stats", method: "GET", path: "/v1/platform/stats" },
  { name: "x402-recipients", method: "GET", path: "/.well-known/x402" },
  { name: "browse-finance", method: "GET", path: "/v1/agents?category=finance&sort=delivered&limit=1" },
  { name: "agent-unknown", method: "GET", path: "/v1/agents/maskwars" },
  { name: "assignments-no-token", method: "GET", path: "/v1/agents/me/assignments" },
  { name: "competition-no-token", method: "POST", path: "/v1/jobs/competition" },
];

function refs(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.add(v.split("/").at(-1) ?? "");
      else refs(v, out);
    }
  }
  return out;
}

/** A builder's display name is a person's name: the recording keeps its place, not the name. */
function redact(body: unknown): unknown {
  if (body && typeof body === "object" && Array.isArray((body as { agents?: unknown }).agents)) {
    for (const a of (body as { agents: Array<{ builder?: { display_name?: string } | null }> }).agents) {
      if (a.builder?.display_name) a.builder.display_name = "(builder)";
    }
  }
  return body;
}

async function get(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(ORIGIN + path, {
    method,
    headers: { accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const recordedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
await mkdir(join(FIXTURES, "recorded"), { recursive: true });

const spec = (await get("GET", "/openapi.json")).body as { info: { version: string }; components: { schemas: Record<string, unknown> } };
const all = spec.components.schemas;
const keep = new Set<string>();
const todo = [...ROOTS];
while (todo.length > 0) {
  const name = todo.pop() as string;
  if (keep.has(name)) continue;
  if (!(name in all)) throw new Error(`the published schema has no ${name}: the API changed`);
  keep.add(name);
  todo.push(...refs(all[name], new Set()));
}
const schemas = Object.fromEntries([...keep].sort().map((n) => [n, all[n]]));
await writeFile(
  join(FIXTURES, "openapi.subset.json"),
  `${JSON.stringify({ source: `${ORIGIN}/openapi.json`, version: spec.info.version, recorded_at: recordedAt, schemas }, null, 2)}\n`,
);
console.log(`openapi.subset.json: ${keep.size} schemas, API ${spec.info.version}`);

for (const r of RECORD) {
  const { status, body: raw } = await get(r.method, r.path);
  const body = redact(raw);
  await writeFile(join(FIXTURES, "recorded", `${r.name}.json`), `${JSON.stringify({ request: `${r.method} ${r.path}`, status, recorded_at: recordedAt, body }, null, 2)}\n`);
  console.log(`recorded/${r.name}.json: ${status}`);
}
