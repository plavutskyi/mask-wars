// Один інтерфейс для проду й фейка. Методи один до одного з ендпоінтами Agent API.
import { AgentApiError, AgentApiTransportError } from "./errors.ts";
import type {
  AgentPage,
  AgentView,
  BalanceSource,
  BalancesView,
  DepositRequest,
  ErrorDocument,
  OperationProof,
  QuoteResponse,
  StatusResponse,
  SwapRequest,
  TokenView,
  TransferRequest,
  WalletView,
  WithdrawRequest,
} from "./types.ts";

export interface Keyed {
  idempotencyKey: string;
}

export interface AgentApiPort {
  /** GET /v1/tokens — публічний каталог активів. */
  getTokens(): Promise<TokenView[]>;
  /** GET /v1/agents */
  listAgents(query?: { external_user_id?: string; cursor?: string }): Promise<AgentPage>;
  /** GET /v1/agents/{id} */
  getAgent(agentId: string): Promise<AgentView>;
  /** GET /v1/agents/{id}/wallet */
  getWallet(agentId: string): Promise<WalletView>;
  /** GET /v1/agents/{id}/balances */
  getBalances(agentId: string, query?: { source?: BalanceSource; asset?: string }): Promise<BalancesView>;
  /** POST /v1/agents/{id}/swap з `dry: true`. Без ключа й без grant. */
  quoteSwap(agentId: string, body: Omit<SwapRequest, "dry">): Promise<QuoteResponse>;
  /** POST /v1/agents/{id}/swap */
  swap(agentId: string, body: Omit<SwapRequest, "dry">, keyed: Keyed): Promise<StatusResponse>;
  /** POST /v1/agents/{id}/transfer */
  transfer(agentId: string, body: TransferRequest, keyed: Keyed): Promise<StatusResponse>;
  /** POST /v1/agents/{id}/withdraw; `dry: true` теж потребує ключа й рахується в custody. */
  withdraw(agentId: string, body: WithdrawRequest, keyed: Keyed): Promise<StatusResponse | QuoteResponse>;
  /** POST /v1/agents/{id}/deposit — grant не потрібен. */
  deposit(agentId: string, body: DepositRequest, keyed: Keyed): Promise<StatusResponse>;
  /** GET /v1/status; `waitMs` ≤ 30 000 — довге опитування. */
  getStatus(correlationId: string, options?: { waitMs?: number; refresh?: boolean }): Promise<StatusResponse>;
  /** GET /v1/agents/{id}/operations/{correlation_id}/proof */
  getOperationProof(agentId: string, correlationId: string): Promise<OperationProof>;
}

export const PROD_BASE_URL = "https://api.agentsonintents.com";

export interface HttpAgentApiOptions {
  apiKey: string;
  /** Grant-токен на кожного агента: `ngt_…`. Лише backend. */
  grants?: Readonly<Record<string, string>>;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Свопи й перекази тримають запит до ~2 хв. */
  settlementTimeoutMs?: number;
  timeoutMs?: number;
}

type Method = "GET" | "POST";

interface Call {
  method: Method;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  grantFor?: string;
  settlement?: boolean;
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function assertIdempotencyKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error(`Idempotency-Key must match ${KEY_PATTERN}`);
}

export class HttpAgentApi implements AgentApiPort {
  readonly #options: HttpAgentApiOptions;
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(options: HttpAgentApiOptions) {
    const url = new URL(options.baseUrl ?? PROD_BASE_URL);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("baseUrl must use HTTPS");
    if (!options.apiKey) throw new Error("apiKey is required");
    this.#options = options;
    this.#origin = url.origin;
    this.#fetch = options.fetch ?? fetch;
  }

  getTokens(): Promise<TokenView[]> {
    return this.#call<{ data: TokenView[] }>({ method: "GET", path: "/v1/tokens" }).then((r) => r.data);
  }

  listAgents(query: { external_user_id?: string; cursor?: string } = {}): Promise<AgentPage> {
    return this.#call({ method: "GET", path: "/v1/agents", query });
  }

