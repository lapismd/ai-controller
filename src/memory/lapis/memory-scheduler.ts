import type {
  MemoryDatabase,
  MemoryDatabaseMemoryJobRecord,
} from "./database-port.js";
import { sha256Text } from "./hashes.js";
import { memoryScopeKey } from "./paths.js";
import type {
  ConsolidationResult,
  MemoryScope,
  MemoryService,
} from "./types.js";

const DEFAULT_IDLE_MS = 30 * 60 * 1_000;
const DEFAULT_DAILY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;

export type MemorySchedulerOptions = {
  ownerId?: string;
  idleMs?: number;
  dailyMs?: number;
  leaseMs?: number;
  now?: () => number;
  onError?: (
    operation: "consolidate",
    scope: MemoryScope,
    error: unknown,
  ) => void;
};

export class MemoryMaintenanceScheduler {
  readonly #ownerId: string;
  readonly #idleMs: number;
  readonly #dailyMs: number;
  readonly #leaseMs: number;
  readonly #now: () => number;
  readonly #onError: NonNullable<MemorySchedulerOptions["onError"]>;
  readonly #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #scopes = new Map<string, MemoryScope>();
  #dailyTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(
    private readonly database: MemoryDatabase,
    private readonly memory: MemoryService,
    options: MemorySchedulerOptions = {},
  ) {
    this.#ownerId = options.ownerId ?? crypto.randomUUID();
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#dailyMs = options.dailyMs ?? DEFAULT_DAILY_MS;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#onError = options.onError ?? (() => {});
  }

  start(): void {
    if (this.#disposed || this.#dailyTimer) return;
    this.#dailyTimer = setTimeout(() => void this.runDaily(), this.#dailyMs);
  }

  noteActivity(scope: MemoryScope): void {
    if (this.#disposed) return;
    const key = memoryScopeKey(scope);
    this.#scopes.set(key, scope);
    const current = this.#idleTimers.get(key);
    if (current) clearTimeout(current);
    this.#idleTimers.set(
      key,
      setTimeout(() => {
        this.#idleTimers.delete(key);
        void this.run(scope);
      }, this.#idleMs),
    );
  }

  async run(scope: MemoryScope): Promise<ConsolidationResult | null> {
    if (this.#disposed) return null;
    const preview = await this.memory.previewConsolidation(scope);
    if (preview.proposals === 0) return null;
    const now = this.#now();
    const scopeKey = memoryScopeKey(scope);
    const candidateFingerprint = (
      await sha256Text([...preview.candidateIds].sort().join("\n"))
    ).slice(0, 16);
    const job: MemoryDatabaseMemoryJobRecord = {
      id: `consolidate:${scopeKey}:${new Date(now).toISOString().slice(0, 10)}:${candidateFingerprint}`,
      kind: "consolidate",
      scopeKey,
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      createdAt: now,
    };
    const claimed = await this.database.claimMemoryJob({
      job,
      ownerId: this.#ownerId,
      now,
      leaseMs: this.#leaseMs,
    });
    if (!claimed) return null;
    const renew = setInterval(
      () => {
        const renewedAt = this.#now();
        void this.database.updateMemoryJob({
          jobId: job.id,
          ownerId: this.#ownerId,
          now: renewedAt,
          patch: {
            status: "running",
            leaseUntil: renewedAt + this.#leaseMs,
          },
        });
      },
      Math.max(1_000, Math.floor(this.#leaseMs / 2)),
    );
    try {
      const result = await this.memory.consolidate(scope);
      await this.database.updateMemoryJob({
        jobId: job.id,
        ownerId: this.#ownerId,
        now: this.#now(),
        patch: { status: "completed", finishedAt: this.#now() },
      });
      return result;
    } catch (error) {
      await this.database.updateMemoryJob({
        jobId: job.id,
        ownerId: this.#ownerId,
        now: this.#now(),
        patch: {
          status: "failed",
          finishedAt: this.#now(),
          errorCode: "consolidation-failed",
        },
      });
      this.#onError("consolidate", scope, error);
      return null;
    } finally {
      clearInterval(renew);
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#dailyTimer) clearTimeout(this.#dailyTimer);
    this.#dailyTimer = undefined;
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    this.#scopes.clear();
  }

  private async runDaily(): Promise<void> {
    this.#dailyTimer = undefined;
    if (this.#disposed) return;
    for (const candidate of await this.database.queryMemoryCandidates({
      states: ["staged"],
      limit: 10_000,
    })) {
      const scope: MemoryScope =
        candidate.candidate.scopeKind === "project"
          ? {
              kind: "project",
              projectDir: candidate.candidate.scopePath,
            }
          : { kind: candidate.candidate.scopeKind };
      this.#scopes.set(memoryScopeKey(scope), scope);
    }
    for (const scope of this.#scopes.values()) await this.run(scope);
    this.start();
  }
}
