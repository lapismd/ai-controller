import { extractDeterministicCandidates } from "./candidate-extractor.js";
import { conversationLocationFromSourcePath } from "./evidence-port.js";
import {
  decodeEpisodicMetadata,
  episodeSearchDocument,
  firstDuplicateEntry,
  projectEpisodes,
  transcriptPath,
  type ProjectedEpisode,
} from "./episode-documents.js";
import { sha256Text } from "./hashes.js";
import { MAX_INGEST_BATCH } from "./memory-limits.js";
import type { NativeMemoryHost } from "./native-memory-host.js";
import {
  AI_MEMORY_EPISODIC_PROVIDER_ID,
  conversationMemoryScope,
  episodicMemoryPath,
} from "./paths.js";
import type { ConversationLocation } from "./conversation-types.js";

export async function ingestConversation(
  host: NativeMemoryHost,
  location: ConversationLocation,
): Promise<void> {
  if (
    (await host.recordStore.listExcludedConversationIds()).has(
      location.conversationId,
    )
  ) {
    await removeStaleConversationDocuments(host, location.conversationId);
    await host.database.deleteMemoryCandidatesByConversation(
      location.conversationId,
    );
    await host.database.deleteMemorySourceState(location.conversationId);
    return;
  }
  const duplicates = (await host.repository.listAll()).filter(
    (entry) => entry.location.conversationId === location.conversationId,
  );
  if (duplicates.length !== 1) {
    await host.database.upsertMemorySourceState({
      sourceKey: location.conversationId,
      sourcePath: transcriptPath(location),
      sourceHash: "",
      status: "inconsistent",
      indexedAt: host.now().getTime(),
      errorCode:
        duplicates.length > 1 ? "duplicate-conversation-id" : "missing-source",
    });
    return;
  }

  const snapshot = await host.repository.read(location);
  const episodes = await projectEpisodes(snapshot);
  const duplicateEntry = firstDuplicateEntry(episodes);
  if (duplicateEntry) {
    await markInconsistent(host, location, episodes, "duplicate-entry-id");
    return;
  }

  const previous = await host.database.getMemorySourceState(
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
      await markInconsistent(host, location, episodes, "entry-hash-mismatch");
      return;
    }
    startIndex = checkpointIndex;
    const indexedLocation = previousLocation ?? location;
    for (const episode of episodes.slice(0, checkpointIndex + 1)) {
      const document = await host.database.getSearchDocument(
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
        await markInconsistent(host, location, episodes, "entry-hash-mismatch");
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
    await removeStaleConversationDocuments(host, location.conversationId);
    startIndex = 0;
  }
  const sourceHash = await sha256Text(
    episodes
      .map((episode) => `${episode.entry.id}:${episode.entryHash}`)
      .join("\n"),
  );
  if (episodes.length === 0) {
    await host.database.upsertMemorySourceState({
      sourceKey: location.conversationId,
      sourcePath: transcriptPath(location),
      sourceHash,
      status: "ready",
      indexedAt: host.now().getTime(),
    });
    return;
  }

  await host.database.beginSearchIndexingBatch();
  try {
    for (
      let offset = startIndex;
      offset < episodes.length;
      offset += MAX_INGEST_BATCH
    ) {
      const batch = episodes.slice(offset, offset + MAX_INGEST_BATCH);
      for (const episode of batch) {
        const document = episodeSearchDocument(snapshot.location, episode);
        const existing = await host.database.getSearchDocument(document.path);
        if (existing?.checksum !== document.checksum) {
          await host.database.upsertSearchDocument(document);
        }
      }
      await extractDeterministicCandidates(snapshot, host.database, {
        entries: batch.map((episode) => episode.entry),
      });
      const cursor = batch.at(-1)!;
      await host.database.upsertMemorySourceState({
        sourceKey: location.conversationId,
        sourcePath: transcriptPath(location),
        sourceHash,
        lastEntryId: cursor.entry.id,
        lastEntryHash: cursor.entryHash,
        status: "ready",
        indexedAt: host.now().getTime(),
      });
      if (offset + MAX_INGEST_BATCH < episodes.length) {
        await host.yieldToApp();
      }
    }
  } finally {
    await host.database.endSearchIndexingBatch();
  }
}

export async function markInconsistent(
  host: NativeMemoryHost,
  location: ConversationLocation,
  episodes: ProjectedEpisode[],
  errorCode: string,
): Promise<void> {
  await host.database.upsertMemorySourceState({
    sourceKey: location.conversationId,
    sourcePath: transcriptPath(location),
    sourceHash: await sha256Text(
      episodes
        .map((episode) => `${episode.entry.id}:${episode.entryHash}`)
        .join("\n"),
    ),
    status: "inconsistent",
    indexedAt: host.now().getTime(),
    errorCode,
  });
}

export async function removeStaleConversationDocuments(
  host: NativeMemoryHost,
  conversationId: string,
): Promise<void> {
  const documents = await host.database.listSearchDocuments();
  for (const document of documents) {
    if (document.sourceProviderId !== AI_MEMORY_EPISODIC_PROVIDER_ID) continue;
    if (
      decodeEpisodicMetadata(document)?.location.conversationId ===
      conversationId
    ) {
      await host.database.deleteSearchDocument(document.path);
    }
  }
}
