import type { SearchDocumentRecord } from "./database-port.js";
import type {
  ConversationLocation,
  ConversationSnapshot,
  TranscriptEntry,
} from "./conversation-types.js";
import { conversationDirectory } from "./conversation-paths.js";
import { canonicalJson, transcriptEntryHash } from "./hashes.js";
import {
  AI_MEMORY_CURATED_PROVIDER_ID,
  AI_MEMORY_EPISODIC_PROVIDER_ID,
  conversationMemoryScope,
  episodicMemoryPath,
} from "./paths.js";
import type {
  DurableMemoryRecord,
  MemoryEvidenceMessage,
  MemoryOriginClass,
  MemoryScope,
} from "./types.js";

export type EpisodicDocumentMetadata = {
  schemaVersion: 1;
  corpus: "episodic";
  location: ConversationLocation;
  entryId: string;
  entryHash: string;
  observedAt: string;
  originClass: MemoryOriginClass;
  scope: MemoryScope;
};

export type CuratedDocumentMetadata = {
  schemaVersion: 1;
  corpus: "curated";
  record: DurableMemoryRecord;
  effectiveTrust: MemoryOriginClass;
  evidenceVerified: boolean;
};

export type ProjectedEpisode = {
  entry: Extract<TranscriptEntry, { type: "message" | "tool" }>;
  entryHash: string;
  text: string;
  originClass: MemoryOriginClass;
};

export async function projectEpisodes(
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

export function episodeText(
  entry: Extract<TranscriptEntry, { type: "message" | "tool" }>,
): string | null {
  if (entry.type === "message") return entry.text.trim() ? entry.text : null;
  if (entry.type === "tool") {
    const text = entry.output ?? entry.input;
    return text?.trim() ? text : null;
  }
  return null;
}

export function firstDuplicateEntry(
  episodes: ProjectedEpisode[],
): string | null {
  const seen = new Map<string, string>();
  for (const episode of episodes) {
    const prior = seen.get(episode.entry.id);
    if (prior !== undefined) return episode.entry.id;
    seen.set(episode.entry.id, episode.entryHash);
  }
  return null;
}

export function episodeSearchDocument(
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

export function decodeEpisodicMetadata(
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

export function decodeCuratedMetadata(
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

export function episodeEvidenceMessage(
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

export function episodeRef(conversationId: string, entryId: string): string {
  return `episode:${encodeURIComponent(conversationId)}:${encodeURIComponent(entryId)}`;
}

export function curatedRef(id: string, revision: number): string {
  return `memory:${encodeURIComponent(id)}:${revision}`;
}

export function parseCuratedRef(
  ref: string,
): { id: string; revision: number } | null {
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

export function parseEpisodeRef(
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

export function transcriptPath(location: ConversationLocation): string {
  return `${conversationDirectory(location)}/transcript.jsonl`;
}
