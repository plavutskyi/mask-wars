/**
 * The race's record of its minds (`MindRecord` in @maskwars/arena/minds): for every mask, the answers NEAR AI Cloud
 * gave its mind in this race and what they cost, and NEAR's price while it ran. Two steps of the race job make it. Once
 * the race is over, scripts/race.ts waits for every call still on its way (each up to its own deadline, 300 s) and
 * writes the race's tab (`MindTab`, `--minds`): every answer with its id on the bill, asking nothing of the network.
 * The race step ends only then, so the seal that follows it waits that long at most. Then scripts/minds.ts prices the
 * tab (`mindRecord`) in a job of its own beside the drain; the workflow hands the record on as the artifact
 * `minds-<race>`, and the site keeps it for good and shows it beside what the masks took.
 *
 * The price of an answer is NEAR AI's own bill for it: `POST /v1/billing/costs` by the answer's `inference-id`, in
 * nano-dollars. The bill shows an answer a few seconds after it, so it is asked after a pause, and once more for the
 * answers it did not know yet. An answer it still does not price is priced from its tokens, as NEAR AI counted them, at
 * NEAR AI's list price (`costUsd`); the record says how many answers each way (`billed`), and the site marks such a
 * price `≈` and shows no × on it. A call cut off on its way after NEAR AI named it (`cut`) has no tokens: the bill
 * prices it by its id, or, when the bill does not, it counts with the calls that brought nothing back (`unanswered`:
 * out of time, refused, unreachable), which the price leaves out and the site marks `≥`. An answer with no plan in it
 * (the model spent its tokens thinking) is counted: it is billed.
 *
 * `verified` counts the answers whose TEE signature checked out against the signers the model's attestation named,
 * made with a fresh nonce when the race began (scripts/race.ts).
 *
 * A person's mask thinks on OutLayer, in its mind's TEE (src/brain.ts): its tokens come back from there, rounded down,
 * and are priced at the list price; none of its answers is billed to the arena's key.
 */
import { parseMindRecord, type MindRecord, type MindSpend } from "@maskwars/arena/minds";
import { nearAiCosts, verifyModel, type NearAiProvider, type Usage } from "@maskwars/mind";
import type { Answer } from "./agent.ts";

export interface AttestOptions {
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly verify?: typeof verifyModel;
  readonly log?: (line: string) => void;
}

/**
 * The models' attestation when a race begins: for each model a fresh nonce and every check of @maskwars/mind's
 * `verifyModel` (Intel TDX quote, nonce, signer, NVIDIA GPUs). The model nodes of each model whose checks all pass are
 * the provider's trusted signers (`trust`), so each answer's TEE signature is checked against them (`signatureVerified`).
 * A model whose attestation does not pass gets no signer: its answers count as not verified, and the race goes on.
 * What it returns: per model, how many of its nodes are trusted.
 */
export async function trustAttested(provider: Pick<NearAiProvider, "trust">, models: readonly string[], o: AttestOptions = {}): Promise<Record<string, number>> {
  const verify = o.verify ?? verifyModel;
  const results = await Promise.all([...new Set(models)].map((m) => verify(m, { ...(o.apiKey ? { apiKey: o.apiKey } : {}), timeoutMs: o.timeoutMs ?? 30_000 })));
  const signers: string[] = [];
  const trusted: Record<string, number> = {};
  for (const v of results) {
    const nodes = v.outcome === "pass" ? v.nodes.map((n) => n.signer).filter((s) => s !== "") : [];
    trusted[v.model] = nodes.length;
    signers.push(...nodes);
    o.log?.(
      nodes.length > 0
        ? `${v.model}: attested with a fresh nonce, ${nodes.length} model node(s): its answers' TEE signatures are checked against them`
        : `${v.model}: attestation ${v.outcome}: its answers count as not verified`,
    );
  }
  provider.trust(signers);
  return trusted;
}

/** 1Click's token list: NEAR's price in dollars, as the keeper reads it (scripts/keeper.ts). */
export const ONE_CLICK_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
const WNEAR = "nep141:wrap.near";

/** One of the arena's own masks: its name on the board, its account, its model and every answer its mind got. */
export interface OwnMind {
  readonly name: string;
  readonly account: string;
  readonly model: string;
  readonly answers: readonly Answer[];
  /** Calls that brought nothing back to count. */
  readonly unanswered: number;
}

/** A person's mask: what its mind on OutLayer spent, as the race job counted it (`BrainAttacker.spent`). */
export interface PersonMind {
  readonly name: string;
  readonly account: string;
  readonly model: string;
  readonly calls: number;
  /** Attempts whose mind brought nothing back to count (out of time, refused, unreachable). */
  readonly unanswered: number;
  readonly usd: number;
  readonly tokens: Usage;
}

/** What the race job knows of its minds the moment the race is over: the tab, before anything is priced. */
export interface MindTab {
  readonly network: "mainnet" | "testnet";
  /** The race's bounty id. */
  readonly race: string;
  readonly own: readonly OwnMind[];
  readonly people?: readonly PersonMind[];
}

const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const usage = (u: unknown): u is Usage => {
  const x = u as Record<string, unknown> | null;
  return !!x && count(x.promptTokens) && count(x.completionTokens) && count(x.cachedTokens);
};

