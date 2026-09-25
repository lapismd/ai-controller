import { createHash } from "node:crypto";
import { normalizeClaim, secretBearingReason } from "./claim-extract.js";
import { deterministicId } from "./memory-constants.js";
import { drainEmbeddings } from "./memory-embeddings.js";
import type { ControllerMemoryHost } from "./memory-host.js";
import type { GeneratedMemoryProjection } from "./memory-types.js";
import type { StoredMemoryCandidate, StoredSearchDocument } from "./store-port.js";

export function recordGeneratedProjection(
  host: ControllerMemoryHost,
  input: {
    jobId: string;
    partitionKey: string;
    projection: GeneratedMemoryProjection;
  },
): void {
  input = host.capture.clean(input);
  const evidence = host.store.evidenceByIds(input.partitionKey, [
    ...new Set([
      ...input.projection.evidenceEventIds,
      ...input.projection.candidates.flatMap(
        ({ evidenceEventIds }) => evidenceEventIds,
      ),
    ]),
  ]);
  const byId = new Map(evidence.map((item) => [item.event.id, item]));
  const summaryEvidence = input.projection.evidenceEventIds.flatMap(
    (eventId) => {
      const item = byId.get(eventId);
      return item ? [item] : [];
    },
  );
  const evidenceHashes = summaryEvidence.map(({ contentHash }) => contentHash);
  const summary = input.projection.summary.trim().slice(0, 8_000);
  if (summary && summaryEvidence.length) {
    const contentHash = createHash("sha256")
      .update(JSON.stringify([summary, evidenceHashes]))
      .digest("hex");
    const document: StoredSearchDocument = {
      documentId: deterministicId("summary", input.jobId),
      partitionKey: input.partitionKey,
      corpus: "episodic",
      sourceId: input.jobId,
      content: summary,
      metadata: {
        origin: "system",
        observedAt: host.now(),
        evidenceHash: contentHash,
        evidenceHashes,
        generated: true,
      },
      contentHash,
      status: "active",
      createdAt: host.now(),
      updatedAt: host.now(),
    };
    host.store.upsertSearchDocument(document);
    if (host.embedding) {
      host.embeddingQueue.add(document.documentId);
      drainEmbeddings(host);
    }
  }
  for (const generated of input.projection.candidates.slice(0, 8)) {
    const claim = generated.claim.trim().replace(/\s+/gu, " ").slice(0, 2_000);
    const supporting = [...new Set(generated.evidenceEventIds)].flatMap(
      (eventId) => {
        const item = byId.get(eventId);
        return item ? [item] : [];
      },
    );
    if (!claim || !supporting.length) continue;
    const normalized = normalizeClaim(claim);
    const candidateId = deterministicId(
      "generated-candidate",
      input.partitionKey,
      input.jobId,
      normalized,
    );
    const reason = secretBearingReason(claim);
    const allOwner = supporting.every(
      ({ event, ownerPubkey }) => event.pubkey === ownerPubkey,
    );
    const allAgent = supporting.every(
      ({ event, agentPubkey }) => event.pubkey === agentPubkey,
    );
    const candidate: StoredMemoryCandidate = {
      candidateId,
      partitionKey: input.partitionKey,
      kind: generated.kind,
      claim,
      normalizedClaim: normalized,
      supersessionKey: deterministicId(
        "supersession",
        `${generated.kind}:${normalized}`,
      ),
      origin: allOwner ? "owner" : allAgent ? "agent" : "member",
      authorPubkey: supporting[0]!.event.pubkey,
      explicit: false,
      status: reason ? "rejected" : "review",
      ...(reason ? { rejectionReason: reason } : {}),
      createdAt: Math.min(...supporting.map(({ event }) => event.created_at)),
      updatedAt: host.now(),
    };
    for (const item of supporting)
      host.store.putMemoryCandidate(candidate, {
        candidateId,
        eventId: item.event.id,
        evidenceHash: item.contentHash,
        conversationKey: item.threadRootId ?? item.event.id,
        observedAt: item.event.created_at,
      });
  }
}
