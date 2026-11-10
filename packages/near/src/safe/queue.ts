// Один грошовий запит на гаманець за раз, інакше wallet_busy. Черга по одному на агента.

export class WalletQueue {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(walletId: string, task: () => Promise<T>): Promise<T> {
    const tail = this.#tails.get(walletId) ?? Promise.resolve();
    const next = tail.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(walletId, settled);
    void settled.then(() => {
      if (this.#tails.get(walletId) === settled) this.#tails.delete(walletId);
    });
    return next;
  }

  busy(walletId: string): boolean {
    return this.#tails.has(walletId);
  }
}
