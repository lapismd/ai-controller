import { createHash } from "node:crypto";
import { extractClaim, secretBearingReason } from "./claim-extract.js";
import { deterministicId } from "./memory-constants.js";
import { drainEmbeddings } from "./memory-embeddings.js";
import type { ControllerMemoryHost } from "./memory-host.js";
import type { MemoryOriginClass } from "./memory-types.js";
import {
  arrayMetadata,
  stringMetadata,
} from "./search-hits.js";
import type {
  StoredEvidence,
  StoredMemory,
  StoredSearchDocument,
} from "./store-port.js";

export function evidenceDocument(
  evidence: StoredEvidence,
  updatedAt: number,
): StoredSearchDocument {
  const origin: MemoryOriginClass =
    evidence.event.pubkey === evidence.ownerPubkey
      ? "owner"
      : evidence.event.pubkey === evidence.agentPubkey
        ? "agent"
        : "member";
  return {
    documentId: deterministicId(
      "episodic",
      evidence.partitionKey,
      evidence.event.id,
    ),
    partitionKey: evidence.partitionKey,
    corpus: "episodic",
    sourceId: evidence.event.id,
    content: evidence.event.content,
    metadata: {
      eventId: evidence.event.id,
      authorPubkey: evidence.event.pubkey,
      observedAt: evidence.event.created_at,
      origin,
      evidenceHash: evidence.contentHash,
      ...(evidence.threadRootId ? { threadRootId: evidence.threadRootId } : {}),
    },
    contentHash: evidence.contentHash,
    status: evidence.status === "active" ? "active" : "deleted",
    createdAt: evidence.event.created_at,
    updatedAt,
  };
}

export function indexEvidence(
  host: ControllerMemoryHost,
  evidence: StoredEvidence,
): void {
  const document = evidenceDocument(evidence, host.now());
  host.store.upsertSearchDocument(document);
  if (host.embedding && evidence.status === "active") {
    host.embeddingQueue.add(document.documentId);
    drainEmbeddings(host);
  }
}

export function learnFromEvidence(
  host: ControllerMemoryHost,
  evidence: StoredEvidence,
): void {
  if (evidence.status !== "active") return;
  const extracted = extractClaim(evidence.event.content);
  if (!extracted) return;
  const origin: MemoryOriginClass =
    evidence.event.pubkey === evidence.ownerPubkey
      ? "owner"
      : (evidence.agentPubkeys ?? [evidence.agentPubkey]).includes(
            evidence.event.pubkey,
          )
        ? "agent"
        : "member";
  const secretReason = secretBearingReason(extracted.claim);
  const candidateId = deterministicId(
    "candidate",
    evidence.partitionKey,
    extracted.normalizedClaim,
  );
  host.store.putMemoryCandidate(
    {
      candidateId,
      partitionKey: evidence.partitionKey,
      kind: extracted.kind,
      claim: extracted.claim,
      normalizedClaim: extracted.normalizedClaim,
      supersessionKey: extracted.supersessionKey,
      origin,
      authorPubkey: evidence.event.pubkey,
      explicit: extracted.explicit,
      status: secretReason ? "rejected" : "review",
      ...(secretReason ? { rejectionReason: secretReason } : {}),
      createdAt: evidence.event.created_at,
      updatedAt: host.now(),
    },
    {
      candidateId,
      eventId: evidence.event.id,
      evidenceHash: evidence.contentHash,
      conversationKey: evidence.threadRootId ?? evidence.event.id,
      observedAt: evidence.event.created_at,
    },
  );
  if (secretReason || origin !== "owner") return;
  const active = host.store.activeMemoryBySupersession(
    evidence.partitionKey,
    extracted.supersessionKey,
  );
  if (active && active.normalizedClaim !== extracted.normalizedClaim) return;
  const support = host.store.memoryCandidateEvidence(candidateId);
  const distinctConversations = new Set(
    support.map(({ conversationKey }) => conversationKey),
  ).size;
  const distinctDays = new Set(
    support.map(({ observedAt }) => Math.floor(observedAt / 86_400)),
  ).size;
  if (!extracted.explicit && (distinctConversations < 2 || distinctDays < 2))
    return;
  const memory = host.store.activateMemory({
    memoryId: deterministicId(
      "memory",
      evidence.partitionKey,
      extracted.supersessionKey,
    ),
    partitionKey: evidence.partitionKey,
    kind: extracted.kind,
    content: extracted.claim,
    normalizedClaim: extracted.normalizedClaim,
    supersessionKey: extracted.supersessionKey,
    evidenceHashes: support.map(({ evidenceHash }) => evidenceHash),
    now: host.now(),
  });
  host.store.setMemoryCandidateStatus(candidateId, "approved", host.now());
  indexMemory(host, memory);
}

export function indexMemory(
  host: ControllerMemoryHost,
  memory: StoredMemory,
): void {
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify([
        memory.memoryId,
        memory.revision,
        memory.content,
        memory.evidenceHashes,
      ]),
    )
    .digest("hex");
  const document: StoredSearchDocument = {
    documentId: deterministicId("curated", memory.memoryId),
    partitionKey: memory.partitionKey,
    corpus: "curated",
    sourceId: memory.memoryId,
    content: memory.content,
    metadata: {
      memoryId: memory.memoryId,
      kind: memory.kind,
      origin: memory.origin,
      observedAt: memory.updatedAt,
      evidenceHash: contentHash,
      evidenceHashes: memory.evidenceHashes,
      revision: memory.revision,
    },
    contentHash,
    status: memory.status === "active" ? "active" : "retracted",
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
  host.store.upsertSearchDocument(document);
  if (host.embedding && memory.status === "active") {
    host.embeddingQueue.add(document.documentId);
    drainEmbeddings(host);
  }
}

export function suppressDerivatives(
  host: ControllerMemoryHost,
  evidence: readonly StoredEvidence[],
  retractMemories: boolean,
): void {
  if (!evidence.length) return;
  const eventIds = new Set(evidence.map(({ event }) => event.id));
  const hashes = new Set(evidence.map(({ contentHash }) => contentHash));
  const partitions = new Set(evidence.map(({ partitionKey }) => partitionKey));
  for (const partitionKey of partitions) {
    for (const document of host.store.searchDocuments(partitionKey)) {
      const documentHashes = [
        stringMetadata(document, "evidenceHash"),
        ...arrayMetadata(document, "evidenceHashes"),
      ].filter((value): value is string => Boolean(value));
      if (
        eventIds.has(document.sourceId) ||
        documentHashes.some((hash) => hashes.has(hash))
      )
        host.store.setSearchDocumentStatus(
          document.documentId,
          "deleted",
          host.now(),
        );
    }
    for (const candidate of host.store.memoryCandidates(partitionKey)) {
      if (
        host.store
          .memoryCandidateEvidence(candidate.candidateId)
          .some(({ evidenceHash }) => hashes.has(evidenceHash))
      )
        host.store.setMemoryCandidateStatus(
          candidate.candidateId,
          "rejected",
          host.now(),
          "supporting evidence unavailable",
        );
    }
    if (!retractMemories) continue;
    for (const memory of host.store.memories(partitionKey, "active")) {
      if (!memory.evidenceHashes.some((hash) => hashes.has(hash))) continue;
      host.store.retractMemory(memory.memoryId, host.now());
      indexMemory(host, host.store.memory(memory.memoryId)!);
    }
  }
}
