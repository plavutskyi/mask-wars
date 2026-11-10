// Годинник передається параметром: прод бере справжній час, тести й фейк — віртуальний.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Віртуальний час: `sleep` миттєво пересуває стрілки. Детермінований для тестів і демо. */
export class VirtualClock implements Clock {
  #now: number;

  constructor(start = Date.UTC(2026, 10, 1, 12, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  async sleep(ms: number): Promise<void> {
    this.#now += Math.max(0, Math.ceil(ms));
    await Promise.resolve();
  }

  advance(ms: number): void {
    this.#now += Math.max(0, Math.ceil(ms));
  }
}