/** A tab as scripts/race.ts wrote it, or null when anything in it is not what a tab holds. */
export function parseTab(raw: unknown): MindTab | null {
  const t = raw as Record<string, unknown> | null;
  if (!t || typeof t !== "object" || (t.network !== "mainnet" && t.network !== "testnet") || typeof t.race !== "string") return null;
  if (!Array.isArray(t.own) || (t.people !== undefined && !Array.isArray(t.people))) return null;
  const ownOk = (t.own as Record<string, unknown>[]).every(
    (m) =>
      typeof m?.name === "string" &&
      typeof m.account === "string" &&
      typeof m.model === "string" &&
      count(m.unanswered) &&
      Array.isArray(m.answers) &&
      (m.answers as Record<string, unknown>[]).every(
        (a) =>
          typeof a?.model === "string" &&
          usage(a.usage) &&
          typeof a.listUsd === "number" &&
          a.listUsd >= 0 &&
          (a.inferenceId === null || typeof a.inferenceId === "string") &&
          (a.cut === undefined || typeof a.cut === "boolean") &&
          (a.verified === undefined || typeof a.verified === "boolean"),
      ),
  );
  const peopleOk = ((t.people ?? []) as Record<string, unknown>[]).every(
    (p) =>
      typeof p?.name === "string" &&
      typeof p.account === "string" &&
      typeof p.model === "string" &&
      count(p.calls) &&
      count(p.unanswered) &&
      typeof p.usd === "number" &&
      p.usd >= 0 &&
      usage(p.tokens),
  );
  return ownOk && peopleOk ? (t as unknown as MindTab) : null;
}

export interface RecordOptions extends MindTab {
  /** NEAR AI's key, for its bill. Without one every answer is priced from its tokens. */
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** The pause before the bill is asked, and before it is asked again. */
  readonly billWaitMs?: readonly [number, number];
  readonly log?: (line: string) => void;
}

/** NEAR's price in dollars from 1Click's token list, and when 1Click last moved it; null when it does not say. */
export async function nearPrice(get: typeof fetch = fetch): Promise<MindRecord["near"]> {
  try {
    const res = await get(ONE_CLICK_TOKENS, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const tokens = (await res.json()) as { assetId?: string; blockchain?: string; price?: unknown; priceUpdatedAt?: unknown }[];
    const t = Array.isArray(tokens) ? tokens.find((x) => x.assetId === WNEAR && x.blockchain === "near") : undefined;
    if (!t || typeof t.price !== "number" || !(t.price > 0) || t.price >= 100_000) return null;
    return { usd: t.price, at: typeof t.priceUpdatedAt === "string" ? t.priceUpdatedAt : null };
  } catch {
    return null;
  }
}

const sumUsage = (answers: readonly Answer[]) =>
  answers.reduce(
    (t, a) => ({ prompt: t.prompt + a.usage.promptTokens, completion: t.completion + a.usage.completionTokens, cached: t.cached + a.usage.cachedTokens }),
    { prompt: 0, completion: 0, cached: 0 },
  );

/** The race's record of its minds. It is checked as the site will read it before it is handed back. */
export async function mindRecord(o: RecordOptions): Promise<MindRecord> {
  const get = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const [first, again] = o.billWaitMs ?? [5_000, 20_000];
  const ids = o.own.flatMap((m) => m.answers.map((a) => a.inferenceId).filter((id): id is string => id !== null));

  const billed = new Map<string, bigint>();
  if (o.apiKey && ids.length > 0) {
    await sleep(first);
    for (const [id, nano] of await nearAiCosts(ids, { apiKey: o.apiKey, fetch: get })) billed.set(id, nano);
    const missing = ids.filter((id) => !billed.has(id));
    if (missing.length > 0) {
      await sleep(again);
      for (const [id, nano] of await nearAiCosts(missing, { apiKey: o.apiKey, fetch: get })) billed.set(id, nano);
    }
    o.log?.(`NEAR AI's bill priced ${billed.size} of ${ids.length} answers`);
  }

  const masks: MindSpend[] = o.own.map((m) => {
    let nano = 0n;
    let list = 0;
    let fromBill = 0;
    let lost = 0;
    let verified = 0;
    const counted: Answer[] = [];
    for (const a of m.answers) {
      const b = a.inferenceId ? billed.get(a.inferenceId) : undefined;
      if (b !== undefined) {
        nano += b;
        fromBill += 1;
      } else if (a.cut) {
        // Cut off with no tokens, and the bill does not price it: its price is not known, and the record says so.
        lost += 1;
        continue;
      } else list += a.listUsd;
      counted.push(a);
      if (a.verified) verified += 1;
    }
    // A tab from before the check says nothing of it: the record then claims nothing either.
    const checked = m.answers.some((a) => a.verified !== undefined);
    return {
      account: m.account,
      name: m.name,
      model: m.model,
      answers: counted.length,
      billed: fromBill,
      unanswered: m.unanswered + lost,
      ...(checked ? { verified } : {}),
      tokens: sumUsage(counted),
      usd: Number(nano) / 1e9 + list,
    };
  });
  for (const p of o.people ?? []) {
    masks.push({
      account: p.account,
      name: p.name,
      model: p.model,
      answers: p.calls,
      billed: 0,
      unanswered: p.unanswered,
      tokens: { prompt: p.tokens.promptTokens, completion: p.tokens.completionTokens, cached: p.tokens.cachedTokens },
      usd: p.usd,
    });
  }

  const record = { v: 1, network: o.network, race: o.race, at: (o.now ?? Date.now)(), near: await nearPrice(get), masks };
  const checked = parseMindRecord(record);
  if (!checked) throw new Error(`the record of the minds of ${o.race} is not well formed`);
  return checked;
}
