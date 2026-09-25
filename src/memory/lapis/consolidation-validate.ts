import { isSecretBearingMemoryText } from "./candidate-extractor.js";
import { sameScope } from "./search-ranking.js";
import type { ConsolidationProposal, MemoryScope } from "./types.js";

export function contradictory(current: string, proposed: string): boolean {
  const negated = (value: string) =>
    /\b(?:not|never|no longer|do not|don't|mustn't|shouldn't)\b/iu.test(value);
  return (
    current.toLocaleLowerCase() !== proposed.toLocaleLowerCase() &&
    negated(current) !== negated(proposed)
  );
}

export function validateConsolidationProposal(
  value: ConsolidationProposal,
  scope: MemoryScope,
  candidateIds: Set<string>,
): Map<string, ConsolidationProposal["memories"][number]> {
  if (!value || typeof value !== "object" || !Array.isArray(value.memories)) {
    throw new Error("Consolidation proposal must contain a memories array");
  }
  if (value.memories.length > 5) {
    throw new Error("Consolidation proposal exceeds the write limit");
  }
  const validated = new Map<
    string,
    ConsolidationProposal["memories"][number]
  >();
  for (const proposed of value.memories) {
    if (
      !proposed ||
      typeof proposed !== "object" ||
      !Array.isArray(proposed.candidateIds) ||
      proposed.candidateIds.length !== 1
    ) {
      throw new Error("Each proposed memory must reference one candidate");
    }
    const candidateId = proposed.candidateIds[0]!;
    if (!candidateIds.has(candidateId) || validated.has(candidateId)) {
      throw new Error("Consolidation proposal references an unknown candidate");
    }
    if (!sameScope(scope, proposed.scope)) {
      throw new Error("Consolidation proposal escalates memory scope");
    }
    if (
      !["preference", "fact", "decision", "procedure", "constraint"].includes(
        proposed.kind,
      ) ||
      ![1, 2, 3, 4, 5].includes(proposed.importance) ||
      typeof proposed.summary !== "string" ||
      !proposed.summary.trim() ||
      proposed.summary.length > 2_000 ||
      isSecretBearingMemoryText(proposed.summary) ||
      !Array.isArray(proposed.triggers) ||
      proposed.triggers.length > 12 ||
      proposed.triggers.some(
        (trigger) =>
          typeof trigger !== "string" ||
          trigger.length > 64 ||
          isSecretBearingMemoryText(trigger),
      ) ||
      (proposed.supersessionKey !== undefined &&
        (typeof proposed.supersessionKey !== "string" ||
          proposed.supersessionKey.length > 256))
    ) {
      throw new Error("Consolidation proposal failed validation");
    }
    validated.set(candidateId, {
      ...proposed,
      summary: proposed.summary.trim(),
      triggers: [
        ...new Set(proposed.triggers.map((trigger) => trigger.trim())),
      ].filter(Boolean),
    });
  }
  return validated;
}
