import type { CaptureBoundary } from "../../capture/boundary.js";
import type { EmbeddingProvider } from "./embedding-port.js";
import type { MemoryDefinition } from "./config.js";
import type {
  MemoryKind,
  SearchCorpus,
  SearchHit,
  StoredEvidence,
} from "./store-port.js";

export type MemoryOriginClass = "owner" | "member" | "agent";

export interface MemorySearchQuery {
  query: string;
  corpus?: "episodic" | "curated" | "all";
  limit?: number;
  since?: number;
  before?: number;
}

export interface MemorySearchResult {
  ref: string;
  corpus: SearchCorpus;
  sourceId: string;
  snippet: string;
  score: number;
  retrievalMode: "lexical" | "vector" | "hybrid";
  origin: MemoryOriginClass | "system";
  authorPubkey?: string;
  observedAt: number;
  evidenceHash: string;
}

export interface MemoryDetail extends MemorySearchResult {
  content: string;
  metadata: Record<string, unknown>;
}

export interface MemoryReader {
  search(
    partitionKey: string,
    query: MemorySearchQuery,
    signal?: AbortSignal,
  ): Promise<MemorySearchResult[]>;
  get(partitionKey: string, ref: string): Promise<MemoryDetail | undefined>;
}

export interface RecalledMemory {
  content?: string;
  refs: string[];
  timedOut: boolean;
}

export interface GeneratedMemoryProjection {
  summary: string;
  evidenceEventIds: string[];
  candidates: Array<{
    kind: MemoryKind;
    claim: string;
    evidenceEventIds: string[];
  }>;
}

export interface ControllerMemoryServiceOptions {
  embeddingProvider?: EmbeddingProvider;
  capture?: Pick<CaptureBoundary, "clean" | "close">;
  now?: () => number;
}

export type { SearchHit, StoredEvidence };
