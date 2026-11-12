// The model that writes pages, on NEAR AI Cloud: the same signed exchange as `@maskwars/mind`'s client (no streaming,
// canonical model id with no aliasing, the answer's signature fetched and checked against the attested signers), with
// one difference. The TEE models reason before they answer, and on a page's facts they reason for minutes: thousands
// of tokens and no answer inside a server's minute. A page is a summary of facts already decided by code, so the
// request asks for the answer with no reasoning (`chat_template_kwargs.thinking: false`), and the request a stored page
// carries must ask the same (write.ts `requestProblem`).

import {
  NEAR_AI_BASE_URL,
  ProviderError,
  type Completion,
  type CompletionRequest,
  type Provider,
  type ResponseSignature,
  type TeeModel,
  checkSignature,
  costUsd,
  isTeeModel,
  sha256Hex,
  sleep,
} from "@maskwars/mind";

/** What every page request asks of the chat template: the answer, no reasoning before it. */
export const TEMPLATE = Object.freeze({ thinking: false });

/**
 * The models that honour it, measured on NEAR AI Cloud on 11.11.2026: DeepSeek V4.1 Flash answers a page in 10 to 25
 * seconds with no reasoning at all. GLM 5.3 Flash reasons all the same and Qwen 3.8 is a reasoning model: on a page's
 * facts both run past NEAR AI's thirty seconds, and no page is ever written.
 */
export const PAGE_MODELS: readonly TeeModel[] = ["deepseek-ai/DeepSeek-V4.1-Flash-1017"];

export const writesPages = (model: string): model is TeeModel => (PAGE_MODELS as readonly string[]).includes(model);

/** Time for the answer's signature after the answer: the lookup is quick, but never cut short by a slow answer. */
const SIGNATURE_MS = 6_000;

/** The exact body of a page request: the field order is part of the bytes the TEE signs. */
export function requestBody(r: Pick<CompletionRequest, "model" | "messages" | "maxTokens" | "temperature">): string {
  return JSON.stringify({
    model: r.model,
    messages: r.messages,
    stream: false,
    max_tokens: r.maxTokens,
    temperature: r.temperature,
    chat_template_kwargs: TEMPLATE,
  });
}

export interface PageModelOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Model TEE signing addresses from a fresh attestation: only their signature verifies an answer. */
  readonly trustedSigners: readonly string[];
  readonly fetch?: typeof fetch;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/** A NEAR AI Cloud client for pages: Confidential TEE models only, every answer's signature checked. */
export class PageModel implements Provider {
  readonly id = "near-ai";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #signers: ReadonlySet<string>;

  constructor(o: PageModelOptions) {
    this.#apiKey = o.apiKey;
    this.#baseUrl = (o.baseUrl ?? NEAR_AI_BASE_URL).replace(/\/$/, "");
    this.#fetch = o.fetch ?? fetch;
    this.#signers = new Set(o.trustedSigners.map((a) => a.toLowerCase()));
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (!isTeeModel(request.model)) throw new ProviderError("shape", `${request.model} is not a Private TEE model on the allow list`);
    const deadline = Date.now() + request.timeoutMs;
    const body = requestBody(request);
    const responseText = await this.#call(`${this.#baseUrl}/chat/completions`, deadline, { method: "POST", headers: this.#headers({ "content-type": "application/json" }), body });

    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(responseText) as ChatResponse;
    } catch {
      throw new ProviderError("shape", "completion is not JSON");
    }
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      const cut = parsed.choices?.[0]?.finish_reason === "length";
      throw new ProviderError("shape", cut ? `the model spent all ${request.maxTokens} tokens before it answered` : "completion has no message content");
    }
    if (parsed.model && parsed.model !== request.model) throw new ProviderError("shape", `answered by ${parsed.model}, asked for ${request.model}`);
    const usage = {
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      cachedTokens: parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    const requestHash = sha256Hex(body);
    const responseHash = sha256Hex(responseText);
    // The signature's own short time: an honest answer at 28 seconds still gets its signature looked up.
    const signature = parsed.id ? await this.#signature(parsed.id, request.model, Math.max(deadline, Date.now() + SIGNATURE_MS)).catch(() => null) : null;
    const signatureVerified = signature ? checkSignature(signature, { model: request.model, requestHash, responseHash, signers: this.#signers }) : false;
    return { text, model: request.model, requestHash, responseHash, usage, costUsd: costUsd(request.model, usage), signature, signatureVerified };
  }

  /** The signature is kept on the TEE node that answered; a lookup can land elsewhere and 404 for a moment. */
  async #signature(chatId: string, model: string, deadline: number): Promise<ResponseSignature> {
    const url = `${this.#baseUrl}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
    for (;;) {
      try {
        const raw = JSON.parse(await this.#call(url, deadline, { headers: this.#headers({}) })) as Record<string, unknown>;
        if (typeof raw["text"] !== "string" || typeof raw["signature"] !== "string") throw new ProviderError("shape", "signature response is incomplete");
        const textSigned = raw["text"];
        const kind = raw["signature_kind"];
        return {
          text: textSigned,
          signature: raw["signature"],
          signingAddress: typeof raw["signing_address"] === "string" ? raw["signing_address"] : "",
          signingAlgo: typeof raw["signing_algo"] === "string" ? raw["signing_algo"] : "ecdsa",
          kind: kind === "gateway" || kind === "provider_tee" ? kind : textSigned.split(":").length === 3 ? "provider_tee" : "gateway",
        };
      } catch (error) {
        if (!(error instanceof ProviderError) || error.status !== 404 || Date.now() + 400 >= deadline) throw error;
        await sleep(300);
      }
    }
  }

  #headers(extra: Record<string, string>): Record<string, string> {
    return { accept: "application/json", authorization: `Bearer ${this.#apiKey}`, "x-no-aliasing": "true", ...extra };
  }

  async #call(url: string, deadline: number, init: RequestInit): Promise<string> {
    const left = deadline - Date.now();
    if (left <= 0) throw new ProviderError("timeout", "deadline passed");
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(left) });
      // Reading the body can time out or break off too: the same errors, so a cut-off answer is asked again.
      text = await response.text();
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ProviderError("timeout", `no answer in ${left}ms`);
      throw new ProviderError("network", (error as Error).message);
    }
    if (!response.ok) throw new ProviderError("http", `${response.status} ${text.slice(0, 200)}`, response.status);
    return text;
  }
}
