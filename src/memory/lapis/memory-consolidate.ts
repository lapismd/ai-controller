import { contradictory, validateConsolidationProposal } from "./consolidation-validate.js";
import {
  markCandidatePromoted,
  resolveCandidateEvidence,
  writeConsolidationReview,
} from "./consolidation-write.js";
import { deterministicMemoryId } from "./hashes.js";
import { curatedSearchDocument } from "./memory-inspect.js";
import type { NativeMemoryHost } from "./native-memory-host.js";
import { dedupeEvidence } from "./search-ranking.js";
import type {
  ConsolidationPreview,
  ConsolidationProposal,
  ConsolidationResult,
  DurableMemoryRecord,
  MemoryEvidenceRef,
  MemoryScope,
} from "./types.js";

export async function previewConsolidation(
  host: NativeMemoryHost,
  scope: MemoryScope,
): Promise<ConsolidationPreview> {
  const candidates = await host.database.queryMemoryCandidates({
    scopeKind: scope.kind,
    scopePath: scope.kind === "project" ? scope.projectDir : "",
    states: ["staged", "review"],
    limit: 10,
  });
  return {
    scope,
    candidateIds: candidates.map((candidate) => candidate.candidate.id),
    proposals: candidates.filter(
      (candidate) =>
        candidate.candidate.state === "staged" &&
        candidate.candidate.originClass === "owner",
    ).length,
  };
}

export async function consolidateNativeMemory(
  host: NativeMemoryHost,
  scope: MemoryScope,
): Promise<ConsolidationResult> {
  const preview = await previewConsolidation(host, scope);
  const candidates = await host.database.queryMemoryCandidates({
    scopeKind: scope.kind,
    scopePath: scope.kind === "project" ? scope.projectDir : "",
    states: ["staged", "review"],
    limit: 10,
  });
  const groundedEvidence = new Map<string, MemoryEvidenceRef[]>();
  for (const candidate of candidates) {
    if (
      candidate.candidate.state !== "staged" ||
      candidate.candidate.originClass !== "owner"
    ) {
      continue;
    }
    const evidence = await resolveCandidateEvidence(host, candidate.origins);
    if (evidence?.length) {
      groundedEvidence.set(candidate.candidate.id, evidence);
    }
  }
  const consolidationProvider =
    typeof host.consolidationProvider === "function"
      ? host.consolidationProvider()
      : host.consolidationProvider;
  let providerProposals = new Map<
    string,
    ConsolidationProposal["memories"][number]
  >();
  if (consolidationProvider && groundedEvidence.size > 0) {
    try {
      const proposal = await consolidationProvider.propose({
        scope,
        candidates: candidates.flatMap((candidate) => {
          const evidence = groundedEvidence.get(candidate.candidate.id);
          return evidence
            ? [
                {
                  id: candidate.candidate.id,
                  claim: candidate.candidate.normalizedClaim,
                  evidence,
                },
              ]
            : [];
        }),
      });
      providerProposals = validateConsolidationProposal(
        proposal,
        scope,
        new Set(groundedEvidence.keys()),
      );
    } catch {
      return {
        ...preview,
        written: 0,
        needsReview: groundedEvidence.size,
      };
    }
  }
  let written = 0;
  let needsReview = 0;
  for (const candidate of candidates) {
    if (written >= 5) break;
    if (
      candidate.candidate.state !== "staged" ||
      candidate.candidate.originClass !== "owner"
    ) {
      needsReview += 1;
      continue;
    }
    const evidence = groundedEvidence.get(candidate.candidate.id);
    if (!evidence || evidence.length === 0) {
      needsReview += 1;
      await writeConsolidationReview(
        host,
        scope,
        candidate.candidate.id,
        "needs-review",
        candidate.origins,
        "Evidence was missing, ambiguous, modified, or not owner-authored.",
      );
      continue;
    }
    const allStored = await host.recordStore.list(scope);
    const providerProposal = providerProposals.get(candidate.candidate.id);
    if (consolidationProvider && !providerProposal) {
      needsReview += 1;
      continue;
    }
    const proposedSummary =
      providerProposal?.summary ?? candidate.candidate.normalizedClaim;
    const proposedSupersessionKey =
      providerProposal?.supersessionKey ?? candidate.candidate.supersessionKey;
    const existing = proposedSupersessionKey
      ? allStored.find(
          (stored) => stored.record.supersessionKey === proposedSupersessionKey,
        )
      : undefined;
    if (existing && contradictory(existing.record.summary, proposedSummary)) {
      needsReview += 1;
      await writeConsolidationReview(
        host,
        scope,
        candidate.candidate.id,
        "needs-review",
        candidate.origins,
        "Conflicting evidence matched the current supersession key.",
        { expectedPreimageHash: existing.hash },
      );
      continue;
    }
    const id =
      existing?.record.id ??
      (await deterministicMemoryId(
        "memory",
        scope.kind,
        scope.kind === "project" ? scope.projectDir : "",
        proposedSupersessionKey ?? candidate.candidate.claimHash,
      ));
    const now = host.now().toISOString();
    const combinedEvidence = dedupeEvidence([
      ...(existing?.record.evidence ?? []),
      ...evidence,
    ]);
    if (
      existing &&
      existing.record.summary === proposedSummary &&
      combinedEvidence.length === existing.record.evidence.length
    ) {
      await markCandidatePromoted(host, candidate, id);
      continue;
    }
    const record: DurableMemoryRecord = {
      schemaVersion: 1,
      id,
      revision: existing ? existing.record.revision + 1 : 1,
      kind: providerProposal?.kind ?? candidate.candidate.kind,
      scope,
      status: "active",
      ...(proposedSupersessionKey
        ? { supersessionKey: proposedSupersessionKey }
        : {}),
      importance: providerProposal?.importance ?? candidate.candidate.importance,
      triggers: providerProposal?.triggers ?? candidate.candidate.triggers,
      summary: proposedSummary,
      evidence: combinedEvidence,
      createdBy: providerProposal ? "consolidator" : "deterministic-promotion",
      createdAt: existing?.record.createdAt ?? now,
      updatedAt: now,
      ...(existing ? { previousRevisionHash: existing.hash } : {}),
    };
    try {
      const stored = await host.recordStore.write(record, {
        ...(existing ? { expectedCurrentHash: existing.hash } : {}),
      });
      const document = await curatedSearchDocument(host, stored);
      if (document) await host.database.upsertSearchDocument(document);
      await markCandidatePromoted(host, candidate, id);
      await writeConsolidationReview(
        host,
        scope,
        candidate.candidate.id,
        "written",
        candidate.origins,
        "Grounded candidate produced a durable memory revision.",
        {
          expectedPreimageHash: existing?.hash,
          memoryId: id,
          resultingRevision: record.revision,
          resultingRevisionHash: stored.hash,
        },
      );
      written += 1;
    } catch {
      needsReview += 1;
      await writeConsolidationReview(
        host,
        scope,
        candidate.candidate.id,
        "needs-review",
        candidate.origins,
        "The current memory changed or the proposed revision failed validation.",
      );
    }
  }
  return { ...preview, written, needsReview };
}
