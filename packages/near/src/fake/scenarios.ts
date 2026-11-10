// Керовані сценарії фейка. Назви збігаються з `pnpm demo --scenario …`.
import { AgentApiError } from "../errors.ts";
import type { ErrorDocument, ErrorLayer } from "../types.ts";

/**
 * - `ok`: звичайний SUCCESS.
 * - `refunded`: маршрут повернув вхід.
 * - `failed`: не виконано, FAILED із кодом.
 * - `uncertain`: після відправлення результат невідомий, потім SUCCESS тим самим id.
 * - `needs_review`: вихід нижче `min_amount_out`, автоматичне завершення зупинено.
 * - `busy`: гаманець зайнятий, 409 wallet_busy.
 * - `quota`: денна квота провайдера вичерпана, 429 provider_limit_reached.
 * - `slow`: розрахунок у шість разів довший.
 */
export const SCENARIOS = ["ok", "refunded", "failed", "uncertain", "needs_review", "busy", "quota", "slow"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(value: string): value is Scenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

interface ErrorShape {
  status: number;
  layer: ErrorLayer;
  title: string;
  retryable?: boolean;
}

/** Помилки, як їх віддає Agent API (errors.md). */
export const ERROR_SHAPES: Readonly<Record<string, ErrorShape>> = {
  wallet_busy: { status: 409, layer: "provider", title: "Wallet busy" },
  provider_limit_reached: { status: 429, layer: "provider", title: "Provider limit reached" },
  policy_denied: { status: 409, layer: "policy", title: "Policy denied" },
  policy_action_denied: { status: 403, layer: "policy", title: "Action not allowed" },
  policy_limit_exceeded: { status: 403, layer: "policy", title: "Limit exceeded" },
  policy_destination_denied: { status: 403, layer: "policy", title: "Destination not allowed" },
  spend_budget_exceeded: { status: 403, layer: "budget", title: "Budget exceeded" },
  spend_price_unavailable: { status: 503, layer: "budget", title: "Price unavailable" },
  sponsor_busy: { status: 503, layer: "api", title: "Sponsor busy", retryable: true },
  insufficient_balance: { status: 400, layer: "balance", title: "Insufficient balance" },
  invalid_address: { status: 400, layer: "request", title: "Invalid address" },
  idempotency_conflict: { status: 409, layer: "request", title: "Idempotency conflict" },
  agent_not_found: { status: 404, layer: "request", title: "Agent not found" },
  operation_not_found: { status: 404, layer: "request", title: "Operation not found" },
  validation_failed: { status: 400, layer: "request", title: "Validation failed" },
  unsupported_token: { status: 400, layer: "request", title: "Unsupported token" },
  invalid_api_key: { status: 401, layer: "auth", title: "Invalid API key" },
  agent_grant_required: { status: 403, layer: "grant", title: "Grant required" },
  internal_error: { status: 500, layer: "api", title: "Internal error", retryable: true },
};

export function errorDocument(code: string, extra: { detail?: string; availableAt?: string; availableAmount?: string; retryable?: boolean } = {}): ErrorDocument {
  const shape = ERROR_SHAPES[code] ?? { status: 400, layer: "request" as const, title: code };
  const retryable = extra.retryable ?? shape.retryable ?? false;
  return {
    errors: [
      {
        status: String(shape.status),
        code,
        layer: shape.layer,
        title: shape.title,
        ...(extra.detail ? { detail: extra.detail } : {}),
        meta: {
          retryable,
          ...(extra.availableAt ? { available_at: extra.availableAt } : {}),
          ...(extra.availableAmount ? { available_amount: extra.availableAmount } : {}),
        },
      },
    ],
    meta: { request_id: "fake" },
  };
}

export function fakeError(code: string, extra: Parameters<typeof errorDocument>[1] = {}, idempotencyKey?: string): AgentApiError {
  const document = errorDocument(code, extra);
  const status = Number(document.errors[0]!.status);
  const retryAfter = status === 429 || status === 503 ? "10" : null;
  return new AgentApiError(status, document, idempotencyKey, retryAfter);
}
