/** Extracted from the Lapis and Nostr memory implementations. Profile differences are explicit. */
export function tokenSimilarity(
  left: string,
  right: string,
  empty: "equal" | "zero" = "equal",
): number {
  const tokens = (value: string) =>
    new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return empty === "equal" && left === right ? 1 : 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
export function selectMmr<T>(
  candidates: readonly T[],
  limit: number,
  options: {
    score(item: T): number;
    text(item: T): string;
    normalize?: boolean;
    empty?: "equal" | "zero";
  },
): T[] {
  const remaining = [...candidates];
  const selected: T[] = [];
  const maximum = options.normalize
    ? Math.max(Number.EPSILON, remaining[0] ? options.score(remaining[0]) : 1)
    : 1;
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((candidate, index) => {
      const redundancy = Math.max(
        0,
        ...selected.map((item) =>
          tokenSimilarity(
            options.text(candidate),
            options.text(item),
            options.empty,
          ),
        ),
      );
      const score =
        (0.75 * options.score(candidate)) / maximum - 0.25 * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    selected.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return selected;
}
export function automaticRecallQuery(query: string): string {
  const stop = new Set([
    "about",
    "could",
    "have",
    "please",
    "should",
    "that",
    "this",
    "use",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
  ]);
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return (
    tokens
      .filter((token) => token.length > 2 && !stop.has(token))
      .slice(0, 12)
      .join(" ") || query
  );
}
