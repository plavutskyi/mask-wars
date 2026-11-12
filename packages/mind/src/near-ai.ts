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
  type Billed,
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
    const bill: { id: string | null } = { id: null };
    let responseText: string;
    try {
      responseText = await this.#call(
        `${this.#baseUrl}/chat/completions`,
        deadline,
        { method: "POST", headers: this.#headers({ "content-type": "application/json" }), body },
        (headers) => {
          bill.id = billId(headers.get("inference-id"));
        },
      );
    } catch (e) {
      // NEAR AI took the call and named it, and the answer ran out of time on its way: NEAR AI bills it all the same,
      // and its id is all there is to price it by.
      if (e instanceof ProviderError && (e.code === "timeout" || e.code === "network") && bill.id) {
        throw new ProviderError(e.code, e.message, e.status, { model: request.model, usage: NO_USAGE, costUsd: 0, inferenceId: bill.id, cut: true });
      }
      throw e;
    }

    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(responseText) as ChatResponse;
    } catch {
      throw new ProviderError("shape", "completion is not JSON", undefined, bill.id ? { model: request.model, usage: NO_USAGE, costUsd: 0, inferenceId: bill.id } : undefined);
    }
    const usage = {
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      cachedTokens: parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    // An answer that is no use is still an answer NEAR AI bills: the error carries what it counted, for the caller's tab.
    const billed: Billed = { model: request.model, usage, costUsd: costUsd(request.model, usage), ...(bill.id ? { inferenceId: bill.id } : {}) };
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      // A reasoning model that runs out of tokens while it thinks answers with no content at all.
      const cut = parsed.choices?.[0]?.finish_reason === "length";
      throw new ProviderError("shape", cut ? `the model spent all ${request.maxTokens} tokens before it answered` : "completion has no message content", undefined, billed);
    }
    if (parsed.model && parsed.model !== request.model) {
      throw new ProviderError("shape", `answered by ${parsed.model}, asked for ${request.model}`, undefined, billed);
    }
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
      ...(bill.id ? { inferenceId: bill.id } : {}),
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

  async #call(url: string, deadline: number, init: RequestInit, onHeaders?: (headers: Headers) => void): Promise<string> {
    const left = deadline - Date.now();
    if (left <= 0) throw new ProviderError("timeout", "deadline passed");
    let response: Response;
    const failed = (error: unknown): ProviderError => {
      const name = (error as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") return new ProviderError("timeout", `no answer in ${left}ms`);
      return new ProviderError("network", (error as Error).message);
    };
    try {
      response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(left) });
    } catch (error) {
      throw failed(error);
    }
    // The headers of a call the provider took come before its body: what they name stands even if the body never does.
    if (response.ok) onHeaders?.(response.headers);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw failed(error);
    }
    if (!response.ok) throw new ProviderError("http", `${response.status} ${text.slice(0, 200)}`, response.status);
    return text;
  }
}

const NO_USAGE = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 } as const;

/** NEAR AI's bill names an answer by the UUID in its `inference-id` header; anything else is not an id. */
const BILL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const billId = (v: string | null): string | null => (v && BILL_ID.test(v.trim()) ? v.trim().toLowerCase() : null);

/** The most ids one `POST /v1/billing/costs` is asked about. */
const COSTS_AT_ONCE = 50;

export interface CostsOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * What NEAR AI's bill says each answer cost, in nano-dollars, by `inference-id` (`POST /v1/billing/costs`,
 * `{"requestIds": [...]}` → `{"requests": [{"requestId", "costNanoUsd"}]}`). An id the bill does not know yet comes
 * back as 0 with a warning ("usage for a just-finished request can take a few seconds to become visible"): it is left
 * out, for the caller to ask again or to price from the answer's tokens. A batch that fails leaves its ids out too.
 */
export async function nearAiCosts(ids: readonly string[], o: CostsOptions): Promise<Map<string, bigint>> {
  const base = (o.baseUrl ?? NEAR_AI_BASE_URL).replace(/\/$/, "");
  const want = [...new Set(ids.map((id) => billId(id)).filter((id): id is string => id !== null))];
  const out = new Map<string, bigint>();
  for (let i = 0; i < want.length; i += COSTS_AT_ONCE) {
    const batch = want.slice(i, i + COSTS_AT_ONCE);
    try {
      const res = await (o.fetch ?? fetch)(`${base}/billing/costs`, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ requestIds: batch }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { requests?: { requestId?: unknown; costNanoUsd?: unknown }[] };
      for (const r of body.requests ?? []) {
        const id = billId(typeof r.requestId === "string" ? r.requestId : null);
        const nano = r.costNanoUsd;
        if (!id || !batch.includes(id) || typeof nano !== "number" || !Number.isSafeInteger(nano) || nano <= 0) continue;
        out.set(id, BigInt(nano));
      }
    } catch {
      // The bill did not answer: these ids are priced from their tokens.
    }
  }
  return out;
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
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

interface SignatureResponse {
  text?: unknown;
  signature?: unknown;
  signing_address?: string;
  signing_algo?: string;
  signature_kind?: string;
}
