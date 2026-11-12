// A model in a TEE writes the page; this code decides whether it is published. The model is a Confidential TEE model
// on NEAR AI Cloud. Before it writes, a fresh attestation names the TEE's signing keys; after it writes, the answer's
// signature must hold for the exact request and response bytes and come from one of those keys. A page is published
// only when it passes every check in page.ts and, unless a caller turns it off for a local run, carries that signature.

import {
  ProviderError,
  type ChatMessage,
  type Completion,
  type ModelVerification,
  type Provider,
  type TeeModel,
  checkSignature,
  sha256Hex,
  verifyModel,
} from "@maskwars/mind";
import { forModel, hashEvidence } from "./evidence.ts";
import { PageModel, requestBody } from "./model.ts";
import { checkPage, isGateReason, parseReply } from "./page.ts";
import { SLOT } from "./slots.ts";
import { pagePrompt, pageSystem } from "./prompt.ts";
import type { Dossier, TeeProof, WrittenPage } from "./types.ts";

/** How every page is asked for; a signed request with other settings is not the package's. */
const TEMPERATURE = 0.2;
const MAX_TOKENS = 2_000;

/**
 * The model that writes pages, unless told otherwise: Confidential TEE on NEAR AI Cloud. Asked for no reasoning
 * (model.ts), it answers a page in about ten seconds; GLM 5.3 Flash keeps reasoning all the same and runs past a
 * server's minute.
 */
export const DEFAULT_MODEL: TeeModel = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

export interface Exchange {
  readonly request: string;
  readonly response: string;
}

export interface WriterOptions {
  readonly provider: Provider;
  readonly model: string;
  /** The attestation the provider's trusted signers came from. */
  readonly tee?: TeeProof | null;
  /** The exact bytes of the provider's last completion, when it was given a recording fetch. */
  readonly lastExchange?: () => Exchange | null;
  /** Publish only a page whose answer a TEE signed. On by default; off only for a local run without NEAR AI. */
  readonly requireTee?: boolean;
  /** Replies to ask for: the second one is told, in our words, why the first was not published. */
  readonly attempts?: number;
  /** One reply's deadline. */
  readonly timeoutMs?: number;
  /** The whole write's deadline, every reply included: a server function has a limit of its own. */
  readonly budgetMs?: number;
  /** Teams whose races earn a page; see `writable`. */
  readonly teams?: readonly string[];
  readonly now?: () => number;
}

export type WriteResult =
  | { readonly status: "published"; readonly page: WrittenPage; readonly attempts: number }
  | {
      readonly status: "rejected";
      /** `checks`: the page failed the gate; `unsigned`: no TEE signature held; `provider`: the model did not answer; `nothing`: no facts to write from. */
      readonly reason: "checks" | "unsigned" | "provider" | "nothing";
      readonly problems: readonly string[];
      readonly attempts: number;
    };

/** Pages are written only about accounts the arena has a record of. */
export interface WritableOptions {
  /** Teams whose races the arena runs: a race they opened earns its target a page. */
  readonly teams?: readonly string[];
}

/**
 * Pages are written only about the arena's own record: a library target, a safe on the shared list, or a target of a
 * race one of its teams opened. Anyone can open a race on the bounty contract; a stranger's race must not make the
 * server pay for a page. A page is written only once the record settles: a live race changes it with every step.
 */
export function writable(d: Dossier, o: WritableOptions = {}): boolean {
  if (d.headline.standing === "unknown" || d.incomplete || d.evidence.length < 2) return false;
  // A page tells a settled record: no race still open or with the judge, and every safe's code read.
  if (d.races.some((r) => !FINAL_STATES.has(r.state))) return false;
  // A refund whose own transaction was not read leaves the record unsure: held at the deadline, or called off?
  if (d.races.some((r) => r.state === "refunded" && r.refundAt === null)) return false;
  if (d.races.some((r) => r.kind === "safe" && !d.evidence.some((e) => e.kind === "code"))) return false;
  return d.library !== null || d.races.some((r) => (o.teams ?? []).includes(r.team));
}

const FINAL_STATES: ReadonlySet<string> = new Set(["paid", "drained", "refunded"]);

