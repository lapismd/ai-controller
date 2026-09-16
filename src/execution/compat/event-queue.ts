export class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;
  #error?: Error;

  constructor(readonly maximum = 2000) {}

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    if (this.#values.length >= this.maximum) {
      this.#error = new Error(
        "Event observer overflow; reconnect and read the retained transcript",
      );
      this.close();
    } else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.#values.length > 0) {
        yield this.#values.shift() as T;
        continue;
      }
      if (this.#closed) {
        if (this.#error) throw this.#error;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
