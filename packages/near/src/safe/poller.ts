// Опитування статусів окремо від свопів: свій ліміт одночасних довгих запитів (10 на ключ), черга гаманця не тримається.
import type { AgentApiPort } from "../api.ts";
import type { Clock } from "../clock.ts";
import { errorMove, retryDelayMs } from "../errors.ts";
import { TERMINAL, type StatusResponse } from "../types.ts";

export interface PollerOptions {
  api: AgentApiPort;
  clock: Clock;
  /** Agent API тримає до 10 довгих опитувань на ключ, решта відповідає одразу. */
  maxConcurrent?: number;
  waitMs?: number;
  /** Пауза, коли відповідь прийшла одразу без кінцевого стану. */
  idleMs?: number;
}

export interface SettleOptions {
  deadlineMs: number;
  onUpdate?: (status: StatusResponse) => void;
}

export class StatusPoller {
  readonly #api: AgentApiPort;
  readonly #clock: Clock;
  readonly #max: number;
  readonly #waitMs: number;
  readonly #idleMs: number;
  #active = 0;
  readonly #waiters: (() => void)[] = [];

  constructor(options: PollerOptions) {
    this.#api = options.api;
    this.#clock = options.clock;
    this.#max = options.maxConcurrent ?? 10;
    this.#waitMs = Math.min(options.waitMs ?? 30_000, 30_000);
    this.#idleMs = options.idleMs ?? 1_000;
  }

  /** Опитує до кінцевого стану або дедлайну. UNCERTAIN опитується далі тим самим id. */
  async settle(correlationId: string, options: SettleOptions): Promise<StatusResponse> {
    const end = this.#clock.now() + options.deadlineMs;
    let last: StatusResponse | undefined;
    for (;;) {
      const before = this.#clock.now();
      try {
        last = await this.#slot(() =>
          this.#api.getStatus(correlationId, { waitMs: Math.max(0, Math.min(this.#waitMs, end - before)) }),
        );
        options.onUpdate?.(last);
        if (TERMINAL.includes(last.status)) return last;
      } catch (error) {
        if (errorMove(error) !== "same_key") throw error;
        await this.#clock.sleep(retryDelayMs(error, this.#clock.now(), this.#idleMs));
      }
      if (this.#clock.now() >= end) {
        if (last) return last;
        throw new Error(`status of ${correlationId} unknown at deadline`);
      }
      if (this.#clock.now() - before < this.#idleMs) await this.#clock.sleep(this.#idleMs);
    }
  }

  async #slot<T>(task: () => Promise<T>): Promise<T> {
    while (this.#active >= this.#max) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active++;
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiters.shift()?.();
    }
  }
}
