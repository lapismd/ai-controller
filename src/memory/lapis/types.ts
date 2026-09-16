import type { ConversationLocation } from "./conversation-types.js";
import type { AgentContextBlock } from "../../execution/compat/types.js";

export type MemoryScope =
  | { kind: "user" }
  | { kind: "workspace" }
  | { kind: "project"; projectDir: string };

export type MemoryOriginClass = "owner" | "agent" | "untrusted" | "system";

export type MemoryEvidenceRef = {
  conversationId: string;
  entryId: string;
  entryHash: string;
  observedAt: string;
  scopeDirAtObservation: string;
};

export type DurableMemoryKind =
  "preference" | "fact" | "decision" | "procedure" | "constraint";

export type DurableMemoryRecord = {
  schemaVersion: 1;
  id: string;
  revision: number;
  kind: DurableMemoryKind;
  scope: MemoryScope;
  status: "active" | "retracted";
  supersessionKey?: string;
  importance: 1 | 2 | 3 | 4 | 5;
  triggers: string[];
  summary: string;
  evidence: MemoryEvidenceRef[];
  createdBy: "owner-ui" | "deterministic-promotion" | "consolidator";
  createdAt: string;
  updatedAt: string;
  previousRevisionHash?: string;
};

export type MemoryContext = {
  scopeDir: string;
  conversationId?: string;
  agentBindingId?: string;
  runId?: string;
};

export type MemorySearchQuery = {
  query: string;
  scope?: "current" | "workspace";
  corpus?: "curated" | "episodic" | "all";
  limit?: number;
  since?: string;
  before?: string;
  includeSuperseded?: boolean;
};

export type MemoryCorpus = "curated" | "episodic";

export type MemorySearchResult = {
  ref: string;
  corpus: MemoryCorpus;
  snippet: string;
  kind: DurableMemoryKind | "episode";
  scope: MemoryScope;
  observedAt: string;
  effectiveTrust: MemoryOriginClass;
  status: "active" | "retracted";
  score: number;
  evidence: MemoryEvidenceRef[];
};

export type MemoryEvidenceMessage = {
  id: string;
  type: "message" | "tool";
  role?: "user" | "assistant";
  text: string;
  observedAt: string;
  originClass: MemoryOriginClass;
  hash: string;
  verification: "matching" | "modified";
};

export type MemoryDetail = {
  ref: string;
  corpus: MemoryCorpus;
  status: "available" | "moved" | "missing" | "ambiguous" | "modified";
  result?: MemorySearchResult;
  currentLocation?: ConversationLocation;
  evidenceMessages: MemoryEvidenceMessage[];
  history?: DurableMemoryRecord[];
};

export type MemoryRebuildResult = {
  conversations: number;
  episodes: number;
  skipped: number;
  inconsistent: number;
};

export type ConsolidationPreview = {
  scope: MemoryScope;
  candidateIds: string[];
  proposals: number;
};

export type ConsolidationResult = ConsolidationPreview & {
  written: number;
  needsReview: number;
};

export type MemoryForgetPreview = {
  conversationId: string;
  episodeRefs: string[];
  candidateIds: string[];
  memoryIds: string[];
};

export type MemoryForgetResult = MemoryForgetPreview & {
  exclusionPath: string;
  retracted: number;
  needsReview: number;
};

export type GroundedConsolidationInput = {
  scope: MemoryScope;
  candidates: Array<{
    id: string;
    claim: string;
    evidence: MemoryEvidenceRef[];
  }>;
};

export type ConsolidationProposal = {
  memories: Array<
    Pick<
      DurableMemoryRecord,
      "kind" | "scope" | "importance" | "triggers" | "summary"
    > & {
      candidateIds: string[];
      supersessionKey?: string;
    }
  >;
};

export interface MemoryConsolidationProvider {
  propose(
    input: GroundedConsolidationInput,
    signal?: AbortSignal,
  ): Promise<ConsolidationProposal>;
}

export interface MemoryService {
  search(
    query: MemorySearchQuery,
    context: MemoryContext,
    signal?: AbortSignal,
  ): Promise<MemorySearchResult[]>;
  get(
    ref: string,
    context: MemoryContext,
    signal?: AbortSignal,
  ): Promise<MemoryDetail>;
  ingestConversation(location: ConversationLocation): Promise<void>;
  previewConsolidation(scope: MemoryScope): Promise<ConsolidationPreview>;
  consolidate(scope: MemoryScope): Promise<ConsolidationResult>;
  rebuild(scope?: MemoryScope): Promise<MemoryRebuildResult>;
  previewForgetConversation(
    location: ConversationLocation,
  ): Promise<MemoryForgetPreview>;
  forgetConversation(
    location: ConversationLocation,
  ): Promise<MemoryForgetResult>;
}

export interface AutomaticMemoryRecall {
  recall(
    query: string,
    context: MemoryContext,
    signal?: AbortSignal,
  ): Promise<AgentContextBlock[]>;
}
