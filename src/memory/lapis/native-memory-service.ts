import { MemoryCaptureBoundary } from "./capture-port.js";
import { contradictory } from "./consolidation-validate.js";
import {
  curatedRef,
  episodeRef,
  parseCuratedRef,
  parseEpisodeRef,
  projectEpisodes,
} from "./episode-documents.js";
import { InMemoryMemoryRecordStore } from "./memory-record-store.js";
import {
  consolidateNativeMemory,
  previewConsolidation,
} from "./memory-consolidate.js";
import {
  forgetConversation,
  previewForgetConversation,
  rebuildNativeMemory,
} from "./memory-forget.js";
import { getNativeMemory } from "./memory-inspect.js";
import { ingestConversation } from "./conversation-ingest.js";
import { recallNativeMemory, searchNativeMemory } from "./memory-search.js";
import {
  type NativeMemoryHost,
  type NativeMemoryServiceOptions,
} from "./native-memory-host.js";
import { selectMmr } from "./search-ranking.js";
import type { EvidenceRepository } from "./evidence-port.js";
import type { MemoryDatabase } from "./database-port.js";
import type { ConversationLocation } from "./conversation-types.js";
import type { AgentContextBlock } from "../../execution/compat/types.js";
import type {
  ConsolidationPreview,
  ConsolidationResult,
  MemoryContext,
  MemoryDetail,
  MemoryForgetPreview,
  MemoryForgetResult,
  MemoryRebuildResult,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryService,
} from "./types.js";

export type { NativeMemoryServiceOptions } from "./native-memory-host.js";

export class NativeMemoryService implements MemoryService {
  readonly #host: NativeMemoryHost;

  constructor(
    repository: EvidenceRepository,
    database: MemoryDatabase,
    options: NativeMemoryServiceOptions = {},
  ) {
    const boundary = new MemoryCaptureBoundary(options.capture);
    this.#host = {
      repository: boundary.port(repository, true),
      database: boundary.port(database),
      now: options.now ?? (() => new Date()),
      yieldToApp:
        options.yieldToApp ??
        (() => new Promise((resolve) => setTimeout(resolve, 0))),
      recordStore: boundary.port(
        options.recordStore ?? new InMemoryMemoryRecordStore(),
      ),
      consolidationProvider: options.consolidationProvider,
    };
  }

  ingestConversation(location: ConversationLocation): Promise<void> {
    return ingestConversation(this.#host, location);
  }

  search(
    query: MemorySearchQuery,
    context: MemoryContext,
    signal?: AbortSignal,
  ): Promise<MemorySearchResult[]> {
    return searchNativeMemory(this.#host, query, context, signal);
  }

  recall(
    query: string,
    context: MemoryContext,
    signal?: AbortSignal,
  ): Promise<AgentContextBlock[]> {
    return recallNativeMemory(this.#host, query, context, signal);
  }

  get(
    ref: string,
    context: MemoryContext,
    signal?: AbortSignal,
  ): Promise<MemoryDetail> {
    return getNativeMemory(this.#host, ref, context, signal);
  }

  rebuild(scope?: MemoryScope): Promise<MemoryRebuildResult> {
    return rebuildNativeMemory(this.#host, scope);
  }

  previewForgetConversation(
    location: ConversationLocation,
  ): Promise<MemoryForgetPreview> {
    return previewForgetConversation(this.#host, location);
  }

  forgetConversation(
    location: ConversationLocation,
  ): Promise<MemoryForgetResult> {
    return forgetConversation(this.#host, location);
  }

  previewConsolidation(scope: MemoryScope): Promise<ConsolidationPreview> {
    return previewConsolidation(this.#host, scope);
  }

  consolidate(scope: MemoryScope): Promise<ConsolidationResult> {
    return consolidateNativeMemory(this.#host, scope);
  }
}

export const __memoryServiceInternals = {
  contradictory,
  curatedRef,
  episodeRef,
  parseCuratedRef,
  parseEpisodeRef,
  projectEpisodes,
  selectMmr,
};
