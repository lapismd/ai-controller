import { CaptureBoundary } from "../../capture/boundary.js";
import { capturedMemoryStore } from "./capture-store.js";
import { extractClaim, secretBearingReason } from "./claim-extract.js";
import { recordGeneratedProjection } from "./generated-projection.js";
import { deterministicId } from "./memory-constants.js";
import type { ControllerMemoryHost } from "./memory-host.js";
import { evidenceDocument } from "./memory-index.js";
import {
  approveCandidate,
  deleteEvidence,
  forgetConversation,
  ingestEvidence,
  pruneRetention,
  rebuildGroupMemory,
  rejectCandidate,
  retractMemory,
  startGroupMemory,
} from "./memory-lifecycle.js";
import {
  getGroupMemory,
  recallGroupMemory,
  searchGroupMemory,
} from "./memory-query.js";
import {
  rebuildEmbeddingIndex,
  type EmbeddingRebuildResult,
} from "./memory-embeddings.js";
import type {
  ControllerMemoryServiceOptions,
  GeneratedMemoryProjection,
  MemoryDetail,
  MemoryReader,
  MemorySearchQuery,
  MemorySearchResult,
  RecalledMemory,
} from "./memory-types.js";
import { fuseHits, selectDiverse } from "./search-hits.js";
import type { MemoryDefinition } from "./config.js";
import type { MemoryStorePort, StoredEvidence, StoredMemory } from "./store-port.js";

export type {
  ControllerMemoryServiceOptions,
  GeneratedMemoryProjection,
  MemoryDetail,
  MemoryOriginClass,
  MemoryReader,
  MemorySearchQuery,
  MemorySearchResult,
  RecalledMemory,
} from "./memory-types.js";

export class ControllerMemoryService implements MemoryReader {
  readonly store: MemoryStorePort;
  readonly #host: ControllerMemoryHost;

  constructor(
    store: MemoryStorePort,
    readonly config: MemoryDefinition,
    options: ControllerMemoryServiceOptions = {},
  ) {
    const capture = options.capture ?? new CaptureBoundary();
    this.store = capturedMemoryStore(store, capture);
    if (config.embeddings.enabled && !options.embeddingProvider)
      throw new Error("Enabled memory embeddings require an embedding port");
    this.#host = {
      store: this.store,
      config,
      capture,
      now: options.now ?? Date.now,
      embedding: options.embeddingProvider,
      embeddingQueue: new Set<string>(),
      embeddingStopped: false,
    };
  }

  start(partitionKey?: string): void {
    startGroupMemory(this.#host, partitionKey);
  }

  ingest(evidence: StoredEvidence): boolean {
    return ingestEvidence(this.#host, evidence);
  }

  recall(
    partitionKey: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<RecalledMemory> {
    return recallGroupMemory(this.#host, partitionKey, query, signal);
  }

  search(
    partitionKey: string,
    query: MemorySearchQuery,
    signal?: AbortSignal,
  ): Promise<MemorySearchResult[]> {
    return searchGroupMemory(this.#host, partitionKey, query, signal);
  }

  get(
    partitionKey: string,
    ref: string,
  ): Promise<MemoryDetail | undefined> {
    return getGroupMemory(this.#host, partitionKey, ref);
  }

  rebuild(partitionKey?: string): number {
    return rebuildGroupMemory(this.#host, partitionKey);
  }

  rebuildEmbeddings(partitionKey?: string): Promise<EmbeddingRebuildResult> {
    return rebuildEmbeddingIndex(this.#host, partitionKey);
  }

  approveCandidate(candidateId: string): StoredMemory {
    return approveCandidate(this.#host, candidateId);
  }

  rejectCandidate(candidateId: string): void {
    rejectCandidate(this.#host, candidateId);
  }

  retract(memoryId: string): void {
    retractMemory(this.#host, memoryId);
  }

  forgetConversation(partitionKey: string, conversationKey: string): number {
    return forgetConversation(this.#host, partitionKey, conversationKey);
  }

  deleteEvidence(partitionKey: string, eventId: string): boolean {
    return deleteEvidence(this.#host, partitionKey, eventId);
  }

  pruneRetention(partitionKey?: string): number {
    return pruneRetention(this.#host, partitionKey);
  }

  recordGeneratedProjection(input: {
    jobId: string;
    partitionKey: string;
    projection: GeneratedMemoryProjection;
  }): void {
    recordGeneratedProjection(this.#host, input);
  }

  async close(): Promise<void> {
    this.#host.embeddingStopped = true;
    this.#host.embeddingQueue.clear();
    await this.#host.embedding?.close();
    await this.#host.embeddingDrain?.catch(() => undefined);
    this.#host.capture.close();
  }
}

export const __memoryInternals = {
  deterministicId,
  evidenceDocument,
  extractClaim,
  fuseHits,
  secretBearingReason,
  selectDiverse,
};
