/**
 * Records what the tests stand on, live: from market.near.ai the public answers MASK WARS reads, the API's refusals,
 * the published schemas of every body we read or send, and one unpaid price quote (the 402) of a live agent; from
 * NEAR RPC what MASK CHECK reads about the accounts the paid-call tests ask for. Needs no token, pays nothing and
 * writes nothing to the marketplace. A builder's display name is replaced; everything else is kept as it was sent.
 *
 *   pnpm --filter @maskwars/market record
 *
 * Then `pnpm --filter @maskwars/market test`: a test that fails after a fresh recording means the API changed under us.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Network, maskCheck, readerFor, sharedLists } from "@maskwars/check";
import { type Exchange, type Recording, bodyOf, keyOf } from "../../check/test/replay.ts";

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

// --- One unpaid quote of a live agent: the marketplace's own 402, next to the plan it was priced from ---------------

/** The agent's own host: the handle as a subdomain of the marketplace. */
const hostOf = (handle: string) => `https://${handle}.${new URL(ORIGIN).host}`;

interface Row {
  agent_id: string;
  handle: string;
  runtime: string;
  available_now?: boolean | null;
  sla_seconds: number;
}

const browse = (await get("GET", "/v1/agents?sort=delivered&limit=20")).body as { agents: Row[] };
const quoted = browse.agents.find((a) => a.runtime === "http" && a.available_now === true && /^[a-z][a-z0-9-]{2,29}$/.test(a.handle));
if (!quoted) throw new Error("no self-hosted agent is taking calls right now: nothing to quote");
const plans = (await get("GET", `/v1/agents/${quoted.agent_id}/pricing-plans`)).body as Array<{ is_default: boolean; price_amount: string; sla_seconds: number | null }>;
const plan = plans.find((x) => x.is_default);
if (!plan) throw new Error(`${quoted.handle} has no default plan`);
const ask = { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: "Price check" }] }, configuration: { historyLength: 0 } } };
const quote = await fetch(`${hostOf(quoted.handle)}/a2a/v1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ask), signal: AbortSignal.timeout(20_000) });
await writeFile(
  join(FIXTURES, "recorded", "quote-live.json"),
  `${JSON.stringify(
    {
      request: `POST ${hostOf(quoted.handle)}/a2a/v1 SendMessage, no X-PAYMENT header`,
      status: quote.status,
      recorded_at: recordedAt,
      agent: { handle: quoted.handle, sla_seconds: quoted.sla_seconds },
      plan: { price_amount: plan.price_amount, sla_seconds: plan.sla_seconds },
      body: await quote.json(),
    },
    null,
    2,
  )}\n`,
);
console.log(`recorded/quote-live.json: ${quote.status} from ${quoted.handle}`);

// --- What NEAR RPC answers MASK CHECK about the accounts of the paid-call tests --------------------------------------

/** The arena's drained safe and NEAR Intents on mainnet; the old arena's drained safe on testnet. */
const ACCOUNTS: Record<Network, string[]> = {
  mainnet: ["safe-0001.maskwars.near", "intents.near"],
  testnet: ["safe-0001.tinygif8324.testnet"],
};

const HEADER_KEYS = ["height", "prev_height", "hash", "prev_hash", "timestamp", "timestamp_nanosec", "epoch_id"];

/** A block answer keeps the header fields the reader reads; its chunks are dropped. */
function trim(method: string, response: unknown): unknown {
  const r = response as { result?: { header?: Record<string, unknown>; author?: unknown } } | null;
  const header = r?.result?.header;
  if (method !== "block" || !r?.result || !header) return response;
  return { ...r, result: { author: r.result.author, header: Object.fromEntries(HEADER_KEYS.filter((k) => k in header).map((k) => [k, header[k]])), chunks: [] } };
}

async function recordCheck(network: Network): Promise<Recording> {
  const kept = new Map<string, Exchange>();
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const { method, params } = bodyOf(init);
    const key = keyOf(url, method, params);
    let e = kept.get(key);
    if (!e) {
      let res = await fetch(input, init);
      for (let attempt = 0; attempt < 3 && (res.status === 429 || res.status >= 500); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
        res = await fetch(input, init);
      }
      const text = await res.text();
      let response: unknown = text;
      try {
        response = JSON.parse(text);
      } catch {
        /* kept as text */
      }
      e = { url, method, params, status: res.status, response: trim(method, response) };
      kept.set(key, e);
    }
    return new Response(JSON.stringify(e.response), { status: e.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const reader = readerFor(network, { fetch: recording });
  const at = new Date();
  const checks: Recording["checks"] = [];
  for (const account of ACCOUNTS[network]) {
    const r = await maskCheck(account, { network, reader, list: sharedLists[network], now: () => at });
    checks.push({ account: r.account, verdict: r.verdict, codes: r.reasons.map((x) => x.code) });
    console.log(`recorded/check.json: ${r.verdict.toUpperCase().padEnd(5)} ${r.account} (${network}, block ${r.block?.height ?? "unread"})`);
  }
  return {
    network,
    recorded_at: at.toISOString(),
    about: `What NEAR ${network} RPC answered MASK CHECK about ${ACCOUNTS[network].join(", ")}. Block answers keep the header fields the reader reads; chunks are dropped.`,
    endpoints: [...reader.endpoints],
    checks,
    exchanges: [...kept.values()],
  };
}

await writeFile(join(FIXTURES, "recorded", "check.json"), `${JSON.stringify({ mainnet: await recordCheck("mainnet"), testnet: await recordCheck("testnet") }, null, 1)}\n`);
