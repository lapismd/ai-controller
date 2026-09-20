import { expect, it } from "vitest";
import { ControllerMemoryService } from "./service.js";
import type {
  MemoryStorePort,
  StoredEvidence,
  StoredMemory,
  StoredMemoryCandidate,
  StoredSearchDocument,
} from "./store-port.js";

function evidence(id: string): StoredEvidence {
  return {
    partitionKey: "group",
    relayId: "relay",
    relayUrl: "wss://relay.example",
    agentId: "agent",
    agentPubkey: "agent-key",
    ownerPubkey: "owner-key",
    groupId: "group",
    event: {
      id,
      pubkey: "owner-key",
      kind: 1,
      created_at: 1,
      tags: [["e", "conversation"]],
      content: "Atlas uses compact headings.",
      sig: "",
    },
    threadRootId: "conversation",
    contentHash: `hash-${id}`,
    ingestedAt: 1,
    status: "active",
  };
}

function storeFixture(): MemoryStorePort {
  const rows = new Map<string, StoredEvidence>();
  const documents = new Map<string, StoredSearchDocument>();
  const exclusions = new Set<string>();
  const memories: StoredMemory[] = [];
  const unused = () => {
    throw new Error("unused");
  };
  return {
    putEvidence(item) {
      const key = `${item.partitionKey}:${item.event.id}`;
      if (rows.has(key)) return false;
      rows.set(key, item);
      return true;
    },
    evidence(partitionKey, eventId) {
      return rows.get(`${partitionKey}:${eventId}`);
    },
    allEvidence(partitionKey) {
      return [...rows.values()].filter(
        (item) => !partitionKey || item.partitionKey === partitionKey,
      );
    },
    markEvidenceDeleted(partitionKey, eventId, deletedAt) {
      const key = `${partitionKey}:${eventId}`;
      const item = rows.get(key);
      if (item) rows.set(key, { ...item, status: "deleted", ingestedAt: deletedAt });
    },
    upsertSearchDocument(document) {
      documents.set(document.documentId, document);
    },
    searchDocument(documentId) {
      return documents.get(documentId);
    },
    searchDocuments(partitionKey) {
      return [...documents.values()].filter(
        (item) => !partitionKey || item.partitionKey === partitionKey,
      );
    },
    searchFullText() {
      return [];
    },
    pendingSearchDocuments() {
      return [];
    },
    putSearchEmbedding: unused,
    putSearchEmbeddingError: unused,
    invalidateSearchEmbeddings() {
      return 0;
    },
    searchVectors() {
      return [];
    },
    putMemoryCandidate() {
      return true;
    },
    memoryCandidate() {
      return undefined;
    },
    memoryCandidates() {
      return [] as StoredMemoryCandidate[];
    },
    memoryCandidateEvidence() {
      return [];
    },
    setMemoryCandidateStatus() {},
    activeMemoryBySupersession() {
      return undefined;
    },
    memory() {
      return undefined;
    },
    memories() {
      return memories;
    },
    activateMemory: unused as MemoryStorePort["activateMemory"],
    retractMemory() {},
    memoryJobs() {
      return [];
    },
    evidenceByIds() {
      return [];
    },
    putMemoryExclusion(exclusion) {
      exclusions.add(`${exclusion.partitionKey}:${exclusion.conversationKey}`);
      return true;
    },
    isEvidenceExcluded(item) {
      return exclusions.has(
        `${item.partitionKey}:${item.threadRootId ?? item.event.id}`,
      );
    },
    forgetConversation(partitionKey, conversationKey) {
      const forgotten = [...rows.values()].filter(
        (item) =>
          item.partitionKey === partitionKey &&
          item.threadRootId === conversationKey,
      );
      for (const item of forgotten)
        rows.set(`${item.partitionKey}:${item.event.id}`, {
          ...item,
          status: "deleted",
        });
      exclusions.add(`${partitionKey}:${conversationKey}`);
      return forgotten;
    },
    setSearchDocumentStatus(documentId, status, updatedAt) {
      const document = documents.get(documentId);
      if (document)
        documents.set(documentId, { ...document, status, updatedAt });
    },
    resetDerivedMemory() {
      documents.clear();
      memories.length = 0;
    },
    pruneEvidence() {
      return [];
    },
  };
}

it("keeps forget exclusions across rebuild without rewriting source evidence", async () => {
  const store = storeFixture();
  const memory = new ControllerMemoryService(store, {
    enabled: true,
    historyRetentionDays: 30,
    backfillDays: 7,
    embeddings: { enabled: false, modelId: "none" },
  });
  const item = evidence("evt-1");
  expect(memory.ingest(item)).toBe(true);
  expect(store.searchDocuments("group")).toHaveLength(1);
  expect(memory.forgetConversation("group", "conversation")).toBe(1);
  expect(store.searchDocuments("group")[0]?.status).toBe("deleted");
  memory.rebuild("group");
  expect(store.searchDocuments("group")).toEqual([]);
  expect(memory.ingest(item)).toBe(false);
  await memory.close();
});
