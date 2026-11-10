// A small client for the Agent Market REST API (market.near.ai). Public reads need nothing; the worker calls carry the
// agent's `aat_` token. The token pins one agent and can neither move money nor act as its owner account: creating a
// competition, hiring and changing the listing stay with the owner, in the web app.
import type {
  AgentPublic,
  ApiErrorBody,
  CompetitionView,
  DeclineRequest,
  Job,
  JobAssignment,
  MyAssignments,
  PlatformStats,
  PricingPlan,
  StartResponse,
  SubmitRequest,
  X402Recipients,
} from "./api.ts";

export const MARKET_ORIGIN = "https://market.near.ai";

/** The Markdown of one submit: 256 KiB, as the API counts it (bytes). */
export const MAX_DELIVERABLE_BYTES = 256 * 1024;

export class MarketError extends Error {
  /** HTTP status; 0 when no answer came. */
  readonly status: number;
  /** The API's machine code (`unauthorized`, `invalid_state_transition`, …), or `network` / `timeout` / `http_<status>`. */
  readonly code: string;
  /** 5xx, 429 and transport failures: the same request may succeed later. A 4xx is ours to fix. */
  readonly retryable: boolean;
  /** Seconds the API asked us to wait, when it said. */
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, retryAfter: number | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = "MarketError";
    this.status = status;
    this.code = code;
    this.retryable = status === 0 || status === 429 || status >= 500;
    this.retryAfter = retryAfter;
  }
}

export interface MarketClientOptions {
  /** Default `https://market.near.ai`. */
  origin?: string;
  /** The agent's API token, `aat_…`. Only the worker calls need it. */
  token?: string;
  fetch?: typeof fetch;
  /** Per request. Default 20 s. */
  timeoutMs?: number;
}

export interface AssignmentQuery {
  /** `in_progress` (the API's default), any assignment status, or `all`. */
  status?: string;
  limit?: number;
  offset?: number;
}

export interface BrowseQuery {
  q?: string;
  category?: string;
  sort?: "delivered" | "recent";
  limit?: number;
  offset?: number;
}

/** A token as the API issues it: `aat_` and then letters or digits. Catches a pasted `Bearer …` or a stray newline. */
export function tokenOk(token: string): boolean {
  return /^aat_[A-Za-z0-9]{16,128}$/.test(token);
}

function codeOf(status: number, body: unknown): { code: string; message: string; retryAfter: number | null } {
  if (body && typeof body === "object" && typeof (body as ApiErrorBody).error === "string") {
    const b = body as ApiErrorBody;
    return { code: b.error, message: b.message ?? b.error, retryAfter: typeof b.retry_after === "number" ? b.retry_after : null };
  }
  return { code: `http_${status}`, message: typeof body === "string" && body ? body.slice(0, 300) : `HTTP ${status}`, retryAfter: null };
}

export class MarketClient {
  readonly origin: string;
  readonly #token: string | null;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: MarketClientOptions = {}) {
    this.origin = (options.origin ?? MARKET_ORIGIN).replace(/\/+$/, "");
    const token = options.token?.trim();
    if (token !== undefined && token !== "" && !tokenOk(token)) {
      throw new Error("the Agent Market token must look like aat_… (letters and digits only, no `Bearer`)");
    }
    this.#token = token ? token : null;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  get hasToken(): boolean {
    return this.#token !== null;
  }

  async #request<T>(method: string, path: string, opts: { body?: unknown; auth?: boolean; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    const url = new URL(this.origin + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.auth) {
      if (!this.#token) throw new MarketError(401, "no_token", `${method} ${path} needs the agent's aat_ token`);
      headers["authorization"] = `Bearer ${this.#token}`;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const why = timeout ? `no answer in ${this.#timeoutMs} ms` : error instanceof Error ? error.message : String(error);
      throw new MarketError(0, timeout ? "timeout" : "network", `${method} ${path}: ${why}`, null, { cause: error });
    }

    const text = await res.text();
    let body: unknown = text;
    if (text && (res.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const { code, message, retryAfter } = codeOf(res.status, body);
      const header = Number(res.headers.get("retry-after"));
      throw new MarketError(res.status, code, `${method} ${path}: ${res.status} ${message}`, retryAfter ?? (Number.isFinite(header) && header > 0 ? header : null));
    }
    return body as T;
  }

  // --- public, no token ---

  stats(): Promise<PlatformStats> {
    return this.#request("GET", "/v1/platform/stats");
  }

  /** The networks, assets and treasury addresses x402 payments settle into. */
  x402Recipients(): Promise<X402Recipients> {
    return this.#request("GET", "/.well-known/x402");
  }

  /** A published agent by handle or id; `null` when there is none (or it is not live to the public). */
  async agent(handleOrId: string): Promise<AgentPublic | null> {
    try {
      return await this.#request<AgentPublic>("GET", `/v1/agents/${encodeURIComponent(handleOrId)}`);
    } catch (error) {
      if (error instanceof MarketError && error.status === 404) return null;
      throw error;
    }
  }

  /** The agent's plans; the public sees only the live ones. The 402 quotes the one with `is_default`. */
  pricingPlans(agentId: string): Promise<PricingPlan[]> {
    return this.#request("GET", `/v1/agents/${encodeURIComponent(agentId)}/pricing-plans`);
  }

  async browseAgents(query: BrowseQuery = {}): Promise<AgentPublic[]> {
    const out = await this.#request<{ agents: AgentPublic[] }>("GET", "/v1/agents", { query: { ...query } });
    return out.agents;
  }

  // --- the agent's own work, `aat_` token ---

  /** The agent's assignments, newest first, each with its job brief and latest thread message. */
  async assignments(query: AssignmentQuery = {}): Promise<MyAssignments> {
    return this.#request("GET", "/v1/agents/me/assignments", { auth: true, query: { ...query } });
  }

  /** Declares the work started. Idempotent; until it is called the buyer may cancel at any moment. */
  start(assignmentId: string): Promise<StartResponse> {
    return this.#request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/start`, { auth: true, body: {} });
  }

  async submit(assignmentId: string, body: SubmitRequest): Promise<JobAssignment> {
    const bytes = Buffer.byteLength(body.deliverableMarkdown, "utf8");
    if (bytes < 1 || bytes > MAX_DELIVERABLE_BYTES) {
      throw new MarketError(400, "invalid_deliverable", `the deliverable is ${bytes} bytes; it must be 1 byte to 256 KiB`);
    }
    return this.#request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, { auth: true, body });
  }

  /** Hands the assignment back. The buyer is refunded in full; an A2A caller is never charged. */
  decline(assignmentId: string, body: DeclineRequest): Promise<JobAssignment> {
    return this.#request("POST", `/v1/assignments/${encodeURIComponent(assignmentId)}/decline`, { auth: true, body: { ...body, ...(body.detail ? { detail: body.detail.slice(0, 1000) } : {}) } });
  }

  /** A job the agent may see (public, or one it takes part in). */
  job(jobId: string): Promise<Job> {
    return this.#request("GET", `/v1/jobs/${encodeURIComponent(jobId)}`, { auth: true });
  }

  /** A competition's state and counts. Any token reads the counts; entries only for the parties. */
  competition(jobId: string): Promise<CompetitionView> {
    return this.#request("GET", `/v1/jobs/${encodeURIComponent(jobId)}/entries`, { auth: true });
  }
}
