// Обгортка безпечних грошей над AgentApiPort.
//
// Правила (за документацією помилок Agent API):
// 1. Ключ ідемпотентності записується в сховище до виклику.
// 2. Новий ключ лише після записаної доведеної відмови. Для UNCERTAIN ніколи: лише опитування того самого id.
// 3. Один грошовий запит на гаманець за раз; wallet_busy ставить запит у чергу знову з новим ключем.
// 4. Свій лічильник custody-операцій за ковзні 24 год.
// 5. Опитування статусів окремо від черги гаманця.
import type { AgentApiPort } from "../api.ts";
import type { Clock } from "../clock.ts";
import { AgentApiError, errorMove, retryDelayMs } from "../errors.ts";
import type { DepositRequest, Status, StatusResponse, SwapRequest, TransferRequest, WithdrawRequest } from "../types.ts";
import { CustodyCounter, CustodyExhaustedError } from "./custody.ts";
import { StatusPoller } from "./poller.ts";
import { WalletQueue } from "./queue.ts";
import type { IdempotencyStore, MoneyKind, MoneyRecord } from "./store.ts";

export type MoneyRequest =
  | { kind: "swap"; agentId: string; logicalId: string; body: Omit<SwapRequest, "dry"> }
  | { kind: "transfer"; agentId: string; logicalId: string; body: TransferRequest }
  | { kind: "withdraw"; agentId: string; logicalId: string; body: Omit<WithdrawRequest, "dry"> }
  | { kind: "deposit"; agentId: string; logicalId: string; body: DepositRequest };

/**
 * Підсумок для двигуна:
 * - `SUCCESS`, `REFUNDED`, `FAILED` — кінець; нова робота лише свідомо через `reopen`.
 * - `UNCERTAIN` — гроші могли піти. Лише чекати й знову викликати `execute` з тим самим `logicalId`.
 * - `NEEDS_REVIEW` — стоп, кличемо людину.
 * - `PENDING` — дедлайн минув у PROCESSING/QUEUED/PENDING_DEPOSIT або відповідь загубилась; продовжити тим самим ключем.
 * - `REFUSED` — доведена відмова, нічого не відправлено; наступний `execute` візьме новий ключ.
 */
export type MoneyState = "SUCCESS" | "REFUNDED" | "FAILED" | "UNCERTAIN" | "NEEDS_REVIEW" | "PENDING" | "REFUSED";

export interface MoneyOutcome {
  state: MoneyState;
  record: MoneyRecord;
  status?: StatusResponse;
  /** Код відмови Agent API або `custody_exhausted` від нашого лічильника. */
  code?: string;
  error?: unknown;
}

export interface SafeMoneyOptions {
  api: AgentApiPort;
  store: IdempotencyStore;
  clock: Clock;
  custody?: CustodyCounter;
  queue?: WalletQueue;
  poller?: StatusPoller;
  /** Скільки чекати кінцевого стану. Свопи й перекази — хвилини. */
  settleDeadlineMs?: number;
  /** Повтори wallet_busy з новим ключем, кожен після записаної відмови. */
  maxBusyRetries?: number;
  busyDelayMs?: number;
  /** Повтори тим самим ключем: sponsor_busy, 5xx, розрив. */
  maxSameKeyRetries?: number;
  sameKeyDelayMs?: number;
  /** Префікс ключа, щоб ключі різних середовищ не перетинались. */
  keyPrefix?: string;
}

const COUNTS_CUSTODY: Record<MoneyKind, boolean> = { swap: true, transfer: true, withdraw: true, deposit: false };

const STATUS_TO_STATE: Partial<Record<Status, MoneyState>> = {
  SUCCESS: "SUCCESS",
  REFUNDED: "REFUNDED",
  FAILED: "FAILED",
  UNCERTAIN: "UNCERTAIN",
  NEEDS_REVIEW: "NEEDS_REVIEW",
};

export class LogicalIdConflictError extends Error {
  constructor(logicalId: string) {
    super(`logical id ${logicalId} already used with a different request`);
    this.name = "LogicalIdConflictError";
  }
}

export class SafeMoney {
  readonly #api: AgentApiPort;
  readonly #store: IdempotencyStore;
  readonly #clock: Clock;
  readonly custody: CustodyCounter;
  readonly #queue: WalletQueue;
  readonly #poller: StatusPoller;
  readonly #o: Required<
    Pick<SafeMoneyOptions, "settleDeadlineMs" | "maxBusyRetries" | "busyDelayMs" | "maxSameKeyRetries" | "sameKeyDelayMs" | "keyPrefix">
  >;

