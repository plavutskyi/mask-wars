/**
 * A provider is where a mask thinks. NEAR AI Cloud lives here; Claude and Codex plug in separately through the same
 * interface, each with its own client, so nothing here pretends to speak for them.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Usage } from "./models.ts";

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface CompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly temperature: number;
  /** Hard deadline for the whole call, signature included. */
  readonly timeoutMs: number;
}

/** What a TEE signed about one completion. */
export interface ResponseSignature {
  /** `model:request_sha256:response_sha256` (model TEE) or `request_sha256:response_sha256` (gateway). */
  readonly text: string;
  readonly signature: string;
  readonly signingAddress: string;
  readonly signingAlgo: string;
  readonly kind: "provider_tee" | "gateway";
}

export interface Completion {
  /** The model's reply text. */
  readonly text: string;
  /** The model the provider says answered. */
  readonly model: string;
  /** sha256 of the exact request bytes sent. */
  readonly requestHash: string;
  /** sha256 of the exact response bytes received. */
  readonly responseHash: string;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly signature: ResponseSignature | null;
  /** True only when the signature was checked against the hashes and a known TEE signer. */
  readonly signatureVerified: boolean;
}

export interface Provider {
  /** Stable name for the journal: `near-ai`, `claude`, `codex`, `fake`. */
  readonly id: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

export class ProviderError extends Error {
  readonly code: "timeout" | "http" | "shape" | "network";
  readonly status: number | undefined;
  constructor(code: ProviderError["code"], message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/**
 * A provider that answers from a script. For tests and for `pnpm demo` without keys: it never touches the network.
 * Each entry is a reply text, an Error to throw, or a delay before a reply.
 */
export type FakeStep = string | Error | { readonly delayMs: number; readonly text: string };

export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly requests: CompletionRequest[] = [];
  readonly #steps: FakeStep[];
  readonly #fallback: string;

  constructor(steps: readonly FakeStep[] = [], fallback = "") {
    this.#steps = [...steps];
    this.#fallback = fallback;
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    this.requests.push(request);
    const step = this.#steps.shift() ?? this.#fallback;
    if (step instanceof Error) throw step;
    let text: string;
    if (typeof step === "string") text = step;
    else {
      if (step.delayMs >= request.timeoutMs) {
        await sleep(request.timeoutMs);
        throw new ProviderError("timeout", `fake provider exceeded ${request.timeoutMs}ms`);
      }
      await sleep(step.delayMs);
      text = step.text;
    }
    const body = JSON.stringify({ model: request.model, messages: request.messages });
    return {
      text,
      model: request.model,
      requestHash: sha256Hex(body),
      responseHash: sha256Hex(text),
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      costUsd: 0,
      signature: null,
      signatureVerified: false,
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve with the promise, or with `fallback()` once `ms` pass. The slow promise is left to settle on its own. */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<{ value: T; late: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ value: T; late: boolean }>((resolve) => {
    timer = setTimeout(() => resolve({ value: fallback(), late: true }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ value, late: false })), late]);
  } finally {
    clearTimeout(timer);
  }
}
