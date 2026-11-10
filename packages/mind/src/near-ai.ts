/**
 * NEAR AI Cloud client: OpenAI-compatible chat completions, Private TEE models only.
 *
 * - Canonical model IDs plus `x-no-aliasing: true`: an alias would change who signs the answer.
 * - No streaming: a non-streamed answer is signed by the model TEE (`provider_tee`), a stream only by the gateway.
 * - One deadline for the whole call. A late model is the caller's cue to play the default, not to wait.
 * - After the answer, fetch its signature and check it: signed text = `model:sha256(request):sha256(response)`, signer
 *   recovered with EIP-191 and compared with the TEE addresses the attestation report named.
 */
import { recoverAddress } from "./eth.ts";
import { NEAR_AI_BASE_URL, costUsd, isTeeModel } from "./models.ts";
import {
  ProviderError,
  sha256Hex,
  sleep,
  type Completion,
  type CompletionRequest,
  type Provider,
  type ResponseSignature,
} from "./provider.ts";

export interface NearAiOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Model TEE signing addresses from a fresh attestation report. Without them a signature is logged, not verified. */
  readonly trustedSigners?: readonly string[];
  readonly fetch?: typeof fetch;
}

export class NearAiProvider implements Provider {
  readonly id = "near-ai";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  #signers: Set<string>;

  constructor(options: NearAiOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? NEAR_AI_BASE_URL).replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#signers = new Set((options.trustedSigners ?? []).map((a) => a.toLowerCase()));
  }

  /** Replace the trusted model TEE signers, e.g. after a fresh attestation. */
  trust(signers: readonly string[]): void {
    this.#signers = new Set(signers.map((a) => a.toLowerCase()));
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (!isTeeModel(request.model)) {
      throw new ProviderError("shape", `${request.model} is not a Private TEE model on the allow list`);
    }
    const deadline = Date.now() + request.timeoutMs;
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: false,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    });
    const responseText = await this.#call(`${this.#baseUrl}/chat/completions`, deadline, {
      method: "POST",
      headers: this.#headers({ "content-type": "application/json" }),
      body,
    });

    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(responseText) as ChatResponse;
    } catch {
      throw new ProviderError("shape", "completion is not JSON");
    }
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new ProviderError("shape", "completion has no message content");
    if (parsed.model && parsed.model !== request.model) {
      throw new ProviderError("shape", `answered by ${parsed.model}, asked for ${request.model}`);
    }
    const usage = {
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      cachedTokens: parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    const requestHash = sha256Hex(body);
    const responseHash = sha256Hex(responseText);

    let signature: ResponseSignature | null = null;
    if (parsed.id) signature = await this.#signature(parsed.id, request.model, deadline).catch(() => null);
    const signatureVerified = signature
      ? checkSignature(signature, { model: request.model, requestHash, responseHash, signers: this.#signers })
      : false;

    return {
      text,
      model: request.model,
      requestHash,
      responseHash,
      usage,
      costUsd: costUsd(request.model, usage),
      signature,
      signatureVerified,
    };
  }

  /** The signature is cached on the TEE node that answered; a lookup can land elsewhere and 404 for a moment. */
  async #signature(chatId: string, model: string, deadline: number): Promise<ResponseSignature> {
    const url = `${this.#baseUrl}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
    for (;;) {
      try {
        const raw = JSON.parse(await this.#call(url, deadline, { headers: this.#headers({}) })) as SignatureResponse;
        if (typeof raw.text !== "string" || typeof raw.signature !== "string") {
          throw new ProviderError("shape", "signature response is incomplete");
        }
        return {
          text: raw.text,
          signature: raw.signature,
          signingAddress: raw.signing_address ?? "",
          signingAlgo: raw.signing_algo ?? "ecdsa",
          kind:
            raw.signature_kind === "gateway" || raw.signature_kind === "provider_tee"
              ? raw.signature_kind
              : raw.text.split(":").length === 3
                ? "provider_tee"
                : "gateway",
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
    try {
      response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(left) });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new ProviderError("timeout", `no answer in ${left}ms`);
      throw new ProviderError("network", (error as Error).message);
    }
    const text = await response.text();
    if (!response.ok) throw new ProviderError("http", `${response.status} ${text.slice(0, 200)}`, response.status);
    return text;
  }
}

/** A model TEE signature that commits to this model, these exact bytes, and a signer the attestation named. */
export function checkSignature(
  signature: ResponseSignature,
  expected: { model: string; requestHash: string; responseHash: string; signers: ReadonlySet<string> },
): boolean {
  if (signature.kind !== "provider_tee") return false;
  const parts = signature.text.split(":");
  if (parts.length !== 3) return false;
  const [model, req, res] = parts;
  if (model !== expected.model || req !== expected.requestHash || res !== expected.responseHash) return false;
  const signer = recoverAddress(signature.text, signature.signature);
  if (!signer) return false;
  if (signature.signingAddress && signature.signingAddress.toLowerCase() !== signer) return false;
  return expected.signers.has(signer);
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: { message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

interface SignatureResponse {
  text?: unknown;
  signature?: unknown;
  signing_address?: string;
  signing_algo?: string;
  signature_kind?: string;
}
