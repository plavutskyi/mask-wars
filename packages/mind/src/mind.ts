/**
 * The mind of one mask. Two calls per fight phase, never per tick: one seal before the bell, then one HOLD/ROTATE per
 * minute until the rotate is spent. Every answer is checked; anything late, malformed or against the rules becomes the
 * mask's default move and the fight goes on. Every call leaves a journal entry.
 */
import {
  defaultMinute,
  defaultSeal,
  readMinute,
  readSeal,
  type Checked,
  type MinuteContext,
  type MinuteProposal,
  type SealContext,
  type SealProposal,
} from "./decision.ts";
import type { Journal } from "./journal.ts";
import { minutePrompt, sealPrompt, type PromptExtras } from "./prompt.ts";
import { ProviderError, withDeadline, type ChatMessage, type Completion, type Provider } from "./provider.ts";

export interface MindOptions {
  readonly provider: Provider;
  readonly model: string;
  readonly journal: Journal;
  /** Deadline for a seal: masks think in the 30 s between book close and bell. Default 12 s. */
  readonly sealTimeoutMs?: number;
  /** Deadline for a minute move. Default 6 s. */
  readonly minuteTimeoutMs?: number;
  readonly now?: () => number;
}

export interface Decided<T> {
  readonly move: T;
  readonly source: "model" | "default";
  readonly reason: string;
}

export class Mind {
  readonly #o: Required<MindOptions>;

  constructor(options: MindOptions) {
    this.#o = { sealTimeoutMs: 12_000, minuteTimeoutMs: 6_000, now: Date.now, ...options };
  }

  async seal(fightId: string, ctx: SealContext, extras: PromptExtras = {}): Promise<Decided<SealProposal>> {
    return this.#decide(
      "seal",
      fightId,
      ctx.mask,
      sealPrompt(ctx, extras),
      this.#o.sealTimeoutMs,
      120,
      (text) => readSeal(ctx.mask, text),
      () => defaultSeal(ctx),
    );
  }

  async minute(fightId: string, ctx: MinuteContext, extras: PromptExtras = {}): Promise<Decided<MinuteProposal>> {
    // A spent rotate leaves nothing to decide: no call, no cost.
    if (ctx.rotated) return { move: { action: "HOLD" }, source: "default", reason: "rotate already used" };
    return this.#decide(
      "minute",
      fightId,
      ctx.mask,
      minutePrompt(ctx, extras),
      this.#o.minuteTimeoutMs,
      60,
      (text) => readMinute(ctx, text),
      () => defaultMinute(ctx),
    );
  }

  async #decide<T>(
    kind: "seal" | "minute",
    fightId: string,
    mask: string,
    messages: ChatMessage[],
    timeoutMs: number,
    maxTokens: number,
    read: (text: string) => Checked<T>,
    fallback: () => T,
  ): Promise<Decided<T>> {
    const started = this.#o.now();
    let completion: Completion | null = null;
    let decided: Decided<T>;
    try {
      // The provider owns its deadline; this guard catches one that does not keep it.
      const work = this.#o.provider.complete({ model: this.#o.model, messages, maxTokens, temperature: 0.4, timeoutMs });
      completion = (await withDeadline(work, timeoutMs + 250, () => null)).value;
      if (!completion) decided = { move: fallback(), source: "default", reason: `timeout: no answer in ${timeoutMs}ms` };
      else {
        const checked = read(completion.text);
        decided = checked.ok
          ? { move: checked.value, source: "model", reason: "" }
          : { move: fallback(), source: "default", reason: checked.reason };
      }
    } catch (error) {
      const reason = error instanceof ProviderError ? `${error.code}: ${error.message}` : `error: ${String(error)}`;
      decided = { move: fallback(), source: "default", reason };
    }
    await this.#o.journal.write({
      at: started,
      fightId,
      mask,
      kind,
      provider: this.#o.provider.id,
      model: this.#o.model,
      requestHash: completion?.requestHash ?? null,
      responseHash: completion?.responseHash ?? null,
      signature: completion?.signature ?? null,
      signatureVerified: completion?.signatureVerified ?? false,
      costUsd: completion?.costUsd ?? 0,
      latencyMs: this.#o.now() - started,
      source: decided.source,
      reason: decided.reason,
      outcome: JSON.stringify(decided.move),
    });
    return decided;
  }
}
