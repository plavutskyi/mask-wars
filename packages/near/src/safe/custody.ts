// Власний лічильник custody-операцій: 100 на гаманець за ковзні 24 год. /v1/quotas цього не показує.
import type { Clock } from "../clock.ts";

export const CUSTODY_LIMIT_PER_DAY = 100;
export const CUSTODY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface CustodyLog {
  record(walletId: string, at: number): Promise<void>;
  /** Кількість записів не раніше `from`. */
  countSince(walletId: string, from: number): Promise<number>;
  /** Найстаріший запис не раніше `from`: з нього видно, коли звільниться місце. */
  oldestSince(walletId: string, from: number): Promise<number | undefined>;
}

export class MemoryCustodyLog implements CustodyLog {
  readonly #log = new Map<string, number[]>();

  async record(walletId: string, at: number): Promise<void> {
    const list = this.#log.get(walletId) ?? [];
    list.push(at);
    this.#log.set(walletId, list);
  }

  async countSince(walletId: string, from: number): Promise<number> {
    return (this.#log.get(walletId) ?? []).filter((t) => t >= from).length;
  }

  async oldestSince(walletId: string, from: number): Promise<number | undefined> {
    const list = (this.#log.get(walletId) ?? []).filter((t) => t >= from);
    return list.length ? Math.min(...list) : undefined;
  }
}

export class CustodyExhaustedError extends Error {
  readonly walletId: string;
  readonly availableAt: number;

  constructor(walletId: string, availableAt: number, message: string) {
    super(message);
    this.name = "CustodyExhaustedError";
    this.walletId = walletId;
    this.availableAt = availableAt;
  }
}

export interface CustodyOptions {
  clock: Clock;
  log?: CustodyLog;
  limit?: number;
  windowMs?: number;
}

/** Скільки операцій потрібно на бій: вхідний своп, вихідний своп. */
export const FIGHT_OPS = 2;
/** Запас понад бій: ROTATE і один повтор після REFUNDED. */
export const FIGHT_RESERVE = 2;

export class CustodyCounter {
  readonly #clock: Clock;
  readonly #log: CustodyLog;
  readonly limit: number;
  readonly windowMs: number;
  readonly #blockedUntil = new Map<string, number>();

  constructor(options: CustodyOptions) {
    this.#clock = options.clock;
    this.#log = options.log ?? new MemoryCustodyLog();
    this.limit = options.limit ?? CUSTODY_LIMIT_PER_DAY;
    this.windowMs = options.windowMs ?? CUSTODY_WINDOW_MS;
  }

  async used(walletId: string): Promise<number> {
    return this.#log.countSince(walletId, this.#clock.now() - this.windowMs);
  }

  async remaining(walletId: string): Promise<number> {
    if ((this.#blockedUntil.get(walletId) ?? 0) > this.#clock.now()) return 0;
    return Math.max(0, this.limit - (await this.used(walletId)));
  }

  /** Коли звільниться хоча б одне місце. */
  async availableAt(walletId: string): Promise<number> {
    const now = this.#clock.now();
    const blocked = this.#blockedUntil.get(walletId) ?? 0;
    if ((await this.used(walletId)) < this.limit) return Math.max(now, blocked);
    const oldest = (await this.#log.oldestSince(walletId, now - this.windowMs)) ?? now;
    return Math.max(oldest + this.windowMs, blocked);
  }

  async assertAvailable(walletId: string, ops = 1): Promise<void> {
    const remaining = await this.remaining(walletId);
    if (remaining < ops) {
      throw new CustodyExhaustedError(walletId, await this.availableAt(walletId), `custody quota: ${remaining} left, ${ops} needed`);
    }
  }

  async record(walletId: string): Promise<void> {
    await this.#log.record(walletId, this.#clock.now());
  }

  /** Провайдер сказав `provider_limit_reached`: гаманець мовчить до `until`. */
  block(walletId: string, until: number): void {
    this.#blockedUntil.set(walletId, Math.max(until, this.#blockedUntil.get(walletId) ?? 0));
  }

  /** Вхід у бій лише із запасом: усі операції бою плюс резерв. */
  async canEnterFight(walletId: string, ops = FIGHT_OPS, reserve = FIGHT_RESERVE): Promise<boolean> {
    return (await this.remaining(walletId)) >= ops + reserve;
  }

  async assertFightEntry(walletId: string, ops = FIGHT_OPS, reserve = FIGHT_RESERVE): Promise<void> {
    await this.assertAvailable(walletId, ops + reserve);
  }
}
