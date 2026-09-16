export type MemoryDatabaseMemoryScopeKind = "user" | "workspace" | "project";
export type MemoryDatabaseMemoryOriginClass =
  "owner" | "agent" | "untrusted" | "system";

export interface MemoryDatabaseMemorySourceRecord {
  sourceKey: string;
  sourcePath: string;
  sourceHash: string;
  lastEntryId?: string;
  lastEntryHash?: string;
  status: "ready" | "inconsistent" | "error" | "excluded";
  indexedAt: number;
  errorCode?: string;
}

export interface MemoryDatabaseMemoryCandidateRecord {
  id: string;
  scopeKind: MemoryDatabaseMemoryScopeKind;
  scopePath: string;
  kind: "preference" | "fact" | "decision" | "procedure" | "constraint";
  normalizedClaim: string;
  claimHash: string;
  supersessionKey?: string;
  originClass: MemoryDatabaseMemoryOriginClass;
  importance: 1 | 2 | 3 | 4 | 5;
  triggers: string[];
  state: "staged" | "review" | "promoted" | "rejected";
  firstSeenAt: number;
  lastSeenAt: number;
  recurrenceCount: number;
  conversationCount: number;
  promotedMemoryId?: string;
}

export interface MemoryDatabaseMemoryCandidateOriginRecord {
  candidateId: string;
  conversationId: string;
  entryId: string;
  entryHash: string;
  observedAt: number;
}

export interface MemoryDatabaseMemoryCandidateInput {
  candidate: MemoryDatabaseMemoryCandidateRecord;
  origins: MemoryDatabaseMemoryCandidateOriginRecord[];
}

export interface MemoryDatabaseMemoryCandidateQuery {
  scopeKind?: MemoryDatabaseMemoryScopeKind;
  scopePath?: string;
  states?: MemoryDatabaseMemoryCandidateRecord["state"][];
  limit?: number;
}

export interface MemoryDatabaseMemoryCandidateResult {
  candidate: MemoryDatabaseMemoryCandidateRecord;
  origins: MemoryDatabaseMemoryCandidateOriginRecord[];
}

export interface MemoryDatabaseMemoryRecallSignalRecord {
  targetRef: string;
  queryFingerprint: string;
  day: string;
  bestScore: number;
  hitCount: number;
}

export interface MemoryDatabaseMemoryJobRecord {
  id: string;
  kind: "ingest" | "consolidate" | "rebuild" | "forget";
  scopeKey: string;
  status: "queued" | "running" | "completed" | "failed";
  cursor?: string;
  attempts: number;
  maxAttempts: number;
  ownerId?: string;
  leaseUntil?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
}

export interface MemoryDatabaseMemoryJobClaimInput {
  job: MemoryDatabaseMemoryJobRecord;
  ownerId: string;
  now: number;
  leaseMs: number;
}

export interface MemoryDatabaseMemoryJobUpdateInput {
  jobId: string;
  ownerId: string;
  now: number;
  patch: Pick<MemoryDatabaseMemoryJobRecord, "status"> &
    Partial<
      Pick<
        MemoryDatabaseMemoryJobRecord,
        "cursor" | "leaseUntil" | "finishedAt" | "errorCode"
      >
    >;
}

export interface SearchDocumentRecord {
  path: string;
  sourceProviderId?: string;
  name: string;
  extension: string;
  checksum: string;
  content: string;
  tags: string[];
  tagParts: string[];
  tagHierarchy: string[];
  metadataText?: string;
  chunks?: Array<{
    id: string;
    text: string;
    startOffset: number;
    endOffset: number;
    kind?:
      | "frontmatter"
      | "heading"
      | "paragraph"
      | "list"
      | "blockquote"
      | "code"
      | "fallback";
  }>;
}
export interface MemoryDatabaseSearchResult {
  document: SearchDocumentRecord;
  score: number;
  snippets: Array<{ field: string; text: string }>;
}
export interface MemoryDatabase {
  beginSearchIndexingBatch(): Promise<void>;
  endSearchIndexingBatch(): Promise<void>;
  getMeta<T = unknown>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  upsertSearchDocument(document: SearchDocumentRecord): Promise<void>;
  getSearchDocument(path: string): Promise<SearchDocumentRecord | undefined>;
  deleteSearchDocument(path: string): Promise<void>;
  listSearchDocuments(): Promise<SearchDocumentRecord[]>;
  searchDocuments(
    query: string,
    options?: {
      sourceProviderIds?: string[];
      pathPrefix?: string;
      mode?: "lexical" | "vector" | "hybrid" | "auto";
      limit?: number;
      snippetLength?: number;
    },
  ): Promise<MemoryDatabaseSearchResult[]>;
  getMemorySourceState(
    sourceKey: string,
  ): Promise<MemoryDatabaseMemorySourceRecord | undefined>;
  listMemorySourceStates(): Promise<MemoryDatabaseMemorySourceRecord[]>;
  upsertMemorySourceState(
    record: MemoryDatabaseMemorySourceRecord,
  ): Promise<void>;
  deleteMemorySourceState(sourceKey: string): Promise<void>;
  upsertMemoryCandidate(
    input: MemoryDatabaseMemoryCandidateInput,
  ): Promise<void>;
  queryMemoryCandidates(
    query?: MemoryDatabaseMemoryCandidateQuery,
  ): Promise<MemoryDatabaseMemoryCandidateResult[]>;
  deleteMemoryCandidatesByConversation(conversationId: string): Promise<void>;
  recordMemoryRecallSignal(
    record: MemoryDatabaseMemoryRecallSignalRecord,
  ): Promise<void>;
  claimMemoryJob(
    input: MemoryDatabaseMemoryJobClaimInput,
  ): Promise<MemoryDatabaseMemoryJobRecord | null>;
  updateMemoryJob(
    input: MemoryDatabaseMemoryJobUpdateInput,
  ): Promise<MemoryDatabaseMemoryJobRecord | null>;
}
