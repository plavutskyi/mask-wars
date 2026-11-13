/**
 * A person's mask in the race. Its mind runs on OutLayer, inside a TEE (services/brain): only there does its owner's
 * strategy open, and only from there is the mask's model on NEAR AI Cloud asked. The race job never reads the line. It
 * sends the mask, the round, the target and, of the mask's own past attempts, only each verdict and each step's method
 * and outcome to OutLayer's HTTPS API, and gets back a plan the module wrote itself (`set_owner` and `sweep` in the
 * order the model chose, with the mask's own account and the module's amount), with the tokens the model used in steps
 * of 2048, rounded down. The module answers only the keeper's account, the payment key's owner.
 *
 * The call is OutLayer's `POST /call/{owner}/{project}` with a payment key (`X-Payment-Key`), as the OutLayer CLI makes
 * it (`outlayer run --async`, out-layer/outlayer-cli `src/api.rs`), with the project's secrets attached:
 * `PROTECTED_BRAIN_SEED`, which OutLayer generated inside the TEE, and `NEAR_AI_API_KEY`. The payment key pays OutLayer
 * for the run; it moves no NEAR and signs nothing on chain.
 *
 * The models think for minutes on a live safe, so the call asks for the longest run OutLayer gives, 180 seconds (60
 * when a call names none), and is made `async`: OutLayer answers at once with the call's id and the race job reads the
 * call (`GET /calls/{id}`) until it is over. A synchronous call is held only for the server's own window, and one that
 * outlives it is settled as failed. The race job waits for as long as the run can take and a busy worker may need to
 * start it, and tells apart what stopped an attempt (`MindStop`): the mind ran out of time, the model spent its tokens
 * before it answered, the answer held no plan, the mind refused, or OutLayer could not be reached.
 *
 * What a race can cost its owner is bounded here and in the module: one attempt is one answer of at most 24 000 tokens
 * (`MIND_LIMITS`, the module's own `MAX_TOKENS`), and one race asks a mind at most `RACE_CALLS` times.
 */
import { costUsd, type Usage } from "@maskwars/mind";
import type { AttemptMemory, Attacker } from "./agent.ts";
import type { Challenge } from "./challenge.ts";
import { Plan, type PlanParse } from "./plan.ts";

/** OutLayer's HTTPS API for testnet, as the CLI names it. */
export const OUTLAYER_TESTNET_API = "https://testnet-api.outlayer.ai";
/** The targets the module carries; any other it refuses before a token is spent. */
export const BRAIN_TARGETS: ReadonlySet<string> = new Set(["live-safe"]);
/** Past attempts the mind reads back, as the arena's own masks. */
const MEMORY = 3;

/**
 * One attempt's allowance, the numbers the module holds (services/brain/mind.json, `limits`; a test keeps them the
 * same): the tokens one answer may take, thinking included; the step the counts leave the TEE in, rounded down; the
 * seconds OutLayer gives the run, its longest; and the seconds the model has to answer inside it.
 */
export const MIND_LIMITS = { maxTokens: 24_000, tokenStep: 2048, runSeconds: 180, modelSeconds: 165 } as const;
/**
 * What the call asks OutLayer for, all three named: a call that names no time gets 60 seconds. The mind's own work is
 * small (a key exchange and two JSON documents), far under a billion instructions; the time is the model's.
 */
export const RUN_LIMITS = { max_instructions: 1_000_000_000, max_memory_mb: 128, max_execution_seconds: MIND_LIMITS.runSeconds } as const;
/** How long one attempt waits for its run: the run's own limit, and up to two minutes for a busy worker to start it. */
export const WAIT_MS = (MIND_LIMITS.runSeconds + 120) * 1000;
/** How often a call still running is read again. */
const POLL_MS = 5_000;
/** How long OutLayer has to take the call, and to answer one reading of it. A reading that takes longer is read again. */
const SEND_MS = 30_000;
const READ_MS = 15_000;
/** OutLayer refused the call before running anything and says it will take it later (429, 503): asked again so many times. */
const SEND_AGAIN = 3;
/**
 * The most times one race asks a mind, whatever number of attempts the race is run with: with one attempt's allowance
 * it bounds what a race can cost the mask's owner (`raceCeilingUsd`).
 */
export const RACE_CALLS = 5;
/**
 * The most tokens the mind's prompt takes: most of it is the vault's source, and the module's own test holds the
 * largest prompt under 72 000 bytes, which no tokenizer turns into more than this.
 */
export const PROMPT_TOKENS_CEILING = 24_000;

