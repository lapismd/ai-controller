import {
  selectMmr as selectMemoryMmr,
  automaticRecallQuery,
} from "../ranking.js";
import type {
  MemoryDatabase,
  MemoryDatabaseSearchResult,
  SearchDocumentRecord,
} from "./database-port.js";
import type { EvidenceRepository } from "./evidence-port.js";
import type { AgentContextBlock } from "../../execution/compat/types.js";
import { conversationLocationFromSourcePath } from "./evidence-port.js";
import { conversationDirectory } from "./conversation-paths.js";
import type {
  ConversationLocation,
  ConversationSnapshot,
  TranscriptEntry,
} from "./conversation-types.js";
import {
  canonicalJson,
  deterministicMemoryId,
  sha256Text,
  transcriptEntryHash,
} from "./hashes.js";
import {
  AI_MEMORY_CURATED_PROVIDER_ID,
  AI_MEMORY_EPISODIC_PROVIDER_ID,
  conversationMemoryScope,
  curatedMemoryPath,
  curatedScopePrefix,
  currentMemoryScopes,
  episodicMemoryPath,
  episodicScopePrefix,
  scopeProximity,
} from "./paths.js";
import {
  InMemoryMemoryRecordStore,
  type MemoryRecordStore,
  type StoredMemoryRecord,
} from "./memory-record-store.js";
import type {
  ConsolidationPreview,
  ConsolidationResult,
  MemoryContext,
  MemoryDetail,
  MemoryEvidenceMessage,
  MemoryEvidenceRef,
  MemoryOriginClass,
  MemoryRebuildResult,
  MemoryForgetPreview,
  MemoryForgetResult,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryService,
  DurableMemoryRecord,
  MemoryConsolidationProvider,
  ConsolidationProposal,
} from "./types.js";
import {
  extractDeterministicCandidates,
  isSecretBearingMemoryText,
} from "./candidate-extractor.js";

const MAX_INGEST_BATCH = 200;
const MAX_RESULTS_PER_SCOPE = 40;
const MAX_TOOL_RESULTS = 20;
const DEFAULT_TOOL_RESULTS = 8;
const MAX_SNIPPET_CHARS = 600;

type EpisodicDocumentMetadata = {
  schemaVersion: 1;
  corpus: "episodic";
  location: ConversationLocation;
  entryId: string;
  entryHash: string;
  observedAt: string;
  originClass: MemoryOriginClass;
  scope: MemoryScope;
};

type CuratedDocumentMetadata = {
  schemaVersion: 1;
  corpus: "curated";
  record: DurableMemoryRecord;
  effectiveTrust: MemoryOriginClass;
  evidenceVerified: boolean;
};

type RankedEpisode = {
  path: string;
  result: MemorySearchResult;
  retrievalScore: number;
};

export type NativeMemoryServiceOptions = {
  now?: () => Date;
  yieldToApp?: () => Promise<void>;
  recordStore?: MemoryRecordStore;
  consolidationProvider?:
    | MemoryConsolidationProvider
    | (() => MemoryConsolidationProvider | undefined);
};

export class NativeMemoryService implements MemoryService {
  readonly #now: () => Date;
  readonly #yieldToApp: () => Promise<void>;
  readonly #recordStore: MemoryRecordStore;
  readonly #consolidationProvider?: NativeMemoryServiceOptions["consolidationProvider"];

  constructor(
    private readonly repository: EvidenceRepository,
    private readonly database: MemoryDatabase,
    options: NativeMemoryServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#yieldToApp =
      options.yieldToApp ??
      (() => new Promise((resolve) => setTimeout(resolve, 0)));
    this.#recordStore = options.recordStore ?? new InMemoryMemoryRecordStore();
    this.#consolidationProvider = options.consolidationProvider;
  }

