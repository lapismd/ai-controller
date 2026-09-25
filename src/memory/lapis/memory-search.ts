import { automaticRecallQuery } from "../ranking.js";
import type { AgentContextBlock } from "../../execution/compat/types.js";
import { conversationLocationFromSourcePath } from "./evidence-port.js";
import { parseCuratedRef } from "./episode-documents.js";
import { sha256Text } from "./hashes.js";
import {
  DEFAULT_TOOL_RESULTS,
  MAX_RESULTS_PER_SCOPE,
  MAX_SNIPPET_CHARS,
  MAX_TOOL_RESULTS,
} from "./memory-limits.js";
import type { NativeMemoryHost } from "./native-memory-host.js";
import {
  AI_MEMORY_CURATED_PROVIDER_ID,
  AI_MEMORY_EPISODIC_PROVIDER_ID,
  conversationMemoryScope,
  curatedScopePrefix,
  currentMemoryScopes,
  episodicScopePrefix,
  scopeProximity,
} from "./paths.js";
import {
  decodeCuratedResults,
  decodeEpisodicResults,
  raceWithAbort,
  recallContent,
  selectMmr,
  type RankedEpisode,
} from "./search-ranking.js";
import type {
  MemoryContext,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
} from "./types.js";

export async function searchNativeMemory(
  host: NativeMemoryHost,
  query: MemorySearchQuery,
  context: MemoryContext,
  signal?: AbortSignal,
): Promise<MemorySearchResult[]> {
  const text = query.query.trim();
  if (!text) return [];
  for (const [name, value] of [
    ["since", query.since],
    ["before", query.before],
  ] as const) {
    if (value !== undefined && !Number.isFinite(Date.parse(value))) {
      throw new Error(`Memory ${name} must be a valid date or timestamp`);
    }
  }
  if (
    query.since &&
    query.before &&
    Date.parse(query.since) >= Date.parse(query.before)
  ) {
    return [];
  }
  signal?.throwIfAborted();
  const limit = Math.max(
    1,
    Math.min(query.limit ?? DEFAULT_TOOL_RESULTS, MAX_TOOL_RESULTS),
  );
  const corpus = query.corpus ?? "all";
  const ranked: RankedEpisode[] = [];
  const searchNow = Math.floor(host.now().getTime() / 60_000) * 60_000;

  if (corpus === "all" || corpus === "curated") {
    for (const scope of currentMemoryScopes(context.scopeDir)) {
      signal?.throwIfAborted();
      const results = await host.database.searchDocuments(text, {
        sourceProviderIds: [AI_MEMORY_CURATED_PROVIDER_ID],
        pathPrefix: curatedScopePrefix(scope),
        mode: "auto",
        limit: MAX_RESULTS_PER_SCOPE,
        snippetLength: MAX_SNIPPET_CHARS,
      });
      ranked.push(...decodeCuratedResults(results, context.scopeDir, query));
    }
  }

  if (corpus === "all" || corpus === "episodic") {
    const scopes = currentMemoryScopes(context.scopeDir).filter(
      (scope) => scope.kind !== "user",
    );
    if (query.scope === "workspace") {
      await searchWorkspaceEpisodes(
        host,
        text,
        context,
        query,
        searchNow,
        ranked,
        signal,
      );
    } else {
      for (const scope of scopes) {
        signal?.throwIfAborted();
        const results = await host.database.searchDocuments(text, {
          sourceProviderIds: [AI_MEMORY_EPISODIC_PROVIDER_ID],
          pathPrefix: episodicScopePrefix(scope),
          mode: "auto",
          limit: MAX_RESULTS_PER_SCOPE,
          snippetLength: MAX_SNIPPET_CHARS,
        });
        ranked.push(
          ...decodeEpisodicResults(
            results,
            context.scopeDir,
            scopeProximity(scope, context.scopeDir),
            query,
            searchNow,
          ),
        );
      }
    }
  }

  const bestByPath = new Map<string, RankedEpisode>();
  for (const item of ranked) {
    const current = bestByPath.get(item.path);
    if (!current || item.result.score > current.result.score) {
      bestByPath.set(item.path, item);
    }
  }
  const candidates = [...bestByPath.values()].sort(
    (left, right) => right.result.score - left.result.score,
  );
  return selectMmr(candidates, limit).map((item) => item.result);
}