/** The words of a sentence, slots set aside. */
const STOP = new Set(["the", "and", "was", "were", "its", "for", "with", "from", "near", "utc", "that", "this", "then", "into", "after", "before", "its", "had", "has", "of", "at", "on", "in", "to", "a", "an", "by", "it"]);
const wordSet = (words: string) => new Set(words.split(/[^a-z_-]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Two sentences that share most of their words: the second is the first, reworded a little. */
function similar(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / Math.max(1, a.size, b.size) >= 0.6;
}

/** Every sentence of a reply, however malformed, as its words with the slots set aside, and its slots in order. */
function claimsOf(reply: unknown): [string, string, string][] {
  const out: [string, string, string][] = [];
  const add = (c: unknown, where: string) => {
    const text = typeof c === "object" && c !== null ? (c as { text?: unknown }).text : undefined;
    if (typeof text !== "string") return;
    const words = text.trim().replace(/\s+/g, " ").replace(SLOT, "§").toLowerCase();
    out.push([words, [...text.matchAll(SLOT)].map((m) => m[0]).join(" "), where]);
  };
  if (typeof reply !== "object" || reply === null) return out;
  const r = reply as { lede?: unknown; sections?: unknown };
  add(r.lede, "lede");
  if (Array.isArray(r.sections)) {
    for (const sec of r.sections) {
      if (typeof sec !== "object" || sec === null || !Array.isArray((sec as { claims?: unknown }).claims)) continue;
      const id = String((sec as { id?: unknown }).id);
      (sec as { claims: unknown[] }).claims.forEach((c, i) => add(c, `${id} ${i + 1}`));
    }
  }
  return out;
}

export async function writePage(d: Dossier, o: WriterOptions): Promise<WriteResult> {
  if (!writable(d, o.teams ? { teams: o.teams } : {})) return { status: "rejected", reason: "nothing", problems: ["no record on the arena to write from"], attempts: 0 };
  const attempts = Math.max(1, o.attempts ?? 2);
  const now = o.now ?? Date.now;
  const started = Date.now();
  const budget = o.budgetMs ?? Number.POSITIVE_INFINITY;
  const perReply = o.timeoutMs ?? 30_000;
  let problems: string[] = [];
  // The sentences of earlier replies, words only: a later reply that keeps a sentence's words and only puts other
  // fields in its slots follows a reason about the words by changing the numbers, which is how a misread honest
  // sentence turns into a false one. Such a reply is not published.
  const tried = new Map<string, Set<string>>();
  // The slots the gate refused, with the words of their sentences: a later sentence that shares most of those words
  // must still carry the refused slot, so a reason about the words is answered by other words, never by another field.
  let refused: { words: Set<string>; slot: string; slots: string[] }[] = [];
  // The last reply the model did not give: NEAR AI answers 502 to a signed reply that takes over thirty seconds, and a
  // busy moment passes. Such a try is asked again while the budget lasts, with the gate's reasons as they were.
  let unanswered: string | null = null;
  for (let i = 1; i <= attempts; i++) {
    const left = budget - (Date.now() - started);
    // A reply only when it has time to finish: a cut-off reply is paid for and never published.
    if (left < Math.min(perReply, 15_000)) {
      if (unanswered !== null) return { status: "rejected", reason: "provider", problems: [unanswered], attempts: i - 1 };
      return { status: "rejected", reason: i > 1 ? "checks" : "provider", problems: i > 1 ? problems : ["no time left for a reply"], attempts: i - 1 };
    }
    let completion: Completion;
    try {
      completion = await o.provider.complete({
        model: o.model,
        messages: pagePrompt(d, problems),
        maxTokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        timeoutMs: Math.max(1_000, Math.min(perReply, left)),
      });
    } catch (error) {
      const why = error instanceof ProviderError ? `${error.code}: ${error.message}` : String(error);
      const passing = error instanceof ProviderError && (error.code === "timeout" || error.code === "network" || (error.code === "http" && (error.status === 429 || (error.status ?? 0) >= 500)));
      if (passing && i < attempts) {
        unanswered = why;
        continue;
      }
      return { status: "rejected", reason: "provider", problems: [why], attempts: i };
    }
    unanswered = null;
    const verdict = checkPage(completion.text, d.evidence);
    const sentences = claimsOf(parseReply(completion.text));
    const swapped = sentences.some(([words, slots]) => {
      if (tried.get(words)?.has(slots)) return false;
      if (tried.has(words)) return true;
      const these = wordSet(words);
      // Dropping the refused slot or splitting the sentence is fine; bringing another field in its place is not.
      const mine = slots.split(" ").filter(Boolean);
      return refused.some((r) => similar(r.words, these) && !mine.includes(r.slot) && mine.some((x) => !r.slots.includes(x)));
    });
    if (verdict.ok && swapped) {
      return { status: "rejected", reason: "checks", problems: ["a second try kept the words of a sentence and changed only its slots"], attempts: i };
    }
    for (const [words, slots] of sentences) tried.set(words, (tried.get(words) ?? new Set<string>()).add(slots));
    if (!verdict.ok) {
      // Each refused slot with the sentence its reason names (`lede`, `money 1`), not every sentence that carries it.
      const named = new Set(
        verdict.problems.flatMap((p) => {
          const m = /^(lede|[a-z]+ \d{1,2}): (?:puts (E\d{1,3}\.[a-z_]{1,40}) (?:where|right)|writes (E\d{1,3}\.[a-z_]{1,40}) twice|tells (E\d{1,3}\.[a-z_]{1,40}) and)\b/.exec(p);
          return m ? [`${m[1]}|${m[2] ?? m[3] ?? m[4]}`] : [];
        }),
      );
      refused = sentences.flatMap(([words, slots, where]) => slots.split(" ").filter((x) => named.has(`${where}|${x.slice(1, -1)}`)).map((x) => ({ words: wordSet(words), slot: x, slots: slots.split(" ") })));
      // Only the gate's own lines go back to the model, so the signed request stays the package's own.
      problems = verdict.problems.filter(isGateReason);
      continue;
    }
    if ((o.requireTee ?? true) && !completion.signatureVerified) {
      return { status: "rejected", reason: "unsigned", problems: ["no TEE signature held for this answer"], attempts: i };
    }
    const exchange = o.lastExchange?.() ?? null;
    const bytesHold = exchange !== null && sha256Hex(exchange.request) === completion.requestHash && sha256Hex(exchange.response) === completion.responseHash;
    const page: WrittenPage = {
        version: 1,
        account: d.account,
        network: d.network,
        evidenceHash: d.evidenceHash,
        evidence: d.evidence,
        page: verdict.page,
        model: completion.model,
        provider: o.provider.id,
        writtenAt: new Date(now()).toISOString(),
        attestation: {
          request: bytesHold ? exchange.request : null,
          requestHash: completion.requestHash,
          response: bytesHold ? exchange.response : null,
          responseHash: completion.responseHash,
          signature: completion.signature,
          signatureVerified: completion.signatureVerified,
          tee: o.tee ?? null,
        },
        usage: { promptTokens: completion.usage.promptTokens, completionTokens: completion.usage.completionTokens, costUsd: completion.costUsd },
    };
    // The same check a reader runs: a page that would not verify later is not published now.
    if (o.requireTee ?? true) {
      const again = verifyWritten(page);
      if (!again.ok) return { status: "rejected", reason: "unsigned", problems: again.problems, attempts: i };
    }
    return { status: "published", attempts: i, page };
  }
  return { status: "rejected", reason: "checks", problems, attempts };
}

/** The attestation as a page keeps it: the model TEE signers come only from a check that passed. */
export function teeProof(v: ModelVerification): TeeProof {
  return {
    model: v.model,
    outcome: v.outcome,
    checkedAt: v.checkedAt,
    nonce: v.nonce,
    signers: v.outcome === "pass" ? [...new Set(v.nodes.map((n) => n.signer).filter(Boolean))] : [],
  };
}

export interface NearAiWriterOptions {
  readonly apiKey: string;
  readonly model?: TeeModel;
  readonly fetch?: typeof fetch;
  /** An attestation already made: its signers are trusted, no new check is run. */
  readonly tee?: TeeProof;
  /** The attestation check; by default a fresh `verifyModel` from `@maskwars/mind`. */
  readonly verify?: (model: string) => Promise<ModelVerification>;
}

/**
 * A writer on NEAR AI Cloud: a fresh attestation of the model first, its signers trusted, and every completion's exact
 * bytes kept so the page can carry them next to the signature.
 */
export async function nearAiWriter(o: NearAiWriterOptions): Promise<Pick<WriterOptions, "provider" | "model" | "tee" | "lastExchange">> {
  const model = o.model ?? DEFAULT_MODEL;
  const inner = o.fetch ?? fetch;
  const tee =
    o.tee ?? teeProof(await (o.verify ?? ((m: string) => verifyModel(m, { apiKey: o.apiKey, ...(o.fetch ? { fetch: o.fetch } : {}), timeoutMs: 15_000 })))(model));
  let last: Exchange | null = null;
  const keeping = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/chat/completions") && typeof init?.body === "string") {
      last = { request: init.body, response: await res.clone().text() };
    }
    return res;
  }) as typeof fetch;
  const provider = new PageModel({ apiKey: o.apiKey, trustedSigners: tee.signers, fetch: keeping });
  return { provider, model, tee, lastExchange: () => last };
}