  getAgent(agentId: string): Promise<AgentView> {
    return this.#call({ method: "GET", path: `/v1/agents/${enc(agentId)}` });
  }

  getWallet(agentId: string): Promise<WalletView> {
    return this.#call({ method: "GET", path: `/v1/agents/${enc(agentId)}/wallet` });
  }

  getBalances(agentId: string, query: { source?: BalanceSource; asset?: string } = {}): Promise<BalancesView> {
    return this.#call({ method: "GET", path: `/v1/agents/${enc(agentId)}/balances`, query });
  }

  quoteSwap(agentId: string, body: Omit<SwapRequest, "dry">): Promise<QuoteResponse> {
    return this.#call({ method: "POST", path: `/v1/agents/${enc(agentId)}/swap`, body: { ...body, dry: true } });
  }

  swap(agentId: string, body: Omit<SwapRequest, "dry">, keyed: Keyed): Promise<StatusResponse> {
    return this.#money(agentId, "swap", body, keyed);
  }

  transfer(agentId: string, body: TransferRequest, keyed: Keyed): Promise<StatusResponse> {
    return this.#money(agentId, "transfer", body, keyed);
  }

  withdraw(agentId: string, body: WithdrawRequest, keyed: Keyed): Promise<StatusResponse | QuoteResponse> {
    return this.#money(agentId, "withdraw", body, keyed);
  }

  deposit(agentId: string, body: DepositRequest, keyed: Keyed): Promise<StatusResponse> {
    assertIdempotencyKey(keyed.idempotencyKey);
    return this.#call({
      method: "POST",
      path: `/v1/agents/${enc(agentId)}/deposit`,
      body,
      idempotencyKey: keyed.idempotencyKey,
    });
  }

  getStatus(correlationId: string, options: { waitMs?: number; refresh?: boolean } = {}): Promise<StatusResponse> {
    return this.#call({
      method: "GET",
      path: "/v1/status",
      query: { correlation_id: correlationId, wait_ms: options.waitMs, refresh: options.refresh },
    });
  }

  getOperationProof(agentId: string, correlationId: string): Promise<OperationProof> {
    return this.#call({ method: "GET", path: `/v1/agents/${enc(agentId)}/operations/${enc(correlationId)}/proof` });
  }

  #money<T>(agentId: string, action: string, body: unknown, keyed: Keyed): Promise<T> {
    assertIdempotencyKey(keyed.idempotencyKey);
    return this.#call({
      method: "POST",
      path: `/v1/agents/${enc(agentId)}/${action}`,
      body,
      idempotencyKey: keyed.idempotencyKey,
      grantFor: agentId,
      settlement: (body as { dry?: boolean }).dry !== true,
    });
  }

  async #call<T>(call: Call): Promise<T> {
    const url = new URL(this.#origin + call.path);
    for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json", "x-api-key": this.#options.apiKey };
    if (call.body !== undefined) headers["content-type"] = "application/json";
    if (call.idempotencyKey) headers["idempotency-key"] = call.idempotencyKey;
    if (call.grantFor) {
      const grant = this.#options.grants?.[call.grantFor];
      if (!grant) throw new Error(`no grant token for agent ${call.grantFor}`);
      headers["x-grant-token"] = grant;
    }
    const timeout = call.settlement ? (this.#options.settlementTimeoutMs ?? 150_000) : (this.#options.timeoutMs ?? 65_000);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url, {
        method: call.method,
        headers,
        body: call.body === undefined ? null : JSON.stringify(call.body),
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
        credentials: "omit",
      });
      text = await response.text();
    } catch (error) {
      throw new AgentApiTransportError(error, call.idempotencyKey);
    }
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch (error) {
      if (response.ok) throw new AgentApiTransportError(error, call.idempotencyKey);
    }
    if (!response.ok) {
      throw new AgentApiError(response.status, json as ErrorDocument | undefined, call.idempotencyKey, response.headers.get("retry-after"));
    }
    return json as T;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
