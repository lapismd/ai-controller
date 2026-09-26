type Worker = {
  key: string;
  evict(): Promise<void>;
  busy: boolean;
  lastUsed: number;
  timer?: ReturnType<typeof setTimeout>;
};

/** Bounds retained ACP connections across every provider in one controller. */
export class AcpWorkerPool {
  readonly #workers = new Map<string, Worker>();
  readonly #waiters = new Set<() => void>();
  #lock: Promise<void> = Promise.resolve();
  #closed = false;
  #revision = 0;

  constructor(
    readonly maxWorkers = 4,
    readonly idleMs = 15 * 60_000,
    private readonly now = Date.now,
  ) {
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || !Number.isSafeInteger(idleMs) || idleMs < 1)
      throw new Error("Invalid ACP worker pool limits");
  }

  async reserve(key: string, evict: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const revision = this.#revision;
      const reserved = await this.lock(async () => {
        if (this.#closed) throw new Error("ACP worker pool is closed");
        const existing = this.#workers.get(key);
        if (existing) {
          if (existing.busy) return false;
          clearTimeout(existing.timer);
          existing.busy = true;
          return true;
        }
        if (this.#workers.size >= this.maxWorkers) {
          const oldest = [...this.#workers.values()]
            .filter((worker) => !worker.busy)
            .sort((a, b) => a.lastUsed - b.lastUsed)[0];
          if (!oldest) return false;
          await this.evict(oldest);
        }
        this.#workers.set(key, { key, evict, busy: true, lastUsed: this.now() });
        return true;
      });
      if (reserved) return;
      await this.wait(revision, signal);
    }
  }

  release(key: string, retain: boolean): void {
    const worker = this.#workers.get(key);
    if (!worker) return;
    if (!retain || this.#closed) {
      clearTimeout(worker.timer);
      this.#workers.delete(key);
      this.wake();
      return;
    }
    worker.busy = false;
    worker.lastUsed = this.now();
    worker.timer = setTimeout(() => {
      void this.lock(async () => {
        if (this.#workers.get(key) === worker && !worker.busy)
          await this.evict(worker);
      }).catch(() => undefined);
    }, this.idleMs);
    worker.timer.unref?.();
    this.wake();
  }

  forget(key: string): void {
    const worker = this.#workers.get(key);
    if (!worker) return;
    clearTimeout(worker.timer);
    this.#workers.delete(key);
    this.wake();
  }

  close(): void {
    this.#closed = true;
    for (const worker of this.#workers.values()) clearTimeout(worker.timer);
    this.#workers.clear();
    this.wake();
  }

  private async evict(worker: Worker): Promise<void> {
    await worker.evict();
    clearTimeout(worker.timer);
    if (this.#workers.get(worker.key) === worker) this.#workers.delete(worker.key);
    this.wake();
  }

  private lock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(work);
    this.#lock = result.then(() => undefined, () => undefined);
    return result;
  }

  private wait(revision: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", abort);
        this.#waiters.delete(wake);
        resolve();
      };
      const abort = () => {
        this.#waiters.delete(wake);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      this.#waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else if (this.#revision !== revision) wake();
    });
  }

  private wake(): void {
    this.#revision++;
    for (const waiter of this.#waiters) waiter();
  }
}
