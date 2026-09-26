import { recordGeneratedProjection } from "./generated-projection.js";
import { deterministicId } from "./memory-constants.js";
import type { ControllerMemoryHost } from "./memory-host.js";
import {
  indexEvidence,
  indexMemory,
  learnFromEvidence,
  suppressDerivatives,
} from "./memory-index.js";
import type { GeneratedMemoryProjection } from "./memory-types.js";
import type { StoredEvidence, StoredMemory } from "./store-port.js";

export function startGroupMemory(
  host: ControllerMemoryHost,
  partitionKey?: string,
): void {
  pruneRetention(host, partitionKey);
  for (const evidence of host.store.allEvidence(partitionKey)) {
    if (
      evidence.status !== "active" ||
      host.store.isEvidenceExcluded(evidence)
    )
      continue;
    indexEvidence(host, evidence, { queueEmbedding: false });
    learnFromEvidence(host, evidence);
  }
  for (const memory of host.store.memories(partitionKey))
    indexMemory(host, memory, { queueEmbedding: false });
}

export function ingestEvidence(
  host: ControllerMemoryHost,
  evidence: StoredEvidence,
): boolean {
  if (host.store.isEvidenceExcluded(evidence)) return false;
  const inserted = host.store.putEvidence(evidence);
  if (!inserted) return false;
  indexEvidence(host, evidence);
  learnFromEvidence(host, evidence);
  return inserted;
}

export function rebuildGroupMemory(
  host: ControllerMemoryHost,
  partitionKey?: string,
): number {
  host.store.resetDerivedMemory(partitionKey);
  let count = 0;
  for (const evidence of host.store.allEvidence(partitionKey)) {
    if (
      evidence.status !== "active" ||
      host.store.isEvidenceExcluded(evidence)
    )
      continue;
    indexEvidence(host, evidence);
    learnFromEvidence(host, evidence);
    count += 1;
  }
  for (const memory of host.store.memories(partitionKey))
    indexMemory(host, memory);
  for (const job of host.store.memoryJobs()) {
    if (
      job.status !== "completed" ||
      !job.result ||
      (partitionKey && job.partitionKey !== partitionKey)
    )
      continue;
    recordGeneratedProjection(host, {
      jobId: job.jobId,
      partitionKey: job.partitionKey,
      projection: job.result as unknown as GeneratedMemoryProjection,
    });
  }
  return count;
}

export function approveCandidate(
  host: ControllerMemoryHost,
  candidateId: string,
): StoredMemory {
  const candidate = host.store.memoryCandidate(candidateId);
  if (!candidate || candidate.status === "rejected")
    throw new Error("Memory candidate is unavailable for approval");
  const support = host.store.memoryCandidateEvidence(candidateId);
  const evidence = host.store.evidenceByIds(
    candidate.partitionKey,
    support.map(({ eventId }) => eventId),
  );
  const validHashes = new Set(evidence.map(({ contentHash }) => contentHash));
  const evidenceHashes = support
    .map(({ evidenceHash }) => evidenceHash)
    .filter((hash) => validHashes.has(hash));
  if (!evidenceHashes.length)
    throw new Error("Memory candidate has no active supporting evidence");
  const memory = host.store.activateMemory({
    memoryId: deterministicId(
      "memory",
      candidate.partitionKey,
      candidate.supersessionKey,
    ),
    partitionKey: candidate.partitionKey,
    kind: candidate.kind,
    content: candidate.claim,
    normalizedClaim: candidate.normalizedClaim,
    supersessionKey: candidate.supersessionKey,
    evidenceHashes,
    now: host.now(),
  });
  host.store.setMemoryCandidateStatus(candidateId, "approved", host.now());
  indexMemory(host, memory);
  return memory;
}

export function rejectCandidate(
  host: ControllerMemoryHost,
  candidateId: string,
): void {
  const candidate = host.store.memoryCandidate(candidateId);
  if (!candidate) throw new Error("Memory candidate is unavailable");
  host.store.setMemoryCandidateStatus(
    candidateId,
    "rejected",
    host.now(),
    "operator rejected",
  );
}

export function retractMemory(
  host: ControllerMemoryHost,
  memoryId: string,
): void {
  const memory = host.store.memory(memoryId);
  if (!memory) throw new Error("Memory is unavailable");
  host.store.retractMemory(memoryId, host.now());
  indexMemory(host, host.store.memory(memoryId)!);
}

export function forgetConversation(
  host: ControllerMemoryHost,
  partitionKey: string,
  conversationKey: string,
): number {
  const forgotten = host.store.forgetConversation(
    partitionKey,
    conversationKey,
    host.now(),
  );
  suppressDerivatives(host, forgotten, true);
  return forgotten.length;
}

export function deleteEvidence(
  host: ControllerMemoryHost,
  partitionKey: string,
  eventId: string,
): boolean {
  const evidence = host.store.evidence(partitionKey, eventId);
  if (!evidence || evidence.status !== "active") return false;
  host.store.putMemoryExclusion({
    exclusionId: deterministicId("delete", partitionKey, eventId),
    partitionKey,
    conversationKey: `event:${eventId}`,
    reason: "deleted",
    createdAt: host.now(),
  });
  host.store.markEvidenceDeleted(partitionKey, eventId, host.now());
  suppressDerivatives(host, [evidence], true);
  return true;
}

export function pruneRetention(
  host: ControllerMemoryHost,
  partitionKey?: string,
): number {
  const before =
    Math.floor(host.now() / 1_000) - host.config.historyRetentionDays * 86_400;
  const removed = host.store.pruneEvidence(before, partitionKey);
  suppressDerivatives(host, removed, false);
  return removed.length;
}