  async ingestConversation(location: ConversationLocation): Promise<void> {
    if (
      (await this.#recordStore.listExcludedConversationIds()).has(
        location.conversationId,
      )
    ) {
      await this.removeStaleConversationDocuments(location.conversationId);
      await this.database.deleteMemoryCandidatesByConversation(
        location.conversationId,
      );
      await this.database.deleteMemorySourceState(location.conversationId);
      return;
    }
    const duplicates = (await this.repository.listAll()).filter(
      (entry) => entry.location.conversationId === location.conversationId,
    );
    if (duplicates.length !== 1) {
      await this.database.upsertMemorySourceState({
        sourceKey: location.conversationId,
        sourcePath: transcriptPath(location),
        sourceHash: "",
        status: "inconsistent",
        indexedAt: this.#now().getTime(),
        errorCode:
          duplicates.length > 1
            ? "duplicate-conversation-id"
            : "missing-source",
      });
      return;
    }

    const snapshot = await this.repository.read(location);
    const episodes = await projectEpisodes(snapshot);
    const duplicateEntry = firstDuplicateEntry(episodes);
    if (duplicateEntry) {
      await this.markInconsistent(location, episodes, "duplicate-entry-id");
      return;
    }

    const previous = await this.database.getMemorySourceState(
      location.conversationId,
    );
    const previousLocation = previous
      ? conversationLocationFromSourcePath(previous.sourcePath)
      : null;
    let startIndex = 0;
    if (previous?.lastEntryId) {
      const checkpointIndex = episodes.findIndex(
        (episode) => episode.entry.id === previous.lastEntryId,
      );
      const checkpoint = episodes[checkpointIndex];
      if (!checkpoint || checkpoint.entryHash !== previous.lastEntryHash) {
        await this.markInconsistent(location, episodes, "entry-hash-mismatch");
        return;
      }
      startIndex = checkpointIndex;
      const indexedLocation = previousLocation ?? location;
      for (const episode of episodes.slice(0, checkpointIndex + 1)) {
        const document = await this.database.getSearchDocument(
          episodicMemoryPath(
            conversationMemoryScope(indexedLocation.scopeDir),
            indexedLocation.conversationId,
            episode.entry.id,
          ),
        );
        if (!document) {
          startIndex = 0;
          break;
        }
        const indexed = decodeEpisodicMetadata(document);
        if (indexed?.entryHash !== episode.entryHash) {
          await this.markInconsistent(
            location,
            episodes,
            "entry-hash-mismatch",
          );
          return;
        }
      }
    }

    const moved = Boolean(
      previousLocation &&
      (previousLocation.scopeDir !== location.scopeDir ||
        previousLocation.conversationId !== location.conversationId),
    );
    if (moved) {
      await this.removeStaleConversationDocuments(location.conversationId);
      startIndex = 0;
    }
    const sourceHash = await sha256Text(
      episodes
        .map((episode) => `${episode.entry.id}:${episode.entryHash}`)
        .join("\n"),
    );
    if (episodes.length === 0) {
      await this.database.upsertMemorySourceState({
        sourceKey: location.conversationId,
        sourcePath: transcriptPath(location),
        sourceHash,
        status: "ready",
        indexedAt: this.#now().getTime(),
      });
      return;
    }

    await this.database.beginSearchIndexingBatch();
    try {
      for (
        let offset = startIndex;
        offset < episodes.length;
        offset += MAX_INGEST_BATCH
      ) {
        const batch = episodes.slice(offset, offset + MAX_INGEST_BATCH);
        for (const episode of batch) {
          const document = episodeSearchDocument(snapshot.location, episode);
          const existing = await this.database.getSearchDocument(document.path);
          if (existing?.checksum !== document.checksum) {
            await this.database.upsertSearchDocument(document);
          }
        }
        await extractDeterministicCandidates(snapshot, this.database, {
          entries: batch.map((episode) => episode.entry),
        });
        const cursor = batch.at(-1)!;
        await this.database.upsertMemorySourceState({
          sourceKey: location.conversationId,
          sourcePath: transcriptPath(location),
          sourceHash,
          lastEntryId: cursor.entry.id,
          lastEntryHash: cursor.entryHash,
          status: "ready",
          indexedAt: this.#now().getTime(),
        });
        if (offset + MAX_INGEST_BATCH < episodes.length) {
          await this.#yieldToApp();
        }
      }
    } finally {
      await this.database.endSearchIndexingBatch();
    }
  }

