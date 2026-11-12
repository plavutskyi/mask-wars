/**
 * The 1Click API of NEAR Intents (https://1click.chaindefuser.com/v0): the token list, a quote with its deposit
 * address, the swap's status, and the signed-intent pair that spends from a NEAR Intents balance. Types are the subset
 * this app reads, as `@defuse-protocol/one-click-sdk-typescript` 0.1.26 declares them. The partner key, when there is
 * one, stays on the server.
 */

export const ONE_CLICK = "https://1click.chaindefuser.com";

export type DepositType = "ORIGIN_CHAIN" | "INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS";
export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";

export interface Token {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  readonly price: number;
  readonly priceUpdatedAt?: string;
  readonly contractAddress?: string;
}

export interface QuoteRequest {
  readonly dry: boolean;
  readonly swapType: SwapType;
  readonly slippageTolerance: number;
  readonly originAsset: string;
  readonly depositType: DepositType;
  readonly destinationAsset: string;
  readonly amount: string;
  readonly refundTo: string;
  readonly refundType: DepositType;
  readonly recipient: string;
  readonly recipientType: RecipientType;
  readonly deadline: string;
  readonly referral?: string;
  readonly quoteWaitingTimeMs?: number;
}

export interface Quote {
  readonly depositAddress?: string;
  readonly depositMemo?: string;
  readonly amountIn: string;
  readonly amountInFormatted: string;
  readonly amountInUsd: string;
  readonly minAmountIn: string;
  readonly amountOut: string;
  readonly amountOutFormatted: string;
  readonly amountOutUsd: string;
  readonly minAmountOut: string;
  readonly deadline?: string;
  readonly timeWhenInactive?: string;
  readonly timeEstimate: number;
  readonly refundFee?: string;
  readonly withdrawFee?: string;
}

export interface QuoteResponse {
  readonly correlationId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly quoteRequest: QuoteRequest;
  readonly quote: Quote;
}

export type SwapStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED";

export interface TxRef {
  readonly hash: string;
  readonly explorerUrl: string;
}

export interface SwapDetails {
  readonly intentHashes?: readonly string[];
  readonly nearTxHashes?: readonly string[];
  readonly amountIn?: string;
  readonly amountInFormatted?: string;
  readonly amountOut?: string;
  readonly amountOutFormatted?: string;
  readonly originChainTxHashes?: readonly TxRef[];
  readonly destinationChainTxHashes?: readonly TxRef[];
  readonly refundedAmount?: string;
  readonly refundedAmountFormatted?: string;
  readonly refundReason?: string;
  readonly depositedAmount?: string;
  readonly depositedAmountFormatted?: string;
}

export interface StatusResponse {
  readonly correlationId: string;
  readonly quoteResponse: QuoteResponse;
  readonly status: SwapStatus;
  readonly updatedAt: string;
  readonly swapDetails: SwapDetails;
}

export type IntentStandard = "webauthn" | "nep413";

/** What 1Click hands back to be signed: a WebAuthn payload is a JSON string, a NEP-413 one an object. */
export type UnsignedIntent =
  | { readonly standard: "webauthn"; readonly payload: string }
  | { readonly standard: "nep413"; readonly payload: Nep413Payload };

export interface Nep413Payload {
  readonly message: string;
  /** base64, 32 bytes */
  readonly nonce: string;
  readonly recipient: string;
  readonly callbackUrl?: string | null;
}

export interface SignedWebauthn {
  readonly standard: "webauthn";
  readonly payload: string;
  /** `p256:` + base58 of the 64-byte uncompressed key */
  readonly public_key: string;
  /** `p256:` + base58 of r‖s, low-S */
  readonly signature: string;
  readonly client_data_json: string;
  /** base64url, no padding */
  readonly authenticator_data: string;
}

export interface SignedNep413 {
  readonly standard: "nep413";
  readonly payload: Nep413Payload;
  /** `ed25519:` + base58 */
  readonly public_key: string;
  /** `ed25519:` + base58 */
  readonly signature: string;
}

export type SignedIntent = SignedWebauthn | SignedNep413;

export class OneClickError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "OneClickError";
    this.status = status;
    this.body = body;
  }
}

export interface OneClickOptions {
  readonly base?: string;
  /** Partner key from partners.near-intents.org. Without it 1Click still answers and adds its own 0.25% fee. */
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class OneClick {
  private readonly base: string;
  private readonly token: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: OneClickOptions = {}) {
    this.base = (o.base ?? ONE_CLICK).replace(/\/+$/, "");
    this.token = o.token || undefined;
    this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = o.timeoutMs ?? 20_000;
  }

  tokens(): Promise<Token[]> {
    return this.call("GET", "/v0/tokens");
  }

  quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.call("POST", "/v0/quote", req);
  }

  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const q = new URLSearchParams({ depositAddress, ...(depositMemo ? { depositMemo } : {}) });
    return this.call("GET", `/v0/status?${q}`);
  }

  async generateIntent(o: { depositAddress: string; signerId: string; standard: IntentStandard }): Promise<UnsignedIntent> {
    const res = await this.call<{ intent: UnsignedIntent }>("POST", "/v0/generate-intent", { type: "swap_transfer", ...o });
    return res.intent;
  }

  /**
   * Tells 1Click the transaction that paid a deposit address, so it looks for it at once instead of waiting to see it.
   * Optional: the deposit lands either way.
   */
  submitDeposit(o: { txHash: string; depositAddress: string; memo?: string; nearSenderAccount?: string }): Promise<StatusResponse> {
    return this.call("POST", "/v0/deposit/submit", {
      txHash: o.txHash,
      depositAddress: o.depositAddress,
      ...(o.memo ? { memo: o.memo } : {}),
      // A deposit from a NEAR wallet: 1Click asks who sent it.
      ...(o.nearSenderAccount ? { nearSenderAccount: o.nearSenderAccount } : {}),
    });
  }

  submitIntent(signedData: SignedIntent): Promise<{ intentHash: string; correlationId: string }> {
    return this.call("POST", "/v0/submit-intent", { type: "swap_transfer", signedData });
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new OneClickError(0, `1Click did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: the status line says enough */
    }
    if (!res.ok) throw new OneClickError(res.status, messageOf(json) ?? `1Click answered ${res.status}`, json);
    return json as T;
  }
}

function messageOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const k of ["message", "error", "detail"]) {
    const v = b[k];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v.join("; ");
  }
  return null;
}
