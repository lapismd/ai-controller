import { selectMmr as selectMemoryMmr } from "../ranking.js";
import type {
  MemoryDatabaseSearchResult,
  SearchDocumentRecord,
} from "./database-port.js";
import {
  decodeCuratedMetadata,
  decodeEpisodicMetadata,
  curatedRef,
  episodeRef,
} from "./episode-documents.js";
import { MAX_SNIPPET_CHARS } from "./memory-limits.js";
import { scopeProximity } from "./paths.js";
import type {
  DurableMemoryRecord,
  MemoryEvidenceRef,
  MemoryOriginClass,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
} from "./types.js";

export type RankedEpisode = {
  path: string;
  result: MemorySearchResult;
  retrievalScore: number;
};

export function decodeCuratedResults(
  results: MemoryDatabaseSearchResult[],
  currentScopeDir: string,
  query: MemorySearchQuery,
): RankedEpisode[] {
  const maxRetrieval = Math.max(1, ...results.map((result) => result.score));
  return results.flatMap((searchResult): RankedEpisode[] => {
    const metadata = decodeCuratedMetadata(searchResult.document);
    if (!metadata) return [];
    const record = metadata.record;
    if (record.status !== "active" && !query.includeSuperseded) return [];
    if (!withinDateBounds(record.updatedAt, query)) return [];
    const retrieval = Math.max(0, searchResult.score / maxRetrieval);
    const score =
      0.75 * retrieval +
      0.15 * scopeProximity(record.scope, currentScopeDir) +
      0.1 * (record.importance / 5);
    return [
      {
        path: searchResult.document.path,
        retrievalScore: searchResult.score,
        result: curatedResult(
          record,
          metadata.effectiveTrust,
          score,
          searchResult.snippets.find((snippet) => snippet.field === "content")
            ?.text,
        ),
      },
    ];
  });
}

export function curatedResult(
  record: DurableMemoryRecord,
  effectiveTrust: MemoryOriginClass,
  score: number,
  snippet = record.summary,
): MemorySearchResult {
  return {
    ref: curatedRef(record.id, record.revision),
    corpus: "curated",
    snippet: truncateSnippet(snippet),
    kind: record.kind,
    scope: record.scope,
    observedAt: record.updatedAt,
    effectiveTrust,
    status: record.status,
    score,
    evidence: structuredClone(record.evidence),
  };
}

export function decodeEpisodicResults(
  results: MemoryDatabaseSearchResult[],
  currentScopeDir: string,
  proximity: number,
  query: MemorySearchQuery,
  now: number,
): RankedEpisode[] {
  const maxRetrieval = Math.max(1, ...results.map((result) => result.score));
  return results.flatMap((searchResult): RankedEpisode[] => {
    const metadata = decodeEpisodicMetadata(searchResult.document);
    if (!metadata || !withinDateBounds(metadata.observedAt, query)) return [];
    const retrieval = Math.max(0, searchResult.score / maxRetrieval);
    const recency = recencyScore(metadata.observedAt, now);
    const result = episodeResultFromDocument(
      searchResult.document,
      0.75 * retrieval +
        0.15 *
          Math.max(proximity, scopeProximity(metadata.scope, currentScopeDir)) +
        0.1 * recency,
      searchResult,
    );
    return result ? [result] : [];
  });
}

export function episodeResultFromDocument(
  document: SearchDocumentRecord,
  score: number,
  searchResult?: MemoryDatabaseSearchResult,
): RankedEpisode | null {
  const metadata = decodeEpisodicMetadata(document);
  if (!metadata) return null;
  const snippet =
    searchResult?.snippets.find((value) => value.field === "content")?.text ??
    document.content;
  const evidence: MemoryEvidenceRef = {
    conversationId: metadata.location.conversationId,
    entryId: metadata.entryId,
    entryHash: metadata.entryHash,
    observedAt: metadata.observedAt,
    scopeDirAtObservation: metadata.location.scopeDir,
  };
  return {
    path: document.path,
    retrievalScore: searchResult?.score ?? score,
    result: {
      ref: episodeRef(metadata.location.conversationId, metadata.entryId),
      corpus: "episodic",
      snippet: truncateSnippet(snippet),
      kind: "episode",
      scope: metadata.scope,
      observedAt: metadata.observedAt,
      effectiveTrust: metadata.originClass,
      status: "active",
      score,
      evidence: [evidence],
    },
  };
}

export function withinDateBounds(
  observedAt: string,
  query: MemorySearchQuery,
): boolean {
  const value = Date.parse(observedAt);
  if (!Number.isFinite(value)) return false;
  if (query.since && value < Date.parse(query.since)) return false;
  if (query.before && value >= Date.parse(query.before)) return false;
  return true;
}

export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function recencyScore(observedAt: string, now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(observedAt)) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / 30);
}

export function truncateSnippet(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= MAX_SNIPPET_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

export function selectMmr(
  candidates: RankedEpisode[],
  limit: number,
): RankedEpisode[] {
  return selectMemoryMmr(candidates, limit, {
    score: (item) => item.result.score,
    text: (item) => item.result.snippet,
  });
}

export function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "project" ||
      (right.kind === "project" && left.projectDir === right.projectDir))
  );
}

export function dedupeEvidence(
  evidence: MemoryEvidenceRef[],
): MemoryEvidenceRef[] {
  return [
    ...new Map(
      evidence.map((ref) => [`${ref.conversationId}\u0000${ref.entryId}`, ref]),
    ).values(),
  ].sort((left, right) =>
    `${left.conversationId}\u0000${left.entryId}`.localeCompare(
      `${right.conversationId}\u0000${right.entryId}`,
    ),
  );
}

export function recallContent(result: MemorySearchResult): string {
  return [
    result.snippet,
    `Provenance: ${result.evidence.map((evidence) => `${evidence.conversationId}/${evidence.entryId}`).join(", ") || "owner-authored memory"}`,
  ].join("\n");
}
