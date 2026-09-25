import {
  ingestConversation,
  removeStaleConversationDocuments,
} from "./conversation-ingest.js";
import {
  decodeCuratedMetadata,
  decodeEpisodicMetadata,
  episodeRef,
  projectEpisodes,
  transcriptPath,
} from "./episode-documents.js";
import { curatedSearchDocument } from "./memory-inspect.js";
import type { NativeMemoryHost } from "./native-memory-host.js";
import {
  AI_MEMORY_CURATED_PROVIDER_ID,
  AI_MEMORY_EPISODIC_PROVIDER_ID,
  conversationMemoryScope,
  episodicMemoryPath,
} from "./paths.js";
import { sameScope } from "./search-ranking.js";
import { conversationLocationFromSourcePath } from "./evidence-port.js";
import type { ConversationLocation } from "./conversation-types.js";
import type {
  DurableMemoryRecord,
  MemoryForgetPreview,
  MemoryForgetResult,
  MemoryRebuildResult,
  MemoryScope,
} from "./types.js";

export async function rebuildNativeMemory(
  host: NativeMemoryHost,
  scope?: MemoryScope,
): Promise<MemoryRebuildResult> {
  const listed = [...(await host.repository.listAll())].sort((left, right) =>
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
  const exclusions = await host.recordStore.listExcludedConversationIds();
  for (const entry of listed) {
    const entryScope = conversationMemoryScope(entry.location.scopeDir);
    if (scope && !sameScope(scope, entryScope)) continue;
    if (entry.unavailableReason) {
      skipped += 1;
      continue;
    }
    if (exclusions.has(entry.location.conversationId)) {
      skipped += 1;
      await removeStaleConversationDocuments(
        host,
        entry.location.conversationId,
      );
      await host.database.deleteMemoryCandidatesByConversation(
        entry.location.conversationId,
      );
      await host.database.deleteMemorySourceState(entry.location.conversationId);
      continue;
    }
    if ((counts.get(entry.location.conversationId) ?? 0) > 1) {
      inconsistent += 1;
      await host.database.upsertMemorySourceState({
        sourceKey: entry.location.conversationId,
        sourcePath: transcriptPath(entry.location),
        sourceHash: "",
        status: "inconsistent",
        indexedAt: host.now().getTime(),
        errorCode: "duplicate-conversation-id",
      });
      continue;
    }
    await ingestConversation(host, entry.location);
    const snapshot = await host.repository.read(entry.location);
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
    await host.yieldToApp();
  }

  const listedConversationIds = new Set(
    listed.map((entry) => entry.location.conversationId),
  );
  for (const source of await host.database.listMemorySourceStates()) {
    if (listedConversationIds.has(source.sourceKey)) continue;
    const priorLocation = conversationLocationFromSourcePath(source.sourcePath);
    if (
      scope &&
      priorLocation &&
      !sameScope(scope, conversationMemoryScope(priorLocation.scopeDir))
    ) {
      continue;
    }
    await removeStaleConversationDocuments(host, source.sourceKey);
    await host.database.deleteMemoryCandidatesByConversation(source.sourceKey);
    await host.database.deleteMemorySourceState(source.sourceKey);
  }

  const indexed = await host.database.listSearchDocuments();
  for (const document of indexed) {
    if (document.sourceProviderId !== AI_MEMORY_EPISODIC_PROVIDER_ID) continue;
    const metadata = decodeEpisodicMetadata(document);
    if (scope && metadata && !sameScope(scope, metadata.scope)) continue;
    if (!expected.has(document.path)) {
      await host.database.deleteSearchDocument(document.path);
    }
  }
  const curatedRecords = await host.recordStore.list(scope);
  const expectedCurated = new Set<string>();
  for (const stored of curatedRecords) {
    const document = await curatedSearchDocument(host, stored);
    if (!document) continue;
    expectedCurated.add(document.path);
    const existing = await host.database.getSearchDocument(document.path);
    if (existing?.checksum !== document.checksum) {
      await host.database.upsertSearchDocument(document);
    }
  }
  for (const document of indexed) {
    if (document.sourceProviderId !== AI_MEMORY_CURATED_PROVIDER_ID) continue;
    const metadata = decodeCuratedMetadata(document);
    if (scope && metadata && !sameScope(scope, metadata.record.scope)) continue;
    if (!expectedCurated.has(document.path)) {
      await host.database.deleteSearchDocument(document.path);
    }
  }
  return { conversations, episodes, skipped, inconsistent };
}

export async function previewForgetConversation(
  host: NativeMemoryHost,
  location: ConversationLocation,
): Promise<MemoryForgetPreview> {
  const episodeRefs: string[] = [];
  for (const document of await host.database.listSearchDocuments()) {
    const metadata = decodeEpisodicMetadata(document);
    if (metadata?.location.conversationId === location.conversationId) {
      episodeRefs.push(episodeRef(location.conversationId, metadata.entryId));
    }
  }
  const candidates = await host.database.queryMemoryCandidates({
    limit: 10_000,
  });
  const candidateIds = candidates
    .filter((candidate) =>
      candidate.origins.some(
        (origin) => origin.conversationId === location.conversationId,
      ),
    )
    .map((candidate) => candidate.candidate.id);
  const memoryIds = (await host.recordStore.list())
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

export async function forgetConversation(
  host: NativeMemoryHost,
  location: ConversationLocation,
): Promise<MemoryForgetResult> {
  const preview = await previewForgetConversation(host, location);
  const exclusionPath =
    await host.recordStore.writeConversationExclusion(location);
  await removeStaleConversationDocuments(host, location.conversationId);
  await host.database.deleteMemoryCandidatesByConversation(
    location.conversationId,
  );
  await host.database.deleteMemorySourceState(location.conversationId);
  let retracted = 0;
  let needsReview = 0;
  for (const stored of await host.recordStore.list()) {
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
      updatedAt: host.now().toISOString(),
      previousRevisionHash: stored.hash,
    };
    try {
      const retractedRecord = await host.recordStore.write(next, {
        expectedCurrentHash: stored.hash,
      });
      const document = await curatedSearchDocument(host, retractedRecord);
      if (document) await host.database.upsertSearchDocument(document);
      retracted += 1;
    } catch {
      needsReview += 1;
    }
  }
  return { ...preview, exclusionPath, retracted, needsReview };
}