export async function recallNativeMemory(
  host: NativeMemoryHost,
  query: string,
  context: MemoryContext,
  signal?: AbortSignal,
): Promise<AgentContextBlock[]> {
  if (!query.trim() || signal?.aborted) return [];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 150);
  const abort = () => deadline.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const results = await raceWithAbort(
      searchNativeMemory(
        host,
        {
          query: automaticRecallQuery(query),
          corpus: "curated",
          scope: "current",
          limit: 8,
        },
        context,
        deadline.signal,
      ),
      deadline.signal,
    );
    const selected: MemorySearchResult[] = [];
    let estimatedTokens = 0;
    for (const result of results) {
      if (
        result.status !== "active" ||
        result.effectiveTrust !== "owner" ||
        result.corpus !== "curated"
      ) {
        continue;
      }
      const tokens = Math.ceil(recallContent(result).length / 4);
      if (estimatedTokens + tokens > 900) continue;
      selected.push(result);
      estimatedTokens += tokens;
      if (selected.length === 3) break;
    }
    if (selected.length > 0) {
      void recordRecallSignals(host, query, selected).catch(() => undefined);
    }
    return selected.flatMap((result): AgentContextBlock[] => {
      const ref = parseCuratedRef(result.ref);
      if (!ref) return [];
      return [
        {
          kind: "memory-recall",
          id: result.ref,
          content: recallContent(result),
          metadata: {
            memoryId: ref.id,
            revision: ref.revision,
            scope: result.scope.kind,
          },
        },
      ];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function recordRecallSignals(
  host: NativeMemoryHost,
  query: string,
  results: MemorySearchResult[],
): Promise<void> {
  const key = "ai.memory.query-fingerprint-salt";
  let salt = await host.database.getMeta<string>(key);
  if (!salt) {
    salt = crypto.randomUUID();
    await host.database.setMeta(key, salt);
  }
  const queryFingerprint = await sha256Text(
    `${salt}\u0000${query.trim().toLocaleLowerCase()}`,
  );
  const day = host.now().toISOString().slice(0, 10);
  for (const result of results) {
    await host.database.recordMemoryRecallSignal({
      targetRef: result.ref,
      queryFingerprint,
      day,
      bestScore: result.score,
      hitCount: 1,
    });
  }
}

async function searchWorkspaceEpisodes(
  host: NativeMemoryHost,
  text: string,
  context: MemoryContext,
  query: MemorySearchQuery,
  searchNow: number,
  ranked: RankedEpisode[],
  signal?: AbortSignal,
): Promise<void> {
  const sourceScopes = new Map<string, MemoryScope>();
  for (const source of await host.database.listMemorySourceStates()) {
    const location = conversationLocationFromSourcePath(source.sourcePath);
    if (!location) continue;
    const sourceScope = conversationMemoryScope(location.scopeDir);
    sourceScopes.set(JSON.stringify(sourceScope), sourceScope);
  }
  for (const scope of sourceScopes.values()) {
    signal?.throwIfAborted();
    const results = await host.database.searchDocuments(text, {
      sourceProviderIds: [AI_MEMORY_EPISODIC_PROVIDER_ID],
      pathPrefix: episodicScopePrefix(scope),
      mode: "auto",
      limit: MAX_RESULTS_PER_SCOPE,
      snippetLength: MAX_SNIPPET_CHARS,
    });
    ranked.push(
      ...decodeEpisodicResults(
        results,
        context.scopeDir,
        scopeProximity(scope, context.scopeDir),
        query,
        searchNow,
      ),
    );
  }
}
