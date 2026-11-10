// Сховище ключів ідемпотентності. Запис робиться ДО виклику API, щоб падіння процесу не породило другу оплату.
import type { Status, StatusResponse } from "../types.ts";

export type MoneyKind = "swap" | "transfer" | "withdraw" | "deposit";

/**
 * - `pending`: ключ записано, відповіді ще немає або вона загубилась. Повторювати лише цим ключем.
 * - `sent`: API прийняв, є `correlation_id`. Лише опитувати.
 * - `refused`: записана доведена відмова. Наступна спроба — новий ключ.
 * - `done`: кінцевий стан (`SUCCESS`, `REFUNDED`, `FAILED`, `NEEDS_REVIEW`). Нової роботи сам не починає.
 */
export type RecordState = "pending" | "sent" | "refused" | "done";

export interface Attempt {
  key: string;
  at: number;
  outcome?: string;
}

export interface MoneyRecord {
  logicalId: string;
  kind: MoneyKind;
  agentId: string;
  body: unknown;
  key: string;
  attempt: number;
  state: RecordState;
  correlationId?: string;
  status?: Status;
  lastStatus?: StatusResponse;
  refusal?: { code: string; at: number; availableAt?: string };
  attempts: Attempt[];
  updatedAt: number;
}

export interface IdempotencyStore {
  get(logicalId: string): Promise<MoneyRecord | undefined>;
  put(record: MoneyRecord): Promise<void>;
  list(): Promise<MoneyRecord[]>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, MoneyRecord>();

  async get(logicalId: string): Promise<MoneyRecord | undefined> {
    const found = this.#records.get(logicalId);
    return found ? structuredClone(found) : undefined;
  }

  async put(record: MoneyRecord): Promise<void> {
    this.#records.set(record.logicalId, structuredClone(record));
  }

  async list(): Promise<MoneyRecord[]> {
    return [...this.#records.values()].map((r) => structuredClone(r));
  }
}
