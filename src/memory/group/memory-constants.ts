import { createHash } from "node:crypto";

export const SEARCH_CANDIDATES = 40;
export const MAX_RESULTS = 20;
export const DEFAULT_RESULTS = 8;
export const MAX_SNIPPET_CODE_POINTS = 600;
export const RRF_K = 60;
export const MIN_VECTOR_SCORE = 0.2;
export const RECALL_DEADLINE_MS = 150;
export const RECALL_MAX_RESULTS = 3;
export const RECALL_MAX_TOKENS = 900;

export function deterministicId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}