/** The most one attempt can cost on NEAR AI Cloud, in dollars: the largest prompt, nothing of it cached, and the whole allowance. */
export function attemptCeilingUsd(model: string): number {
  return costUsd(model, { promptTokens: PROMPT_TOKENS_CEILING, completionTokens: MIND_LIMITS.maxTokens, cachedTokens: 0 });
}

/** The most one race can cost a mask's owner, in dollars: `RACE_CALLS` attempts, each at its ceiling. */
export function raceCeilingUsd(model: string): number {
  return RACE_CALLS * attemptCeilingUsd(model);
}

/**
 * What stopped an attempt of a mind short of a plan:
 * - `out-of-time`: the model was still thinking when its time ran out, or the run was not over in the time the race
 *   job waits. No tokens are counted: nothing came back to count;
 * - `out-of-tokens`: the model spent its whole allowance before it answered. The tokens are counted;
 * - `no-plan`: the model answered, and the answer holds no plan the mask plays. The tokens are counted;
 * - `refused`: the mind answered that it will not play, in the module's own words (the mask is not armed for this
 *   round, the caller is not the keeper, NEAR AI Cloud gave it no answer), or the race has had its `RACE_CALLS`.
 *   Nothing is counted;
 * - `unreachable`: OutLayer did not take the call, or its run failed, or its answer cannot be read. Nothing is counted.
 */
export type MindStop = "out-of-time" | "out-of-tokens" | "no-plan" | "refused" | "unreachable";
/** How the module words a model that did not answer in time, and one that spent its tokens (services/brain, `OUT_OF_TIME`, `OUT_OF_TOKENS`). */
const MODULE_OUT_OF_TIME = /^the model did not answer in \d+ seconds$/;
const MODULE_OUT_OF_TOKENS = /^the model spent all \d+ tokens before it answered$/;
/** How OutLayer words a run it ended at its time limit (its worker, `wasi_p2.rs`). */
const RUN_OUT_OF_TIME = /execution timed out after \d+ seconds|wall-clock limit of \d+s/i;

export interface BrainOptions {
  /** Name on the board: the mask's name in capitals, `KIRA`. */
  readonly id: string;
  /** The mask's account, `kira.masks.tinygif8324.testnet`. */
  readonly mask: string;
  /** The round the keeper armed it for. */
  readonly round: string;
  /** The mask's model, public on the factory: what its tokens cost. */
  readonly model: string;
  /** The module's OutLayer project, `owner/name`. */
  readonly project: string;
  /** `owner:nonce:key`: pays OutLayer for each run. */
  readonly paymentKey: string;
  readonly api?: string;
  /** Whose secrets the run gets: the project owner's by default, profile `default`. */
  readonly secretsOwner?: string;
  readonly secretsProfile?: string;
  /** How long one attempt waits for its run to be over; by default `WAIT_MS`. */
  readonly timeoutMs?: number;
  /** How often a running call is read again; by default every three seconds. */
  readonly pollMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Gets a line for every attempt that gave no plan: what stopped it, in the words of `MindMiss`. */
  readonly log?: (line: string) => void;
}

/** A call as OutLayer's HTTPS API shows it (`ProjectCallResponse`). */
interface Call {
  readonly call_id?: string;
  readonly status?: string;
  readonly output?: unknown;
  readonly error?: string | null;
}

/** What the module hands back for one attempt (services/brain, `Played`). */
interface Played {
  readonly plan: unknown;
  readonly error: string | null;
  readonly model: string;
  readonly usage: { readonly prompt_tokens: number; readonly completion_tokens: number; readonly cached_tokens: number };
  readonly strategy: boolean;
}

/** What a mask's mind spent in this race: the price of its tokens on NEAR AI, the model's own TEE. */
export interface MindSpend {
  readonly usd: number;
  /** The answers the tokens were counted for. */
  readonly calls: number;
  readonly tokens: Usage;
}

/** An attempt's plan, or why there is none (`MindStop`) and the same in words: a `PlanParse` that also says why. */
export type MindPlan = Extract<PlanParse, { ok: true }>;
export type MindMiss = Extract<PlanParse, { ok: false }> & { readonly stop: MindStop };

export class BrainAttacker implements Attacker {
  readonly id: string;
  readonly mask: string;
  readonly #o: BrainOptions;
  #spend = { usd: 0, calls: 0, tokens: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 } };
  #stops: Record<MindStop, number> = { "out-of-time": 0, "out-of-tokens": 0, "no-plan": 0, refused: 0, unreachable: 0 };
  #asked = 0;

