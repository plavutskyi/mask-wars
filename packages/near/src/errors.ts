// Помилки Agent API і що з ними робити. Джерело: skills/near-intents-agent-api/references/errors.md.
import type { ErrorDocument, ErrorLayer } from "./types.ts";

/** Коди, на які обгортка грошей реагує окремо. Решта йде за `layer` і HTTP-класом. */
export const MONEY_ERRORS = [
  "wallet_busy",
  "provider_limit_reached",
  "policy_denied",
  "policy_action_denied",
  "policy_limit_exceeded",
  "policy_destination_denied",
  "spend_budget_exceeded",
  "spend_price_unavailable",
  "sponsor_busy",
] as const;

export type MoneyErrorCode = (typeof MONEY_ERRORS)[number];

/**
 * Що дозволено після помилки:
 * - `new_key`: доведена відмова, нічого не відправлено. Наступна спроба — нова робота з новим ключем.
 * - `same_key`: результат невідомий або сервер просить повторити. Лише той самий ключ і те саме тіло.
 * - `stop`: документована відмова, нічого не відправлено; повторювати нема сенсу, доки людина не змінить policy, бюджет чи квоту.
 * - `hold`: код про раніше надіслану роботу або незнайомий код. Результат невідомий, новий ключ заборонено.
 */
export type ErrorMove = "new_key" | "same_key" | "stop" | "hold";

export class AgentApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly layer: ErrorLayer | undefined;
  readonly retryable: boolean;
  readonly availableAt: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly minAmount: string | undefined;
  readonly availableAmount: string | undefined;
  readonly requestId: string | undefined;
  readonly idempotencyKey: string | undefined;

  constructor(status: number, document: ErrorDocument | undefined, idempotencyKey?: string, retryAfter?: string | null) {
    const first = document?.errors?.[0];
    super(first?.detail ?? first?.title ?? `HTTP ${status}`);
    this.name = "AgentApiError";
    this.status = status;
    this.code = first?.code ?? "http_error";
    this.layer = first?.layer;
    this.retryable = first?.meta?.retryable ?? false;
    this.availableAt = first?.meta?.available_at;
    this.retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : undefined;
    this.minAmount = first?.meta?.min_amount;
    this.availableAmount = first?.meta?.available_amount;
    this.requestId = document?.meta?.request_id;
    this.idempotencyKey = idempotencyKey;
  }
}

/** Транспорт, таймаут, розрив. Запит міг дійти: лише той самий ключ. */
export class AgentApiTransportError extends Error {
  readonly idempotencyKey: string | undefined;

  constructor(cause: unknown, idempotencyKey?: string) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AgentApiTransportError";
    this.idempotencyKey = idempotencyKey;
  }
}

const NEW_KEY = new Set<string>([
  "wallet_busy",
  "route_unavailable",
  "provider_refused",
  "invalid_address",
  "unsupported_token",
  "unsupported_chain",
  "amount_too_low",
  "validation_failed",
]);

const STOP = new Set<string>([
  "provider_limit_reached",
  "policy_denied",
  "policy_action_denied",
  "policy_limit_exceeded",
  "policy_destination_denied",
  "policy_transaction_limit_exceeded",
  "policy_action_limit_exceeded",
  "policy_schedule_denied",
  "policy_usage_unavailable",
  "spend_budget_exceeded",
  "spend_price_unavailable",
  "insufficient_balance",
  "wallet_frozen",
  "agent_grant_required",
  "invalid_api_key",
  "deposit_quota_exceeded",
  "policy_not_ready",
  "agent_not_bound",
  "agent_not_found",
  "agent_archived",
  "agent_deleted",
  "agent_deletion_pending",
]);

const SAME_KEY = new Set<string>([
  "sponsor_busy",
  "sponsor_balance_insufficient",
  "database_busy",
  "internal_error",
  "transaction_unconfirmed",
  "near_rpc_unavailable",
  "rate_limited",
  "provider_response_invalid",
  "provider_request_mismatch",
]);

export function errorMove(error: unknown): ErrorMove {
  if (!(error instanceof AgentApiError)) return "same_key";
  if (SAME_KEY.has(error.code)) return "same_key";
  if (NEW_KEY.has(error.code)) return "new_key";
  if (STOP.has(error.code)) return "stop";
  if (error.code === "provider_unavailable" || error.code === "provider_rate_limited") {
    // З retryable — той самий ключ; без нього відмову записано, нічого не відправлено.
    return error.retryable ? "same_key" : "new_key";
  }
  if (error.retryable || error.status >= 500) return "same_key";
  // Лише доведена відмова дає новий ключ (errors.md, «Earlier work under the key»): решта чекає статусу.
  return "hold";
}

/** Скільки чекати перед повтором, у мс. */
export function retryDelayMs(error: unknown, now: number, fallbackMs: number): number {
  if (error instanceof AgentApiError) {
    if (error.retryAfterSeconds !== undefined) return error.retryAfterSeconds * 1000;
    if (error.availableAt) {
      const at = Date.parse(error.availableAt);
      if (!Number.isNaN(at)) return Math.max(0, at - now);
    }
  }
  return fallbackMs;
}
