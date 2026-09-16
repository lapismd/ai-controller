/** Compatibility data schema; domain authorization and SQLite remain in the consumer. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}
export interface EvidencePartition {
  partitionKey: string;
  relayId: string;
  relayUrl: string;
  agentId: string;
  agentPubkey: string;
  ownerPubkey: string;
  groupId: string;
}

export interface StoredEvidence extends EvidencePartition {
  event: NostrEvent;
  agentPubkeys?: string[];
  threadRootId?: string;
  contentHash: string;
  ingestedAt: number;
  status: "active" | "deleted";
}

export type SearchCorpus = "episodic" | "curated";

export interface StoredSearchDocument {
  documentId: string;
  partitionKey: string;
  corpus: SearchCorpus;
  sourceId: string;
  content: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  status: "active" | "retracted" | "deleted";
  createdAt: number;
  updatedAt: number;
}

export interface SearchHit {
  document: StoredSearchDocument;
  score: number;
}

export type MemoryKind =
  "preference" | "fact" | "decision" | "procedure" | "constraint";

export type MemoryOrigin = "owner" | "member" | "agent";

export interface StoredMemoryCandidate {
  candidateId: string;
  partitionKey: string;
  kind: MemoryKind;
  claim: string;
  normalizedClaim: string;
  supersessionKey: string;
  origin: MemoryOrigin;
  authorPubkey: string;
  explicit: boolean;
  status: "review" | "approved" | "rejected";
  rejectionReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryCandidateEvidence {
  candidateId: string;
  eventId: string;
  evidenceHash: string;
  conversationKey: string;
  observedAt: number;
}

export interface StoredMemory {
  memoryId: string;
  partitionKey: string;
  kind: MemoryKind;
  content: string;
  normalizedClaim: string;
  supersessionKey: string;
  origin: "owner";
  status: "active" | "retracted";
  revision: number;
  evidenceHashes: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StoredMemoryRevision extends StoredMemory {
  revisionHash: string;
}

export interface StoredMemoryJob {
  jobId: string;
  partitionKey: string;
  kind: "summarize";
  evidenceEventIds: string[];
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  leaseUntil?: number;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRuntimeDefaults {
  runtimeAgent?: string;
  model?: string;
  thinking?: "off" | "low" | "medium" | "high";
  updatedAt: number;
}

export interface MemoryExclusion {
  exclusionId: string;
  partitionKey: string;
  conversationKey: string;
  reason: "forgotten" | "deleted";
  createdAt: number;
}

export interface MemoryStorePort {
  putEvidence(evidence: StoredEvidence): boolean;
  evidence(partitionKey: string, eventId: string): StoredEvidence | undefined;
  allEvidence(partitionKey?: string): StoredEvidence[];
  markEvidenceDeleted(
    partitionKey: string,
    eventId: string,
    deletedAt: number,
  ): void;
  upsertSearchDocument(document: StoredSearchDocument): void;
  searchDocument(documentId: string): StoredSearchDocument | undefined;
  searchDocuments(
    partitionKey?: string,
    corpus?: SearchCorpus,
  ): StoredSearchDocument[];
  searchFullText(
    partitionKey: string,
    query: string,
    corpora: readonly SearchCorpus[],
    limit: number,
  ): SearchHit[];
  pendingSearchDocuments(
    modelId: string,
    modelRevision: string,
    limit: number,
    partitionKey?: string,
  ): StoredSearchDocument[];
  putSearchEmbedding(input: {
    documentId: string;
    modelId: string;
    modelRevision: string;
    contentHash: string;
    vector: readonly number[];
    updatedAt: number;
  }): void;
  putSearchEmbeddingError(input: {
    documentId: string;
    modelId: string;
    modelRevision: string;
    contentHash: string;
    error: string;
    updatedAt: number;
  }): void;
  invalidateSearchEmbeddings(modelId: string, modelRevision: string): number;
  searchVectors(
    partitionKey: string,
    queryVector: readonly number[],
    corpora: readonly SearchCorpus[],
    modelId: string,
    modelRevision: string,
    limit: number,
  ): SearchHit[];
  putMemoryCandidate(
    candidate: StoredMemoryCandidate,
    evidence: MemoryCandidateEvidence,
  ): boolean;
  memoryCandidate(candidateId: string): StoredMemoryCandidate | undefined;
  memoryCandidates(partitionKey?: string): StoredMemoryCandidate[];
  memoryCandidateEvidence(candidateId: string): MemoryCandidateEvidence[];
  setMemoryCandidateStatus(
    candidateId: string,
    status: StoredMemoryCandidate["status"],
    updatedAt: number,
    rejectionReason?: string,
  ): void;
  activeMemoryBySupersession(
    partitionKey: string,
    supersessionKey: string,
  ): StoredMemory | undefined;
  memory(memoryId: string): StoredMemory | undefined;
  memories(
    partitionKey?: string,
    status?: StoredMemory["status"],
  ): StoredMemory[];
  activateMemory(input: {
    memoryId: string;
    partitionKey: string;
    kind: MemoryKind;
    content: string;
    normalizedClaim: string;
    supersessionKey: string;
    evidenceHashes: readonly string[];
    now: number;
  }): StoredMemory;
  retractMemory(memoryId: string, updatedAt: number): void;
  memoryJobs(): StoredMemoryJob[];
  evidenceByIds(
    partitionKey: string,
    eventIds: readonly string[],
  ): StoredEvidence[];
  putMemoryExclusion(exclusion: MemoryExclusion): boolean;
  isEvidenceExcluded(
    evidence: Pick<StoredEvidence, "partitionKey" | "event" | "threadRootId">,
  ): boolean;
  forgetConversation(
    partitionKey: string,
    conversationKey: string,
    now: number,
  ): StoredEvidence[];
  setSearchDocumentStatus(
    documentId: string,
    status: StoredSearchDocument["status"],
    updatedAt: number,
  ): void;
  resetDerivedMemory(partitionKey?: string): void;
  pruneEvidence(before: number, partitionKey?: string): StoredEvidence[];
}