  constructor(options: BrainOptions) {
    this.id = options.id;
    this.mask = options.mask;
    this.#o = options;
  }

  /** The model this mask's mind thinks with. */
  get model(): string {
    return this.#o.model;
  }

  get spent(): MindSpend {
    return { usd: this.#spend.usd, calls: this.#spend.calls, tokens: { ...this.#spend.tokens } };
  }

  /** How many attempts of this race each kind of stop ended. */
  get stops(): Readonly<Record<MindStop, number>> {
    return { ...this.#stops };
  }

  /** How many times this race has asked the mind. */
  get asked(): number {
    return this.#asked;
  }

  async propose(challenge: Challenge, history: readonly AttemptMemory[]): Promise<MindPlan | MindMiss> {
    const got = await this.#propose(challenge, history);
    if (!got.ok) {
      this.#stops[got.stop] += 1;
      this.#o.log?.(`${this.id.padEnd(7)} mind, ask ${this.#asked}: ${got.stop}: ${got.error}`);
    }
    return got;
  }

  async #propose(challenge: Challenge, history: readonly AttemptMemory[]): Promise<MindPlan | MindMiss> {
    const miss = (stop: MindStop, error: string): MindMiss => ({ ok: false, error, stop });
    if (!BRAIN_TARGETS.has(challenge.manifest.id)) return miss("refused", "the mind plays only the targets it carries");
    const [owner, project] = this.#o.project.split("/");
    if (!owner || !project) return miss("refused", "the mind's project is owner/name");
    // One race asks a mind so many times and no more: what bounds a race's cost to the mask's owner.
    if (this.#asked >= RACE_CALLS) return miss("refused", `the mind has played its ${RACE_CALLS} attempts of this race`);
    this.#asked += 1;
    const input = {
      action: "plan",
      mask: this.#o.mask,
      round: this.#o.round,
      challenge: challenge.manifest.id,
      // Only what the module reads: the verdict and, step by step, the method and whether it went through. No text.
      history: history.slice(-MEMORY).map((h) => ({
        verdict: h.outcome.verdict,
        steps: h.outcome.steps.map((s) => ({ method: s.method, ok: s.ok })),
      })),
    };
    const body = {
      input,
      async: true,
      resource_limits: RUN_LIMITS,
      secrets_ref: { profile: this.#o.secretsProfile ?? "default", account_id: this.#o.secretsOwner ?? owner },
    };
    const now = this.#o.now ?? Date.now;
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const wait = this.#o.timeoutMs ?? WAIT_MS;
    const deadline = now() + wait;
    const late = () => miss("out-of-time", `the mind ran out of time: its run was not over in ${Math.round(wait / 1000)} seconds`);
    const api = (this.#o.api ?? OUTLAYER_TESTNET_API).replace(/\/$/, "");
    const pause = this.#o.pollMs ?? POLL_MS;
    // Every request has its own short time, and never one past the attempt's deadline.
    const request = async (url: string, init: RequestInit, ms: number): Promise<Response | string> => {
      try {
        return await (this.#o.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(ms, deadline - now()))) });
      } catch (e) {
        return (e as Error).name;
      }
    };
    /** OutLayer's own name for a refusal (`reason`), when its answer carries one. */
    const reason = async (res: Response) => {
      const said = (await res.json().catch(() => null)) as { reason?: unknown } | null;
      return typeof said?.reason === "string" && /^[a-z_]{1,64}$/.test(said.reason) ? ` (${said.reason})` : "";
    };

    let sent: Response | string;
    for (let again = 0; ; again++) {
      sent = await request(
        `${api}/call/${owner}/${project}`,
        { method: "POST", headers: { "content-type": "application/json", "x-payment-key": this.#o.paymentKey }, body: JSON.stringify(body) },
        SEND_MS,
      );
      // 429 and 503 refuse the call before anything runs or is charged, so the same call may be sent again.
      const later = typeof sent !== "string" && (sent.status === 429 || sent.status === 503);
      if (!later || again >= SEND_AGAIN || now() + 2 * pause >= deadline) break;
      await sleep(pause);
    }
    // No answer to the call itself: whether a run began is unknown, so it is not sent again.
    if (typeof sent === "string") return miss("unreachable", `the mind on OutLayer is unreachable: ${sent}`);
    // 408: OutLayer held the call for its own window and settled it as failed. An async call has no window.
    if (sent.status === 408) return miss("out-of-time", "the mind ran out of time: OutLayer did not hold the call until its run was over");
    if (!sent.ok) return miss("unreachable", `the mind on OutLayer answered ${sent.status}${await reason(sent)}`);
    let call = (await sent.json().catch(() => null)) as Call | null;

    // The run goes on at OutLayer; read the call until it is over. A reading that fails or stalls is read again: the
    // run was paid for, and a hiccup on the way must not cost the mask its attempt.
    while (call?.status === "pending") {
      const id = call.call_id;
      if (!id) return miss("unreachable", "the mind's run has no call id to read it by");
      if (now() + pause >= deadline) return late();
      await sleep(pause);
      const read = await request(`${api}/calls/${encodeURIComponent(id)}`, { headers: { "x-payment-key": this.#o.paymentKey } }, READ_MS);
      if (typeof read === "string") continue;
      if (read.status === 404) return miss("unreachable", "the mind's run is unknown to OutLayer");
      if (!read.ok) continue;
      const next = (await read.json().catch(() => null)) as Call | null;
      if (next?.status) call = { ...next, call_id: next.call_id ?? id };
    }
    if (!call || call.status !== "completed") {
      const why = call?.error ? `: ${call.error}` : "";
      // OutLayer ended the run at its limit, in its own words and with its own number: the model was still thinking.
      const ended = call?.status === "failed" ? RUN_OUT_OF_TIME.exec(call.error ?? "") : null;
      if (ended) return miss("out-of-time", `the mind ran out of time: OutLayer ended its run (${ended[0]})`);
      return miss("unreachable", `the mind's run is ${call?.status ?? "unreadable"}${why}`);
    }
    // The module writes `{ success, output, error }`; OutLayer hands that back as the run's output.
    const wrapped = call.output as { success?: boolean; output?: unknown; error?: string | null } | null;
    const played = (wrapped && typeof wrapped === "object" && "success" in wrapped ? wrapped.output : wrapped) as Played | null;
    if (wrapped && typeof wrapped === "object" && "success" in wrapped && !wrapped.success) {
      const why = wrapped.error ?? "no reason";
      return MODULE_OUT_OF_TIME.test(why) ? miss("out-of-time", `the mind ran out of time: ${why}`) : miss("refused", `the mind refused: ${why}`);
    }
    if (!played || typeof played !== "object" || !played.usage) return miss("unreachable", "the mind's answer is unreadable");
    this.#count(played);
    if (played.plan === null || played.plan === undefined) {
      const why = played.error ?? "the mind gave no plan";
      return miss(MODULE_OUT_OF_TOKENS.test(why) ? "out-of-tokens" : "no-plan", why);
    }
    const plan = Plan.safeParse(played.plan);
    if (!plan.success) return miss("no-plan", "the mind's plan does not fit the plan format");
    if (plan.data.steps.length > challenge.manifest.limits.max_steps) return miss("no-plan", "the mind's plan is too long");
    return { ok: true, plan: plan.data };
  }

  #count(played: Played) {
    // The module's counts come in whole steps and never above the allowance; anything else is not believed.
    const whole = (n: unknown, most: number) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), most) : 0);
    const promptTokens = whole(played.usage.prompt_tokens, PROMPT_TOKENS_CEILING);
    const usage = {
      promptTokens,
      completionTokens: whole(played.usage.completion_tokens, MIND_LIMITS.maxTokens),
      cachedTokens: whole(played.usage.cached_tokens, promptTokens),
    };
    this.#spend.calls += 1;
    this.#spend.usd += costUsd(this.#o.model, usage);
    this.#spend.tokens.promptTokens += usage.promptTokens;
    this.#spend.tokens.completionTokens += usage.completionTokens;
    this.#spend.tokens.cachedTokens += usage.cachedTokens;
  }
}

/** A person's mask armed for the round, as the keeper's job hands it to the race job (`HUMAN_MASKS`). */
export interface HumanMask {
  readonly name: string;
  readonly account: string;
  readonly model: string;
  readonly style: string;
}

/** `HUMAN_MASKS` as the arm job wrote it: only well-formed entries. */
export function humanMasksFrom(text: string | undefined): HumanMask[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (h): h is HumanMask =>
      !!h &&
      typeof h === "object" &&
      /^[a-z][a-z0-9]{2,15}$/.test((h as HumanMask).name) &&
      typeof (h as HumanMask).account === "string" &&
      (h as HumanMask).account.startsWith(`${(h as HumanMask).name}.`) &&
      typeof (h as HumanMask).model === "string" &&
      typeof (h as HumanMask).style === "string",
  );
}