  constructor(options: SafeMoneyOptions) {
    this.#api = options.api;
    this.#store = options.store;
    this.#clock = options.clock;
    this.custody = options.custody ?? new CustodyCounter({ clock: options.clock });
    this.#queue = options.queue ?? new WalletQueue();
    this.#poller = options.poller ?? new StatusPoller({ api: options.api, clock: options.clock });
    this.#o = {
      settleDeadlineMs: options.settleDeadlineMs ?? 5 * 60_000,
      maxBusyRetries: options.maxBusyRetries ?? 5,
      busyDelayMs: options.busyDelayMs ?? 2_000,
      maxSameKeyRetries: options.maxSameKeyRetries ?? 3,
      sameKeyDelayMs: options.sameKeyDelayMs ?? 3_000,
      keyPrefix: options.keyPrefix ?? "mw",
    };
  }

  /** Ідемпотентно за `logicalId`: повторний виклик продовжує ту саму роботу, а не створює нову. */
  async execute(request: MoneyRequest, options: { deadlineMs?: number; onUpdate?: (s: StatusResponse) => void } = {}): Promise<MoneyOutcome> {
    let record = await this.#store.get(request.logicalId);
    if (record && JSON.stringify(record.body) !== JSON.stringify(request.body)) throw new LogicalIdConflictError(request.logicalId);

    if (record?.state === "done") return this.#fromRecord(record);

    if (!record || record.state === "refused" || record.state === "pending") {
      const sent = await this.#queue.run(request.agentId, () => this.#send(request, record));
      if (sent.outcome) return sent.outcome;
      record = sent.record;
    }

    if (!record.correlationId) throw new Error(`record ${record.logicalId} has no correlation id`);
    return this.#follow(record, options);
  }

  /** Свідома нова спроба після REFUNDED або FAILED: наступний `execute` візьме новий ключ. */
  async reopen(logicalId: string): Promise<void> {
    const record = await this.#store.get(logicalId);
    if (!record) throw new Error(`unknown logical id ${logicalId}`);
    if (record.state !== "done" || (record.status !== "REFUNDED" && record.status !== "FAILED")) {
      throw new Error(`only REFUNDED or FAILED can be reopened, ${logicalId} is ${record.status ?? record.state}`);
    }
    record.state = "refused";
    record.refusal = { code: `reopened_${record.status.toLowerCase()}`, at: this.#clock.now() };
    record.updatedAt = this.#clock.now();
    await this.#store.put(record);
  }

  async #send(request: MoneyRequest, existing: MoneyRecord | undefined): Promise<{ record: MoneyRecord; outcome?: MoneyOutcome }> {
    let record = existing ?? this.#fresh(request);
    if (record.state === "refused") record = this.#nextAttempt(record);
    let busy = 0;
    let sameKey = 0;
    // Запис, що лишився `pending` після падіння, міг уже дійти до провайдера й бути порахованим.
    let counted = existing?.state === "pending";
    const count = async () => {
      if (COUNTS_CUSTODY[request.kind] && !counted) await this.custody.record(request.agentId);
      counted = true;
    };

    for (;;) {
      if (COUNTS_CUSTODY[request.kind] && !counted) {
        try {
          await this.custody.assertAvailable(request.agentId);
        } catch (error) {
          if (!(error instanceof CustodyExhaustedError)) throw error;
          return { record, outcome: await this.#refuse(record, "custody_exhausted", error, new Date(error.availableAt).toISOString()) };
        }
      }

      // Ключ на диск до відправлення.
      record.state = "pending";
      record.updatedAt = this.#clock.now();
      if (!record.attempts.some((a) => a.key === record.key)) record.attempts.push({ key: record.key, at: this.#clock.now() });
      await this.#store.put(record);

      try {
        const status = await this.#call(request, record.key);
        await count();
        record.state = "sent";
        record.correlationId = status.correlation_id;
        record.status = status.status;
        record.lastStatus = status;
        this.#mark(record, status.status);
        await this.#store.put(record);
        return { record };
      } catch (error) {
        const move = errorMove(error);
        const code = error instanceof AgentApiError ? error.code : "transport_error";

        if (move === "same_key") {
          // Могло дійти: рахуємо в custody один раз на ключ.
          await count();
          if (sameKey++ < this.#o.maxSameKeyRetries) {
            await this.#clock.sleep(retryDelayMs(error, this.#clock.now(), this.#o.sameKeyDelayMs));
            continue;
          }
          this.#mark(record, code);
          await this.#store.put(record);
          return { record, outcome: { state: "PENDING", record, code, error } };
        }

        if (move === "hold") {
          // Результат невідомий: запис лишається `pending`, наступний виклик піде тим самим ключем.
          await count();
          this.#mark(record, code);
          await this.#store.put(record);
          return { record, outcome: { state: "PENDING", record, code, error } };
        }

        if (error instanceof AgentApiError && error.code === "provider_limit_reached") {
          const until = error.availableAt ? Date.parse(error.availableAt) : this.#clock.now() + this.custody.windowMs;
          this.custody.block(request.agentId, until);
        }

        const outcome = await this.#refuse(record, code, error, error instanceof AgentApiError ? error.availableAt : undefined);
        if (code === "wallet_busy" && busy++ < this.#o.maxBusyRetries) {
          await this.#clock.sleep(retryDelayMs(error, this.#clock.now(), this.#o.busyDelayMs));
          record = this.#nextAttempt(record);
          counted = false;
          continue;
        }
        return { record, outcome };
      }
    }
  }

  async #follow(record: MoneyRecord, options: { deadlineMs?: number; onUpdate?: (s: StatusResponse) => void }): Promise<MoneyOutcome> {
    const status = await this.#poller.settle(record.correlationId!, {
      deadlineMs: options.deadlineMs ?? this.#o.settleDeadlineMs,
      ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
    });
    record.status = status.status;
    record.lastStatus = status;
    record.updatedAt = this.#clock.now();
    if (status.status === "SUCCESS" || status.status === "REFUNDED" || status.status === "FAILED" || status.status === "NEEDS_REVIEW") {
      record.state = "done";
      this.#mark(record, status.status);
    }
    await this.#store.put(record);
    return this.#fromRecord(record);
  }

  #fromRecord(record: MoneyRecord): MoneyOutcome {
    const state = (record.status && STATUS_TO_STATE[record.status]) ?? "PENDING";
    return { state, record, ...(record.lastStatus ? { status: record.lastStatus } : {}) };
  }

  async #refuse(record: MoneyRecord, code: string, error: unknown, availableAt?: string): Promise<MoneyOutcome> {
    record.state = "refused";
    record.refusal = { code, at: this.#clock.now(), ...(availableAt ? { availableAt } : {}) };
    record.updatedAt = this.#clock.now();
    this.#mark(record, `refused:${code}`);
    await this.#store.put(record);
    return { state: "REFUSED", record, code, error };
  }

  #mark(record: MoneyRecord, outcome: string): void {
    const attempt = record.attempts.find((a) => a.key === record.key);
    if (attempt) attempt.outcome = outcome;
  }

  #fresh(request: MoneyRequest): MoneyRecord {
    return {
      logicalId: request.logicalId,
      kind: request.kind,
      agentId: request.agentId,
      body: request.body,
      key: this.#key(request.kind, request.logicalId, 1),
      attempt: 1,
      state: "pending",
      attempts: [],
      updatedAt: this.#clock.now(),
    };
  }

  #nextAttempt(record: MoneyRecord): MoneyRecord {
    if (record.state !== "refused") throw new Error("a new key is allowed only after a recorded refusal");
    const attempt = record.attempt + 1;
    const next: MoneyRecord = { ...record, attempt, key: this.#key(record.kind, record.logicalId, attempt), state: "refused" };
    delete next.correlationId;
    delete next.status;
    delete next.lastStatus;
    return next;
  }

  #key(kind: MoneyKind, logicalId: string, attempt: number): string {
    const safe = logicalId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 96);
    return `${this.#o.keyPrefix}:${kind}:${safe}:${attempt}`.slice(0, 128).padEnd(8, "0");
  }

  #call(request: MoneyRequest, idempotencyKey: string): Promise<StatusResponse> {
    const keyed = { idempotencyKey };
    switch (request.kind) {
      case "swap":
        return this.#api.swap(request.agentId, request.body, keyed);
      case "transfer":
        return this.#api.transfer(request.agentId, request.body, keyed);
      case "withdraw":
        return this.#api.withdraw(request.agentId, { ...request.body, dry: false }, keyed) as Promise<StatusResponse>;
      case "deposit":
        return this.#api.deposit(request.agentId, request.body, keyed);
    }
  }
}