/** The model's reply text inside the exact response bytes. */
function replyText(response: string): string | null {
  try {
    const content = (JSON.parse(response) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

const PREVIOUS = "previous_reply_was_not_published_because";
const ROLES: ReadonlySet<string> = new Set(["safe", "target", "contract", "account", "missing", "unread"]);

/**
 * The signed request must be exactly the request this package builds: the model, no stream, our system message, then
 * one user message holding the subject, the facts and, on a second try, our reasons, and nothing else. A request that
 * steered the model with any other message or field is not ours, however honestly the TEE signed it.
 */
function requestProblem(request: string, w: WrittenPage): string | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(request) as Record<string, unknown>;
  } catch {
    return "the signed request is not JSON";
  }
  if (Object.keys(body).sort().join(",") !== "chat_template_kwargs,max_tokens,messages,model,stream,temperature") return "the signed request carries other fields";
  if (body["model"] !== w.model || body["stream"] !== false) return "the signed request asked another model";
  if (body["temperature"] !== TEMPERATURE || body["max_tokens"] !== MAX_TOKENS) return "the signed request carries other settings";
  const messages = body["messages"];
  if (!Array.isArray(messages) || messages.length !== 2) return "the signed request carries other messages";
  const [system, user] = messages as Record<string, unknown>[];
  const shaped = (m: Record<string, unknown> | undefined, role: string) => m?.["role"] === role && Object.keys(m).length === 2 && typeof m["content"] === "string";
  if (!shaped(system, "system") || !shaped(user, "user")) return "the signed request carries other messages";
  if (system!["content"] !== pageSystem(w)) return "the signed request carried another prompt";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(user!["content"] as string) as Record<string, unknown>;
  } catch {
    return "the signed request's data is not JSON";
  }
  const subject = (data["subject"] ?? {}) as Record<string, unknown>;
  if (subject["account"] !== w.account || subject["network"] !== w.network) return "the signed request is about another account";
  const previous = data[PREVIOUS];
  // The reasons are the gate's own lines, nothing a caller could steer the model with.
  const reasons = Array.isArray(previous) && previous.length <= 12 && previous.every((x) => typeof x === "string" && isGateReason(x)) ? previous : null;
  if (previous !== undefined && !reasons) return "the signed request carried reasons the gate did not write";
  if (!ROLES.has(subject["role"] as string)) return "the signed request carried a role the package does not know";
  // Built again from what it says it holds: any other key, a second `facts`, other facts or a reordered object differ.
  const rebuilt = JSON.stringify({
    subject: { account: subject["account"], network: subject["network"], role: subject["role"] },
    facts: forModel(w.evidence),
    ...(reasons ? { [PREVIOUS]: reasons } : {}),
  });
  if (typeof subject["role"] !== "string" || rebuilt !== user!["content"]) return "the facts are not the facts the signed request carried";
  // The whole body, byte for byte, as this package sends it: the template's settings included.
  if (request !== requestBody({ model: w.model, messages: messages as ChatMessage[], maxTokens: MAX_TOKENS, temperature: TEMPERATURE })) return "the signed request carries other settings";
  return null;
}

