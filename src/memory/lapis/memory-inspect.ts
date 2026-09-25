import { conversationLocationFromSourcePath } from "./evidence-port.js";
import {
  curatedRef,
  decodeEpisodicMetadata,
  episodeEvidenceMessage,
  episodeRef,
  episodeSearchDocument,
  parseCuratedRef,
  parseEpisodeRef,
  projectEpisodes,
  type CuratedDocumentMetadata,
} from "./episode-documents.js";
import { canonicalJson } from "./hashes.js";
import type { NativeMemoryHost } from "./native-memory-host.js";
import {
  AI_MEMORY_CURATED_PROVIDER_ID,
  conversationMemoryScope,
  curatedMemoryPath,
  episodicMemoryPath,
} from "./paths.js";
import { curatedResult, episodeResultFromDocument } from "./search-ranking.js";
import type { SearchDocumentRecord } from "./database-port.js";
import type { StoredMemoryRecord } from "./memory-record-store.js";
import type {
  MemoryContext,
  MemoryDetail,
  MemoryEvidenceMessage,
  MemoryEvidenceRef,
  MemoryOriginClass,
} from "./types.js";

export async function getNativeMemory(
  host: NativeMemoryHost,
  ref: string,
  _context: MemoryContext,
  signal?: AbortSignal,
): Promise<MemoryDetail> {
  signal?.throwIfAborted();
  const curated = parseCuratedRef(ref);
  if (curated) return getCuratedMemory(host, curated.id, curated.revision, signal);
  const parsed = parseEpisodeRef(ref);
  if (!parsed) {
    return {
      ref,
      corpus: "episodic",
      status: "missing",
      evidenceMessages: [],
    };
  }
  const matches = (await host.repository.listAll()).filter(
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
  const snapshot = await host.repository.read(match.location);
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
  let document = await host.database.getSearchDocument(currentPath);
  if (!document) {
    const source = await host.database.getMemorySourceState(
      snapshot.location.conversationId,
    );
    const previousLocation = source
      ? conversationLocationFromSourcePath(source.sourcePath)
      : null;
    if (previousLocation) {
      document = await host.database.getSearchDocument(
        episodicMemoryPath(
          conversationMemoryScope(previousLocation.scopeDir),
          previousLocation.conversationId,
          episode.entry.id,
        ),
      );
    }
  }
  const indexed = document ? decodeEpisodicMetadata(document) : null;
  const modified = Boolean(indexed && indexed.entryHash !== episode.entryHash);
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

export async function curatedSearchDocument(
  host: NativeMemoryHost,
  stored: StoredMemoryRecord,
): Promise<SearchDocumentRecord | null> {
  const verification = await verifyEvidence(host, stored.record.evidence);
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

export async function verifyEvidence(
  host: NativeMemoryHost,
  evidence: MemoryEvidenceRef[],
): Promise<{
  allMatching: boolean;
  effectiveTrust: MemoryOriginClass;
  messages: MemoryEvidenceMessage[];
}> {
  const messages: MemoryEvidenceMessage[] = [];
  const origins = new Set<MemoryOriginClass>();
  let allMatching = true;
  for (const ref of evidence) {
    const detail = await getNativeMemory(
      host,
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
  return { allMatching, effectiveTrust, messages };
}

export async function getCuratedMemory(
  host: NativeMemoryHost,
  id: string,
  revision: number,
  signal?: AbortSignal,
): Promise<MemoryDetail> {
  signal?.throwIfAborted();
  const matches = await host.recordStore.find(id);
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
  const history = await host.recordStore.listHistory(id, current.record.scope);
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
  const verification = await verifyEvidence(host, record.evidence);
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
