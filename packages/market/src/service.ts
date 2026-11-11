// MASK CHECK as a paid service on Agent Market. A caller's message becomes a job for our agent: we read the account
// ids out of it, run MASK CHECK on each, and deliver one Markdown answer. On an A2A call the delivery settles the
// caller's x402 payment; a decline ends the call and nobody is charged.
//
// An account names its own network, by the rule of `GET /api/check`: `.testnet` reads testnet, everything else reads
// mainnet. Each network has its own reader and its own shared list, and an answer is delivered only when it is for
// the account and the network that were asked.
//
// No model reads the caller's text. Account ids are matched, never interpreted, so an instruction hidden in the message
// cannot change what is checked or what is answered.
import { NETWORK, NETWORKS, accountOk, isImplicit, networkOf, type CheckResult, type Network, type Verdict } from "@maskwars/check";
import type { MyAssignmentItem } from "./api.ts";
import { MarketError, type MarketClient } from "./client.ts";
import { MAX_ACCOUNTS } from "./profile.ts";

export interface Refused {
  /** The account id as sent, or its place in the JSON form (`accounts[1]`) when it is not an id at all. */
  input: string;
  why: string;
}

export interface CheckRequest {
  /** Lowercased, unique, in the order they appear; at most `MAX_ACCOUNTS`. */
  accounts: string[];
  refused: Refused[];
}

export interface ServiceOptions {
  /** The networks this agent answers for. Default: both, each account on the one its name says. */
  networks?: readonly Network[];
}

/** Our answer to one job: the Markdown to submit, or why we hand it back. */
export type ServiceAnswer =
  | { kind: "deliver"; markdown: string; verdict: Verdict; results: CheckResult[]; refused: Refused[] }
  | { kind: "decline"; reason: "rejected" | "failed"; detail: string };

/** One MASK CHECK. `network` is the one the account names (`networkOf`), and the answer must be for it. */
export type CheckFn = (account: string, network: Network) => Promise<CheckResult>;

const USAGE = "Send one to five NEAR accounts, e.g. `safe-0001.maskwars.near`, as text or as {\"accounts\": [\"…\"]}.";

// Separators around an account id in free text: spaces, quotes, brackets, commas, slashes of a link and the like.
// `.`, `-` and `_` belong to ids, so a trailing dot (end of a sentence) is trimmed per token instead.
const SPLIT = /[\s"'`<>()[\]{},;:|!?*=&/#]+/;

/** What free text names as an account: a name under a known top-level account, or an implicit id. */
const NAMED = /\.(near|tg|testnet)$/;

/**
 * The values of the JSON form, `{"accounts": ["…"]}` or `{"account": "…"}`, when the message holds one: the object
 * between the first and the last brace, or one that stands on a line of its own (a brief repeats its first line as
 * the title).
 */
function structured(text: string): unknown[] | null {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  const candidates = [text.slice(from, to + 1), ...text.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{") && line.endsWith("}"))];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o["accounts"])) return o["accounts"];
    if (typeof o["account"] === "string") return [o["account"]];
  }
  return null;
}

function wrongNetwork(network: Network, serves: readonly Network[]): string {
  return `a ${network} name; this agent reads ${serves.join(" and ")}`;
}

/**
 * Reads the account ids out of a caller's message. The JSON form names the accounts outright: any valid NEAR id, and
 * a value that is not one is refused by its place, never echoed. In free text only what cannot be mistaken for a word
 * counts: `*.near`, `*.tg`, `*.testnet` and implicit ids.
 */
export function parseCheckRequest(text: string, options: ServiceOptions = {}): CheckRequest {
  const serves = options.networks ?? NETWORKS;
  const accounts: string[] = [];
  const refused: Refused[] = [];
  const seen = new Set<string>();
  const take = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const network = networkOf(id);
    if (!serves.includes(network)) refused.push({ input: id, why: wrongNetwork(network, serves) });
    else if (accounts.length >= MAX_ACCOUNTS) refused.push({ input: id, why: `over ${MAX_ACCOUNTS} accounts in one call` });
    else accounts.push(id);
  };

  const named = structured(text);
  if (named) {
    named.slice(0, 50).forEach((value, i) => {
      const id = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (accountOk(id)) take(id);
      else refused.push({ input: `accounts[${i}]`, why: "not a NEAR account id" });
    });
    return { accounts, refused };
  }
  for (const raw of text.split(SPLIT)) {
    const token = raw.replace(/^\.+|\.+$/g, "").toLowerCase();
    if (!token) continue;
    if (isImplicit(token) || (NAMED.test(token) && accountOk(token))) take(token);
  }
  return { accounts, refused };
}

const RANK: Record<Verdict, number> = { block: 2, warn: 1, allow: 0 };

function strongest(results: readonly CheckResult[]): Verdict {
  return results.reduce<Verdict>((v, r) => (RANK[r.verdict] > RANK[v] ? r.verdict : v), "allow");
}

