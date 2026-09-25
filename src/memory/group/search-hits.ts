import { selectMmr } from "../ranking.js";
import {
  MAX_SNIPPET_CODE_POINTS,
  RRF_K,
} from "./memory-constants.js";
import type {
  MemoryOriginClass,
  MemorySearchQuery,
  MemorySearchResult,
} from "./memory-types.js";
import type { SearchCorpus, SearchHit, StoredSearchDocument } from "./store-port.js";

export type FusedHit = {
  document: StoredSearchDocument;
  score: number;
  mode: "lexical" | "vector" | "hybrid";
};

export function fuseHits(
  lexical: readonly SearchHit[],
  vector: readonly SearchHit[],
): FusedHit[] {
  const hits = new Map<string, FusedHit>();
  for (const [source, mode] of [
    [lexical, "lexical"],
    [vector, "vector"],
  ] as const) {
    source.forEach((hit, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = hits.get(hit.document.documentId);
      if (existing) {
        existing.score += contribution;
        existing.mode = "hybrid";
      } else {
        hits.set(hit.document.documentId, {
          document: hit.document,
          score: contribution,
          mode,
        });
      }
    });
  }
  return [...hits.values()].toSorted(
    (left, right) =>
      right.score - left.score ||
      right.document.createdAt - left.document.createdAt ||
      left.document.documentId.localeCompare(right.document.documentId),
  );
}

export function selectDiverse(
  candidates: readonly FusedHit[],
  limit: number,
): FusedHit[] {
  return selectMmr(candidates, limit, {
    score: (item) => item.score,
    text: (item) => item.document.content,
    normalize: true,
    empty: "zero",
  });
}

export function searchResult(
  document: StoredSearchDocument,
  score: number,
  retrievalMode: MemorySearchResult["retrievalMode"],
  query: string,
): MemorySearchResult {
  const origin = stringMetadata(document, "origin") as
    | MemoryOriginClass
    | "system";
  const authorPubkey = stringMetadata(document, "authorPubkey");
  const observedAt =
    numberMetadata(document, "observedAt") ?? document.createdAt;
  const evidenceHash =
    stringMetadata(document, "evidenceHash") ?? document.contentHash;
  return {
    ref: `memory-doc:${document.documentId}`,
    corpus: document.corpus,
    sourceId: document.sourceId,
    snippet: snippet(document.content, query),
    score,
    retrievalMode,
    origin: origin || "system",
    ...(authorPubkey ? { authorPubkey } : {}),
    observedAt,
    evidenceHash,
  };
}

export function snippet(content: string, query: string): string {
  const points = [...content];
  if (points.length <= MAX_SNIPPET_CODE_POINTS) return content;
  const term = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/u)?.[0];
  const index = term ? content.toLocaleLowerCase().indexOf(term) : -1;
  const start = Math.max(0, index < 0 ? 0 : index - 150);
  const selected = [...content.slice(start)].slice(0, MAX_SNIPPET_CODE_POINTS);
  return `${start > 0 ? "…" : ""}${selected.join("")}…`;
}

export function searchCorpora(
  corpus: MemorySearchQuery["corpus"] = "all",
): SearchCorpus[] {
  if (corpus === "episodic") return ["episodic"];
  if (corpus === "curated") return ["curated"];
  return ["curated", "episodic"];
}

export function parseRef(ref: string): string | undefined {
  const match = /^memory-doc:([0-9a-f]{64})$/u.exec(ref);
  return match?.[1];
}

export function stringMetadata(
  document: StoredSearchDocument,
  name: string,
): string | undefined {
  const value = document.metadata[name];
  return typeof value === "string" ? value : undefined;
}

export function numberMetadata(
  document: StoredSearchDocument,
  name: string,
): number | undefined {
  const value = document.metadata[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function arrayMetadata(
  document: StoredSearchDocument,
  name: string,
): string[] {
  const value = document.metadata[name];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function excerpt(value: string, maximum: number): string {
  const points = [...value];
  if (points.length <= maximum) return value;
  return `${points.slice(0, Math.max(0, maximum - 1)).join("")}…`;
}

export function codePointLength(value: string): number {
  return [...value].length;
}

export async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<{ value?: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise
        .then((value) => ({ value, timedOut: false }))
        .catch(() => ({ timedOut: false })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