  async search(
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
    const searchNow = Math.floor(this.#now().getTime() / 60_000) * 60_000;

    if (corpus === "all" || corpus === "curated") {
      for (const scope of currentMemoryScopes(context.scopeDir)) {
        signal?.throwIfAborted();
        const results = await this.database.searchDocuments(text, {
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
        const sourceScopes = new Map<string, MemoryScope>();
        for (const source of await this.database.listMemorySourceStates()) {
          const location = conversationLocationFromSourcePath(
            source.sourcePath,
          );
          if (!location) continue;
          const sourceScope = conversationMemoryScope(location.scopeDir);
          sourceScopes.set(JSON.stringify(sourceScope), sourceScope);
        }
        for (const scope of sourceScopes.values()) {
          signal?.throwIfAborted();
          const results = await this.database.searchDocuments(text, {
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
      } else {
        for (const scope of scopes) {
          signal?.throwIfAborted();
          const results = await this.database.searchDocuments(text, {
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
    const selected = selectMmr(candidates, limit);
    return selected.map((item) => item.result);
  }

  async recall(
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
        this.search(
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
        void this.recordRecallSignals(query, selected).catch(() => undefined);
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

  async get(
    ref: string,
    _context: MemoryContext,
    signal?: AbortSignal,
  ): Promise<MemoryDetail> {
    signal?.throwIfAborted();
    const curated = parseCuratedRef(ref);
    if (curated) return this.getCurated(curated.id, curated.revision, signal);
    const parsed = parseEpisodeRef(ref);
    if (!parsed) {
      return {
        ref,
        corpus: "episodic",
        status: "missing",
        evidenceMessages: [],
      };
    }
    const matches = (await this.repository.listAll()).filter(
      (entry) => entry.location.conversationId === parsed.conversationId,
    );
    if (matches.length > 1) {
      return {
        ref,
        corpus: "episodic",
        status: "ambiguous",
        evidenceMessages: [],
      };
    }
    const match = matches[0];
    if (!match || match.unavailableReason) {
      return {
        ref,
        corpus: "episodic",
        status: "missing",
        evidenceMessages: [],
      };
    }
    const snapshot = await this.repository.read(match.location);
    const episode = (await projectEpisodes(snapshot)).find(
      (candidate) => candidate.entry.id === parsed.entryId,
    );
    if (!episode) {
      return {
        ref,
        corpus: "episodic",
        status: "missing",
        currentLocation: snapshot.location,
        evidenceMessages: [],
      };
    }
    const currentPath = episodicMemoryPath(
      conversationMemoryScope(snapshot.location.scopeDir),
      snapshot.location.conversationId,
      episode.entry.id,
    );
    let document = await this.database.getSearchDocument(currentPath);
    if (!document) {
      const source = await this.database.getMemorySourceState(
        snapshot.location.conversationId,
      );
      const previousLocation = source
        ? conversationLocationFromSourcePath(source.sourcePath)
        : null;
      if (previousLocation) {
        document = await this.database.getSearchDocument(
          episodicMemoryPath(
            conversationMemoryScope(previousLocation.scopeDir),
            previousLocation.conversationId,
            episode.entry.id,
          ),
        );
      }
    }
    const indexed = document ? decodeEpisodicMetadata(document) : null;
    const modified = Boolean(
      indexed && indexed.entryHash !== episode.entryHash,
    );
    const moved = Boolean(
      indexed && indexed.location.scopeDir !== snapshot.location.scopeDir,
    );
    const result = episodeResultFromDocument(
      document ?? episodeSearchDocument(snapshot.location, episode),
      1,
    );
    return {
      ref,
      corpus: "episodic",
      status: modified ? "modified" : moved ? "moved" : "available",
      result: result?.result,
      currentLocation: snapshot.location,
      evidenceMessages: [episodeEvidenceMessage(episode, modified)],
    };
  }

  async rebuild(scope?: MemoryScope): Promise<MemoryRebuildResult> {
    const listed = [...(await this.repository.listAll())].sort((left, right) =>
      `${left.location.scopeDir}\u0000${left.location.conversationId}`.localeCompare(
        `${right.location.scopeDir}\u0000${right.location.conversationId}`,
      ),
    );
    const counts = new Map<string, number>();
    for (const entry of listed) {
      counts.set(
        entry.location.conversationId,
        (counts.get(entry.location.conversationId) ?? 0) + 1,
      );
    }
    const expected = new Set<string>();
    let conversations = 0;
    let episodes = 0;
    let skipped = 0;
    let inconsistent = 0;
    const exclusions = await this.#recordStore.listExcludedConversationIds();
    for (const entry of listed) {
      const entryScope = conversationMemoryScope(entry.location.scopeDir);
      if (scope && !sameScope(scope, entryScope)) continue;
      if (entry.unavailableReason) {
        skipped += 1;
        continue;
      }
      if (exclusions.has(entry.location.conversationId)) {
        skipped += 1;
        await this.removeStaleConversationDocuments(
          entry.location.conversationId,
        );
        await this.database.deleteMemoryCandidatesByConversation(
          entry.location.conversationId,
        );
        await this.database.deleteMemorySourceState(
          entry.location.conversationId,
        );
        continue;
      }
      if ((counts.get(entry.location.conversationId) ?? 0) > 1) {
        inconsistent += 1;
        await this.database.upsertMemorySourceState({
          sourceKey: entry.location.conversationId,
          sourcePath: transcriptPath(entry.location),
          sourceHash: "",
          status: "inconsistent",
          indexedAt: this.#now().getTime(),
          errorCode: "duplicate-conversation-id",
        });
        continue;
      }
      await this.ingestConversation(entry.location);
      const snapshot = await this.repository.read(entry.location);
      for (const episode of await projectEpisodes(snapshot)) {
        expected.add(
          episodicMemoryPath(
            entryScope,
            entry.location.conversationId,
            episode.entry.id,
          ),
        );
        episodes += 1;
      }
      conversations += 1;
      await this.#yieldToApp();
    }

    const listedConversationIds = new Set(
      listed.map((entry) => entry.location.conversationId),
    );
    for (const source of await this.database.listMemorySourceStates()) {
      if (listedConversationIds.has(source.sourceKey)) continue;
      const priorLocation = conversationLocationFromSourcePath(
        source.sourcePath,
      );
      if (
        scope &&
        priorLocation &&
        !sameScope(scope, conversationMemoryScope(priorLocation.scopeDir))
      ) {
        continue;
      }
      await this.removeStaleConversationDocuments(source.sourceKey);
      await this.database.deleteMemoryCandidatesByConversation(
        source.sourceKey,
      );
      await this.database.deleteMemorySourceState(source.sourceKey);
    }

    const indexed = await this.database.listSearchDocuments();
    for (const document of indexed) {
      if (document.sourceProviderId !== AI_MEMORY_EPISODIC_PROVIDER_ID)
        continue;
      const metadata = decodeEpisodicMetadata(document);
      if (scope && metadata && !sameScope(scope, metadata.scope)) continue;
      if (!expected.has(document.path)) {
        await this.database.deleteSearchDocument(document.path);
      }
    }
    const curatedRecords = await this.#recordStore.list(scope);
    const expectedCurated = new Set<string>();
    for (const stored of curatedRecords) {
      const document = await this.curatedSearchDocument(stored);
      if (!document) continue;
      expectedCurated.add(document.path);
      const existing = await this.database.getSearchDocument(document.path);
      if (existing?.checksum !== document.checksum) {
        await this.database.upsertSearchDocument(document);
      }
    }
    for (const document of indexed) {
      if (document.sourceProviderId !== AI_MEMORY_CURATED_PROVIDER_ID) continue;
      const metadata = decodeCuratedMetadata(document);
      if (scope && metadata && !sameScope(scope, metadata.record.scope))
        continue;
      if (!expectedCurated.has(document.path)) {
        await this.database.deleteSearchDocument(document.path);
      }
    }
    return { conversations, episodes, skipped, inconsistent };
  }

  async previewForgetConversation(
    location: ConversationLocation,
  ): Promise<MemoryForgetPreview> {
    const episodeRefs: string[] = [];
    for (const document of await this.database.listSearchDocuments()) {
      const metadata = decodeEpisodicMetadata(document);
      if (metadata?.location.conversationId === location.conversationId) {
        episodeRefs.push(episodeRef(location.conversationId, metadata.entryId));
      }
    }
    const candidates = await this.database.queryMemoryCandidates({
      limit: 10_000,
    });
    const candidateIds = candidates
      .filter((candidate) =>
        candidate.origins.some(
          (origin) => origin.conversationId === location.conversationId,
        ),
      )
      .map((candidate) => candidate.candidate.id);
    const memoryIds = (await this.#recordStore.list())
      .filter((stored) =>
        stored.record.evidence.some(
          (evidence) => evidence.conversationId === location.conversationId,
        ),
      )
      .map((stored) => stored.record.id);
    return {
      conversationId: location.conversationId,
      episodeRefs: [...new Set(episodeRefs)].sort(),
      candidateIds: [...new Set(candidateIds)].sort(),
      memoryIds: [...new Set(memoryIds)].sort(),
    };
  }

  async forgetConversation(
    location: ConversationLocation,
  ): Promise<MemoryForgetResult> {
    const preview = await this.previewForgetConversation(location);
    const exclusionPath =
      await this.#recordStore.writeConversationExclusion(location);
    await this.removeStaleConversationDocuments(location.conversationId);
    await this.database.deleteMemoryCandidatesByConversation(
      location.conversationId,
    );
    await this.database.deleteMemorySourceState(location.conversationId);
    let retracted = 0;
    let needsReview = 0;
    for (const stored of await this.#recordStore.list()) {
      if (
        stored.record.status !== "active" ||
        !stored.record.evidence.some(
          (evidence) => evidence.conversationId === location.conversationId,
        )
      ) {
        continue;
      }
      const next: DurableMemoryRecord = {
        ...stored.record,
        revision: stored.record.revision + 1,
        status: "retracted",
        updatedAt: this.#now().toISOString(),
        previousRevisionHash: stored.hash,
      };
      try {
        const retractedRecord = await this.#recordStore.write(next, {
          expectedCurrentHash: stored.hash,
        });
        const document = await this.curatedSearchDocument(retractedRecord);
        if (document) await this.database.upsertSearchDocument(document);
        retracted += 1;
      } catch {
        needsReview += 1;
      }
    }
    return {
      ...preview,
      exclusionPath,
      retracted,
      needsReview,
    };
  }

  async previewConsolidation(
    scope: MemoryScope,
  ): Promise<ConsolidationPreview> {
    const candidates = await this.database.queryMemoryCandidates({
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

  async consolidate(scope: MemoryScope): Promise<ConsolidationResult> {
    const preview = await this.previewConsolidation(scope);
    const candidates = await this.database.queryMemoryCandidates({
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
      const evidence = await this.resolveCandidateEvidence(candidate.origins);
      if (evidence?.length) {
        groundedEvidence.set(candidate.candidate.id, evidence);
      }
    }
    const consolidationProvider =
      typeof this.#consolidationProvider === "function"
        ? this.#consolidationProvider()
        : this.#consolidationProvider;
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
        await this.writeConsolidationReview(
          scope,
          candidate.candidate.id,
          "needs-review",
          candidate.origins,
          "Evidence was missing, ambiguous, modified, or not owner-authored.",
        );
        continue;
      }
      const allStored = await this.#recordStore.list(scope);
      const providerProposal = providerProposals.get(candidate.candidate.id);
      if (consolidationProvider && !providerProposal) {
        needsReview += 1;
        continue;
      }
      const proposedSummary =
        providerProposal?.summary ?? candidate.candidate.normalizedClaim;
      const proposedSupersessionKey =
        providerProposal?.supersessionKey ??
        candidate.candidate.supersessionKey;
      const existing = proposedSupersessionKey
        ? allStored.find(
            (stored) =>
              stored.record.supersessionKey === proposedSupersessionKey,
          )
        : undefined;
      if (existing && contradictory(existing.record.summary, proposedSummary)) {
        needsReview += 1;
        await this.writeConsolidationReview(
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
      const now = this.#now().toISOString();
      const combinedEvidence = dedupeEvidence([
        ...(existing?.record.evidence ?? []),
        ...evidence,
      ]);
      if (
        existing &&
        existing.record.summary === proposedSummary &&
        combinedEvidence.length === existing.record.evidence.length
      ) {
        await this.markCandidatePromoted(candidate, id);
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
        importance:
          providerProposal?.importance ?? candidate.candidate.importance,
        triggers: providerProposal?.triggers ?? candidate.candidate.triggers,
        summary: proposedSummary,
        evidence: combinedEvidence,
        createdBy: providerProposal
          ? "consolidator"
          : "deterministic-promotion",
        createdAt: existing?.record.createdAt ?? now,
        updatedAt: now,
        ...(existing ? { previousRevisionHash: existing.hash } : {}),
      };
      try {
        const stored = await this.#recordStore.write(record, {
          ...(existing ? { expectedCurrentHash: existing.hash } : {}),
        });
        const document = await this.curatedSearchDocument(stored);
        if (document) await this.database.upsertSearchDocument(document);
        await this.markCandidatePromoted(candidate, id);
        await this.writeConsolidationReview(
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
        await this.writeConsolidationReview(
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

  private async markInconsistent(
    location: ConversationLocation,
    episodes: ProjectedEpisode[],
    errorCode: string,
  ): Promise<void> {
    await this.database.upsertMemorySourceState({
      sourceKey: location.conversationId,
      sourcePath: transcriptPath(location),
      sourceHash: await sha256Text(
        episodes
          .map((episode) => `${episode.entry.id}:${episode.entryHash}`)
          .join("\n"),
      ),
      status: "inconsistent",
      indexedAt: this.#now().getTime(),
      errorCode,
    });
  }

  private async removeStaleConversationDocuments(
    conversationId: string,
  ): Promise<void> {
    const documents = await this.database.listSearchDocuments();
    for (const document of documents) {
      if (document.sourceProviderId !== AI_MEMORY_EPISODIC_PROVIDER_ID)
        continue;
      if (
        decodeEpisodicMetadata(document)?.location.conversationId ===
        conversationId
      ) {
        await this.database.deleteSearchDocument(document.path);
      }
    }
  }

  private async curatedSearchDocument(
    stored: StoredMemoryRecord,
  ): Promise<SearchDocumentRecord | null> {
    const verification = await this.verifyEvidence(stored.record.evidence);
    const ownerAuthoredWithoutEvidence =
      stored.record.createdBy === "owner-ui" &&
      stored.record.evidence.length === 0;
    if (!ownerAuthoredWithoutEvidence && !verification.allMatching) return null;
    const metadata: CuratedDocumentMetadata = {
      schemaVersion: 1,
      corpus: "curated",
      record: stored.record,
      effectiveTrust: ownerAuthoredWithoutEvidence
        ? "owner"
        : verification.effectiveTrust,
      evidenceVerified: verification.allMatching,
    };
    const path = curatedMemoryPath(stored.record.scope, stored.record.id);
    return {
      path,
      sourceProviderId: AI_MEMORY_CURATED_PROVIDER_ID,
      name: stored.record.summary.slice(0, 80),
      extension: "ai-memory",
      checksum: stored.hash,
      content: [stored.record.summary, ...stored.record.triggers].join("\n"),
      metadataText: canonicalJson(metadata),
      tags: stored.record.triggers,
      tagParts: [],
      tagHierarchy: [],
      chunks: [
        {
          id: `${path}#summary`,
          text: stored.record.summary,
          startOffset: 0,
          endOffset: stored.record.summary.length,
          kind: "paragraph",
        },
      ],
    };
  }

  private async verifyEvidence(evidence: MemoryEvidenceRef[]): Promise<{
    allMatching: boolean;
    effectiveTrust: MemoryOriginClass;
    messages: MemoryEvidenceMessage[];
  }> {
    const messages: MemoryEvidenceMessage[] = [];
    const origins = new Set<MemoryOriginClass>();
    let allMatching = true;
    for (const ref of evidence) {
      const detail = await this.get(
        episodeRef(ref.conversationId, ref.entryId),
        { scopeDir: ref.scopeDirAtObservation },
      );
      const message = detail.evidenceMessages[0];
      if (!message) {
        allMatching = false;
        continue;
      }
      const verification =
        message.hash === ref.entryHash ? "matching" : "modified";
      origins.add(message.originClass);
      if (messages.length < 6) messages.push({ ...message, verification });
      if (verification !== "matching") allMatching = false;
    }
    const effectiveTrust: MemoryOriginClass = origins.has("owner")
      ? "owner"
      : origins.has("agent")
        ? "agent"
        : origins.has("untrusted")
          ? "untrusted"
          : "system";
    return {
      allMatching,
      effectiveTrust,
      messages,
    };
  }

  private async getCurated(
    id: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<MemoryDetail> {
    signal?.throwIfAborted();
    const matches = await this.#recordStore.find(id);
    if (matches.length > 1) {
      return {
        ref: curatedRef(id, revision),
        corpus: "curated",
        status: "ambiguous",
        evidenceMessages: [],
      };
    }
    const current = matches[0];
    if (!current) {
      return {
        ref: curatedRef(id, revision),
        corpus: "curated",
        status: "missing",
        evidenceMessages: [],
      };
    }
    const history = await this.#recordStore.listHistory(
      id,
      current.record.scope,
    );
    const record =
      current.record.revision === revision
        ? current.record
        : history.find((candidate) => candidate.revision === revision);
    if (!record) {
      return {
        ref: curatedRef(id, revision),
        corpus: "curated",
        status: "missing",
        evidenceMessages: [],
        history,
      };
    }
    const verification = await this.verifyEvidence(record.evidence);
    const status = verification.messages.some(
      (message) => message.verification === "modified",
    )
      ? "modified"
      : verification.messages.length < record.evidence.slice(0, 6).length
        ? "missing"
        : "available";
    return {
      ref: curatedRef(id, revision),
      corpus: "curated",
      status,
      result: curatedResult(record, verification.effectiveTrust, 1),
      evidenceMessages: verification.messages,
      history,
    };
  }

  private async resolveCandidateEvidence(
    origins: Array<{
      conversationId: string;
      entryId: string;
      entryHash: string;
      observedAt: number;
    }>,
  ): Promise<MemoryEvidenceRef[] | null> {
    const refs: MemoryEvidenceRef[] = [];
    for (const origin of origins) {
      const matches = (await this.repository.listAll()).filter(
        (entry) => entry.location.conversationId === origin.conversationId,
      );
      if (matches.length !== 1 || matches[0]?.unavailableReason) return null;
      const snapshot = await this.repository.read(matches[0]!.location);
      const entry = snapshot.transcript.find(
        (candidate) => candidate.id === origin.entryId,
      );
      if (!entry || entry.type !== "message" || entry.role !== "user")
        return null;
      const hash = await transcriptEntryHash(entry);
      if (hash !== origin.entryHash) return null;
      refs.push({
        conversationId: origin.conversationId,
        entryId: origin.entryId,
        entryHash: hash,
        observedAt: entry.createdAt,
        scopeDirAtObservation: snapshot.location.scopeDir,
      });
    }
    return dedupeEvidence(refs);
  }

  private async markCandidatePromoted(
    candidate: Awaited<
      ReturnType<MemoryDatabase["queryMemoryCandidates"]>
    >[number],
    memoryId: string,
  ): Promise<void> {
    await this.database.upsertMemoryCandidate({
      candidate: {
        ...candidate.candidate,
        state: "promoted",
        promotedMemoryId: memoryId,
      },
      origins: candidate.origins,
    });
  }

  private async writeConsolidationReview(
    scope: MemoryScope,
    candidateId: string,
    outcome: "needs-review" | "written",
    origins: Array<{
      conversationId: string;
      entryId: string;
      entryHash: string;
    }>,
    reason: string,
    details: {
      expectedPreimageHash?: string;
      memoryId?: string;
      resultingRevision?: number;
      resultingRevisionHash?: string;
    } = {},
  ): Promise<void> {
    const jobId = await deterministicMemoryId(
      "review",
      candidateId,
      this.#now().toISOString(),
    );
    const frontmatter = {
      schemaVersion: 1,
      jobId,
      scope,
      candidateIds: [candidateId],
      outcome,
      ...details,
      evidence: origins.map((origin) => ({
        conversationId: origin.conversationId,
        entryId: origin.entryId,
        entryHash: origin.entryHash,
      })),
      createdAt: this.#now().toISOString(),
    };
    await this.#recordStore
      .writeReview(
        scope,
        jobId,
        `---\n${canonicalJson(frontmatter)}\n---\n\n# Memory consolidation review\n\n${reason}\n`,
      )
      .catch(() => undefined);
  }

  private async recordRecallSignals(
    query: string,
    results: MemorySearchResult[],
  ): Promise<void> {
    const key = "ai.memory.query-fingerprint-salt";
    let salt = await this.database.getMeta<string>(key);
    if (!salt) {
      salt = crypto.randomUUID();
      await this.database.setMeta(key, salt);
    }
    const queryFingerprint = await sha256Text(
      `${salt}\u0000${query.trim().toLocaleLowerCase()}`,
    );
    const day = this.#now().toISOString().slice(0, 10);
    for (const result of results) {
      await this.database.recordMemoryRecallSignal({
        targetRef: result.ref,
        queryFingerprint,
        day,
        bestScore: result.score,
        hitCount: 1,
      });
    }
  }
}

type ProjectedEpisode = {
  entry: Extract<TranscriptEntry, { type: "message" | "tool" }>;
  entryHash: string;
  text: string;
  originClass: MemoryOriginClass;
};

async function projectEpisodes(
  snapshot: ConversationSnapshot,
): Promise<ProjectedEpisode[]> {
  const projected: ProjectedEpisode[] = [];
  for (const entry of snapshot.transcript) {
    if (entry.type !== "message" && entry.type !== "tool") continue;
    const text = episodeText(entry);
    if (text === null) continue;
    projected.push({
      entry,
      entryHash: await transcriptEntryHash(entry),
      text,
      originClass:
        entry.type === "tool"
          ? "untrusted"
          : entry.role === "user"
            ? "owner"
            : "agent",
    });
  }
  return projected;
}

function episodeText(
  entry: Extract<TranscriptEntry, { type: "message" | "tool" }>,
): string | null {
  if (entry.type === "message") return entry.text.trim() ? entry.text : null;
  if (entry.type === "tool") {
    const text = entry.output ?? entry.input;
    return text?.trim() ? text : null;
  }
  return null;
}

function firstDuplicateEntry(episodes: ProjectedEpisode[]): string | null {
  const seen = new Map<string, string>();
  for (const episode of episodes) {
    const prior = seen.get(episode.entry.id);
    if (prior !== undefined) return episode.entry.id;
    seen.set(episode.entry.id, episode.entryHash);
  }
  return null;
}

function episodeSearchDocument(
  location: ConversationLocation,
  episode: ProjectedEpisode,
): SearchDocumentRecord {
  const scope = conversationMemoryScope(location.scopeDir);
  const metadata: EpisodicDocumentMetadata = {
    schemaVersion: 1,
    corpus: "episodic",
    location,
    entryId: episode.entry.id,
    entryHash: episode.entryHash,
    observedAt: episode.entry.createdAt,
    originClass: episode.originClass,
    scope,
  };
  const path = episodicMemoryPath(
    scope,
    location.conversationId,
    episode.entry.id,
  );
  return {
    path,
    sourceProviderId: AI_MEMORY_EPISODIC_PROVIDER_ID,
    name: `Memory episode ${episode.entry.id}`,
    extension: "ai-memory-episode",
    checksum: episode.entryHash,
    content: episode.text,
    metadataText: canonicalJson(metadata),
    tags: [],
    tagParts: [],
    tagHierarchy: [],
    chunks: [
      {
        id: `${path}#entry`,
        text: episode.text,
        startOffset: 0,
        endOffset: episode.text.length,
        kind: "paragraph",
      },
    ],
  };
}

function decodeEpisodicMetadata(
  document: SearchDocumentRecord,
): EpisodicDocumentMetadata | null {
  if (
    document.sourceProviderId !== AI_MEMORY_EPISODIC_PROVIDER_ID ||
    !document.metadataText
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      document.metadataText,
    ) as EpisodicDocumentMetadata;
    return parsed.schemaVersion === 1 &&
      parsed.corpus === "episodic" &&
      typeof parsed.location?.conversationId === "string" &&
      typeof parsed.entryId === "string" &&
      typeof parsed.entryHash === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function decodeCuratedMetadata(
  document: SearchDocumentRecord,
): CuratedDocumentMetadata | null {
  if (
    document.sourceProviderId !== AI_MEMORY_CURATED_PROVIDER_ID ||
    !document.metadataText
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(document.metadataText) as CuratedDocumentMetadata;
    return parsed.schemaVersion === 1 &&
      parsed.corpus === "curated" &&
      typeof parsed.record?.id === "string" &&
      typeof parsed.record?.revision === "number"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function decodeCuratedResults(
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

function curatedResult(
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

function decodeEpisodicResults(
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

function episodeResultFromDocument(
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

function episodeEvidenceMessage(
  episode: ProjectedEpisode,
  modified: boolean,
): MemoryEvidenceMessage {
  return {
    id: episode.entry.id,
    type: episode.entry.type,
    ...(episode.entry.type === "message" ? { role: episode.entry.role } : {}),
    text: episode.text,
    observedAt: episode.entry.createdAt,
    originClass: episode.originClass,
    hash: episode.entryHash,
    verification: modified ? "modified" : "matching",
  };
}

function episodeRef(conversationId: string, entryId: string): string {
  return `episode:${encodeURIComponent(conversationId)}:${encodeURIComponent(entryId)}`;
}

function curatedRef(id: string, revision: number): string {
  return `memory:${encodeURIComponent(id)}:${revision}`;
}

function parseCuratedRef(ref: string): { id: string; revision: number } | null {
  const match = /^memory:([^:]+):(\d+)$/u.exec(ref);
  if (!match) return null;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) return null;
  try {
    return { id: decodeURIComponent(match[1]!), revision };
  } catch {
    return null;
  }
}

function parseEpisodeRef(
  ref: string,
): { conversationId: string; entryId: string } | null {
  const match = /^episode:([^:]+):([^:]+)$/u.exec(ref);
  if (!match) return null;
  try {
    return {
      conversationId: decodeURIComponent(match[1]!),
      entryId: decodeURIComponent(match[2]!),
    };
  } catch {
    return null;
  }
}

function transcriptPath(location: ConversationLocation): string {
  return `${conversationDirectory(location)}/transcript.jsonl`;
}

function withinDateBounds(
  observedAt: string,
  query: MemorySearchQuery,
): boolean {
  const value = Date.parse(observedAt);
  if (!Number.isFinite(value)) return false;
  if (query.since && value < Date.parse(query.since)) return false;
  if (query.before && value >= Date.parse(query.before)) return false;
  return true;
}

function raceWithAbort<T>(
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

function recencyScore(observedAt: string, now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(observedAt)) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / 30);
}

function truncateSnippet(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= MAX_SNIPPET_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function selectMmr(
  candidates: RankedEpisode[],
  limit: number,
): RankedEpisode[] {
  return selectMemoryMmr(candidates, limit, {
    score: (item) => item.result.score,
    text: (item) => item.result.snippet,
  });
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "project" ||
      (right.kind === "project" && left.projectDir === right.projectDir))
  );
}

function dedupeEvidence(evidence: MemoryEvidenceRef[]): MemoryEvidenceRef[] {
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

function contradictory(current: string, proposed: string): boolean {
  const negated = (value: string) =>
    /\b(?:not|never|no longer|do not|don't|mustn't|shouldn't)\b/iu.test(value);
  return (
    current.toLocaleLowerCase() !== proposed.toLocaleLowerCase() &&
    negated(current) !== negated(proposed)
  );
}

function recallContent(result: MemorySearchResult): string {
  return [
    result.snippet,
    `Provenance: ${result.evidence.map((evidence) => `${evidence.conversationId}/${evidence.entryId}`).join(", ") || "owner-authored memory"}`,
  ].join("\n");
}

function validateConsolidationProposal(
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

export const __memoryServiceInternals = {
  contradictory,
  curatedRef,
  episodeRef,
  parseCuratedRef,
  parseEpisodeRef,
  projectEpisodes,
  selectMmr,
};
