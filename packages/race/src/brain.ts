/**
 * A person's mask in the race. Its mind runs on OutLayer, inside a TEE (services/brain): only there does its owner's
 * strategy open, and only from there is the mask's model on NEAR AI Cloud asked. The race job never reads the line. It
 * sends the mask, the round, the target and, of the mask's own past attempts, only each verdict and each step's method
 * and outcome to OutLayer's HTTPS API, and gets back a plan the module wrote itself (`set_owner` and `sweep` in the
 * order the model chose, with the mask's own account and the module's amount), with the tokens the model used in steps
 * of 256. The module answers only the keeper's account, the payment key's owner.
 *
 * The call is OutLayer's `POST /call/{owner}/{project}` with a payment key (`X-Payment-Key`), as the OutLayer CLI makes
 * it (`outlayer run`, out-layer/outlayer-cli `src/api.rs`), with the project's secrets attached: `PROTECTED_BRAIN_SEED`,
 * which OutLayer generated inside the TEE, and `NEAR_AI_API_KEY`. The payment key pays OutLayer for the run; it moves no
 * NEAR and signs nothing on chain.
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
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
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
  readonly calls: number;
  readonly tokens: Usage;
}

export class BrainAttacker implements Attacker {
  readonly id: string;
  readonly mask: string;
  readonly #o: BrainOptions;
  #spend = { usd: 0, calls: 0, tokens: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 } };

  constructor(options: BrainOptions) {
    this.id = options.id;
    this.mask = options.mask;
    this.#o = options;
  }

  get spent(): MindSpend {
    return { usd: this.#spend.usd, calls: this.#spend.calls, tokens: { ...this.#spend.tokens } };
  }

  async propose(challenge: Challenge, history: readonly AttemptMemory[]): Promise<PlanParse> {
    if (!BRAIN_TARGETS.has(challenge.manifest.id)) return { ok: false, error: "the mind plays only the targets it carries" };
    const [owner, project] = this.#o.project.split("/");
    if (!owner || !project) return { ok: false, error: "the mind's project is owner/name" };
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
      async: false,
      secrets_ref: { profile: this.#o.secretsProfile ?? "default", account_id: this.#o.secretsOwner ?? owner },
    };
    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${(this.#o.api ?? OUTLAYER_TESTNET_API).replace(/\/$/, "")}/call/${owner}/${project}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment-key": this.#o.paymentKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 180_000),
      });
    } catch (e) {
      return { ok: false, error: `the mind on OutLayer is unreachable: ${(e as Error).name}` };
    }
    if (!res.ok) return { ok: false, error: `the mind on OutLayer answered ${res.status}` };
    const call = (await res.json().catch(() => null)) as { status?: string; output?: unknown; error?: string | null } | null;
    if (!call || call.status !== "completed") {
      return { ok: false, error: `the mind's run is ${call?.status ?? "unreadable"}${call?.error ? `: ${call.error}` : ""}` };
    }
    // The module writes `{ success, output, error }`; OutLayer hands that back as the run's output.
    const wrapped = call.output as { success?: boolean; output?: unknown; error?: string | null } | null;
    const played = (wrapped && typeof wrapped === "object" && "success" in wrapped ? wrapped.output : wrapped) as Played | null;
    if (wrapped && typeof wrapped === "object" && "success" in wrapped && !wrapped.success) {
      return { ok: false, error: `the mind refused: ${wrapped.error ?? "no reason"}` };
    }
    if (!played || typeof played !== "object" || !played.usage) return { ok: false, error: "the mind's answer is unreadable" };
    this.#count(played);
    if (played.plan === null || played.plan === undefined) return { ok: false, error: played.error ?? "the mind gave no plan" };
    const plan = Plan.safeParse(played.plan);
    if (!plan.success) return { ok: false, error: "the mind's plan does not fit the plan format" };
    if (plan.data.steps.length > challenge.manifest.limits.max_steps) return { ok: false, error: "the mind's plan is too long" };
    return { ok: true, plan: plan.data };
  }

  #count(played: Played) {
    const usage = {
      promptTokens: played.usage.prompt_tokens ?? 0,
      completionTokens: played.usage.completion_tokens ?? 0,
      cachedTokens: played.usage.cached_tokens ?? 0,
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