/** A table cell: one line, no pipes breaking the row. */
function cell(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

const HTTPS = /^https:\/\/[^\s()]+$/;
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Links to what a reason stands on: the transaction on the explorer, or the evidence attached to a report. */
function evidenceLinks(evidence: CheckResult["reasons"][number]["evidence"], explorer: string): string {
  const out: string[] = [];
  const tx = evidence?.["tx"];
  if (typeof tx === "string" && HTTPS.test(tx)) out.push(`[Transaction](${tx})`);
  const attached = evidence?.["evidence"];
  if (Array.isArray(attached)) {
    for (const e of attached) {
      if (e.kind === "tx" && TX_HASH.test(e.hash)) out.push(`[Transaction](${explorer}/txns/${e.hash})`);
      else if (e.kind === "url" && HTTPS.test(e.url)) out.push(`[Evidence](${e.url})`);
    }
  }
  return out.length > 0 ? ` ${out.join(" ")}` : "";
}

/** One account's part. With several accounts each heading carries its own verdict; with one, the title already does. */
function section(r: CheckResult, several: boolean): string {
  const explorer = NETWORK[r.network].explorer;
  const at = r.block ? `block ${r.block.height}, ${r.block.time}` : "the chain was not read";
  const lines = [
    several ? `## ${r.verdict.toUpperCase()} · \`${r.account}\`` : `## \`${r.account}\``,
    "",
    `NEAR ${r.network}, ${at}. [Account on the explorer](${explorer}/address/${r.account})`,
    "",
  ];
  if (r.reasons.length > 0) {
    lines.push("| Level | Signal | Reason |", "| --- | --- | --- |");
    for (const x of r.reasons) lines.push(`| ${x.level} | \`${x.code}\` | ${cell(x.text)}${evidenceLinks(x.evidence, explorer)} |`);
    lines.push("");
  }
  return lines.join("\n");
}

/** The Markdown we deliver: the verdict first, a section per account, then the whole answer as JSON. */
export function renderAnswer(results: readonly CheckResult[], refused: readonly Refused[] = []): string {
  const verdict = strongest(results);
  const head =
    results.length === 1
      ? `# MASK CHECK: ${verdict.toUpperCase()}`
      : `# MASK CHECK: ${verdict.toUpperCase()} (${results.length} accounts, the strongest answer)`;
  const parts = [head, "", ...results.map((r) => section(r, results.length > 1))];
  if (refused.length > 0) {
    parts.push("## Not checked", "");
    for (const x of refused) parts.push(`- \`${x.input}\`: ${x.why}`);
    parts.push("");
  }
  parts.push(
    "`allow` means only that no signal against the account was found. The JSON below is the whole answer.",
    "",
    "```json",
    JSON.stringify({ verdict, results, refused }, null, 2),
    "```",
    "",
  );
  return parts.join("\n");
}

/** One job's answer, from the text of its brief. Never throws for a bad brief: that is a decline. */
export async function answerBrief(text: string, check: CheckFn, options: ServiceOptions = {}): Promise<ServiceAnswer> {
  const request = parseCheckRequest(text, options);
  if (request.accounts.length === 0) {
    const why = request.refused.length > 0 ? ` Not checked: ${request.refused.map((r) => `${r.input} (${r.why})`).join("; ")}.` : "";
    return { kind: "decline", reason: "rejected", detail: `No NEAR account to check in the message.${why} ${USAGE}` };
  }
  const results: CheckResult[] = [];
  for (const account of request.accounts) {
    const network = networkOf(account);
    let result: CheckResult;
    try {
      result = await check(account, network);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "decline", reason: "failed", detail: `MASK CHECK failed on ${account}: ${message}. Nothing was charged; try again later.` };
    }
    // An answer about another account, or read on another network, is not the answer to this question.
    if (result.account !== account || result.network !== network) {
      return { kind: "decline", reason: "failed", detail: `MASK CHECK could not answer for ${account} on ${network}. Nothing was charged; try again later.` };
    }
    results.push(result);
  }
  // Nothing read from the chain is not an answer worth paying for.
  if (results.every((r) => r.block === null)) {
    return { kind: "decline", reason: "failed", detail: "The chain could not be read, so nothing was checked. Nothing was charged; try again in a minute." };
  }
  return { kind: "deliver", markdown: renderAnswer(results, request.refused), verdict: strongest(results), results, refused: request.refused };
}

export type Served = "submitted" | "declined" | "skipped";

export interface ServeDeps extends ServiceOptions {
  client: MarketClient;
  check: CheckFn;
  log?: (line: string) => void;
}

/**
 * Works one assignment from our agent's list end to end: declare the start, answer, submit or decline. A row that is
 * not ours to work (a competition entry, anything not `in_progress`) is skipped. A refusal that says the row has moved
 * on (delivered, cancelled) is skipped too; anything retryable is thrown so the next poll tries again.
 */
export async function serveAssignment(item: MyAssignmentItem, deps: ServeDeps): Promise<Served> {
  const log = deps.log ?? (() => {});
  const { assignment, job } = item;
  const id = assignment.assignmentId;
  if (job.jobKind === "competition" || assignment.status !== "in_progress") {
    log(`skip    ${id}: ${job.jobKind}, ${assignment.status}`);
    return "skipped";
  }
  try {
    await deps.client.start(id);
    const answer = await answerBrief(`${job.title}\n${job.description}`, deps.check, deps.networks ? { networks: deps.networks } : {});
    if (answer.kind === "decline") {
      await deps.client.decline(id, { reason: answer.reason, detail: answer.detail });
      log(`decline ${id}: ${answer.reason}, ${answer.detail}`);
      return "declined";
    }
    await deps.client.submit(id, { deliverableMarkdown: answer.markdown });
    log(`deliver ${id}: ${answer.verdict.toUpperCase()} for ${answer.results.map((r) => r.account).join(", ")}`);
    return "submitted";
  } catch (error) {
    if (error instanceof MarketError && !error.retryable && (error.code === "invalid_state_transition" || error.status === 404 || error.status === 403)) {
      log(`skip    ${id}: ${error.message}`);
      return "skipped";
    }
    throw error;
  }
}
