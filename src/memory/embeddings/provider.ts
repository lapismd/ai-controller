import type {
  EmbeddingProvider,
  EmbeddingPurpose,
} from "../group/embedding-port.js";
import {
  loadNativeEmbedding,
  type NativeEmbeddingLoader,
  type NativeEmbeddingSession,
} from "./native-runtime.js";
import {
  BGE_SMALL_EN_V15_Q8,
  localEmbeddingModel,
  type LocalEmbeddingModel,
} from "./model.js";

export interface LocalLlamaEmbeddingProviderOptions {
  modelId?: string;
  cacheDir?: string;
  idleTimeoutMs?: number;
  retryCooldownMs?: number;
}

type Dependencies = {
  load?: NativeEmbeddingLoader;
  now?: () => number;
};

export class LocalLlamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly #profile: LocalEmbeddingModel;
  readonly #cacheDir?: string;
  readonly #idleTimeoutMs: number;
  readonly #retryCooldownMs: number;
  readonly #load: NativeEmbeddingLoader;
  readonly #now: () => number;
  #session?: NativeEmbeddingSession;
  #loading?: Promise<NativeEmbeddingSession>;
  #loadAbort?: AbortController;
  #tail: Promise<void> = Promise.resolve();
  #idleTimer?: ReturnType<typeof setTimeout>;
  #retryAfter = 0;
  #closed = false;

  constructor(
    options: LocalLlamaEmbeddingProviderOptions = {},
    dependencies: Dependencies = {},
  ) {
    this.#profile = localEmbeddingModel(
      options.modelId ?? BGE_SMALL_EN_V15_Q8.modelId,
    );
    this.modelId = this.#profile.modelId;
    this.modelRevision = this.#profile.modelRevision;
    this.#cacheDir = options.cacheDir;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.#retryCooldownMs = options.retryCooldownMs ?? 60_000;
    this.#load = dependencies.load ?? loadNativeEmbedding;
    this.#now = dependencies.now ?? Date.now;
  }

  embed(
    texts: readonly string[],
    purpose: EmbeddingPurpose = "document",
  ): Promise<number[][]> {
    if (this.#closed) {
      return Promise.reject(new Error("Embedding provider is closed"));
    }
    if (!texts.length) return Promise.resolve([]);
    this.clearIdleTimer();
    return this.enqueue(async () => {
      try {
        const session = await this.session();
        const vectors = await session.embed(texts, purpose);
        this.validateVectors(vectors, texts.length);
        return vectors;
      } finally {
        this.scheduleIdleDisposal();
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.clearIdleTimer();
    this.#loadAbort?.abort(new Error("Embedding provider closed"));
    await this.#tail.catch(() => undefined);
    await this.disposeSession();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async session(): Promise<NativeEmbeddingSession> {
    if (this.#closed) throw new Error("Embedding provider is closed");
    if (this.#session) return this.#session;
    if (this.#now() < this.#retryAfter) {
      throw new Error("Embedding provider is cooling down after a load failure");
    }
    if (!this.#loading) {
      const abort = new AbortController();
      this.#loadAbort = abort;
      this.#loading = this.#load({
        model: this.#profile,
        ...(this.#cacheDir ? { cacheDir: this.#cacheDir } : {}),
        signal: abort.signal,
      }).then(async (session) => {
        if (this.#closed) {
          await session.close();
          throw new Error("Embedding provider is closed");
        }
        this.#session = session;
        this.#retryAfter = 0;
        return session;
      }).catch((error) => {
        if (!this.#closed) {
          this.#retryAfter = this.#now() + this.#retryCooldownMs;
        }
        throw error;
      }).finally(() => {
        this.#loading = undefined;
        this.#loadAbort = undefined;
      });
    }
    return this.#loading;
  }

  private scheduleIdleDisposal(): void {
    if (this.#closed || this.#idleTimeoutMs <= 0 || !this.#session) return;
    this.clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      void this.enqueue(() => this.disposeSession());
    }, this.#idleTimeoutMs);
    const timer = this.#idleTimer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  private async disposeSession(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    await session?.close();
  }

  private validateVectors(vectors: number[][], expected: number): void {
    if (
      vectors.length !== expected ||
      vectors.some((vector) =>
        vector.length !== this.#profile.dimensions ||
        vector.some((entry) => !Number.isFinite(entry))
      )
    ) {
      throw new Error("Embedding runtime returned invalid vectors");
    }
  }
}