/**
 * Checks a stored page as a partner would. The page must be exactly what the signed response says once it passes the
 * gate; the facts must be exactly the facts in the signed request and hash to `evidenceHash`; the bytes must hash to
 * what the model TEE signed; and the signer must be one the attestation named.
 */
export interface VerifyOptions {
  /**
   * The model TEE signers a fresh attestation names now. When given, the page's signer must be one of them; without
   * them, the signers the page's own attestation recorded are used, and that attestation must have passed.
   */
  readonly signers?: ReadonlySet<string>;
}

export function verifyWritten(w: WrittenPage, o: VerifyOptions = {}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const a = w.attestation;
  if (hashEvidence(w.evidence) !== w.evidenceHash) problems.push("the facts do not hash to evidenceHash");

  if (a.request === null || sha256Hex(a.request) !== a.requestHash) problems.push("the request bytes are missing or do not hash to requestHash");
  else {
    const wrong = requestProblem(a.request, w);
    if (wrong) problems.push(wrong);
  }

  if (a.response === null || sha256Hex(a.response) !== a.responseHash) problems.push("the response bytes are missing or do not hash to responseHash");
  else {
    const text = replyText(a.response);
    const gate = text === null ? null : checkPage(text, w.evidence);
    if (!gate || !gate.ok) problems.push(...(gate && !gate.ok ? gate.problems : ["the signed response carries no page"]));
    else if (JSON.stringify(gate.page) !== JSON.stringify(w.page)) problems.push("the page is not the page the signed response carries");
  }

  const signers = o.signers ?? (a.tee?.outcome === "pass" ? new Set(a.tee.signers.map((s) => s.toLowerCase())) : new Set<string>());
  const signed = a.signature !== null && a.tee !== null && checkSignature(a.signature, { model: w.model, requestHash: a.requestHash, responseHash: a.responseHash, signers });
  if (!signed) problems.push("no TEE signature holds for this page from a signer an attestation named");
  return { ok: problems.length === 0, problems };
}
