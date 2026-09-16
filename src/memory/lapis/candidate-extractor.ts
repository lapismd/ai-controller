import type {
  MemoryDatabase,
  MemoryDatabaseMemoryCandidateInput,
  MemoryDatabaseMemoryCandidateRecord,
} from "./database-port.js";
import type {
  ConversationSnapshot,
  TranscriptEntry,
} from "./conversation-types.js";
import {
  deterministicMemoryId,
  sha256Text,
  transcriptEntryHash,
} from "./hashes.js";
import { conversationMemoryScope } from "./paths.js";
import type { DurableMemoryKind, MemoryOriginClass } from "./types.js";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*\S+/iu,
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/u,
];

const EXPLICIT_CUE =
  /\b(?:remember(?:\s+that)?|i\s+prefer|we\s+decided|always\s+for\s+this\s+project)\b/iu;
const STABLE_CUE =
  /\b(?:prefer|uses?|must|should|decided|convention|workflow|constraint)\b/iu;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "for",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "use",
  "uses",
  "we",
  "with",
]);

export type CandidateExtractionResult = {
  examined: number;
  staged: number;
  review: number;
  rejectedSecrets: number;
};

export type CandidateExtractionOptions = {
  entries?: TranscriptEntry[];
  yieldToApp?: () => Promise<void>;
};

export async function extractDeterministicCandidates(
  snapshot: ConversationSnapshot,
  database: MemoryDatabase,
  options: CandidateExtractionOptions = {},
): Promise<CandidateExtractionResult> {
  let examined = 0;
  let staged = 0;
  let review = 0;
  let rejectedSecrets = 0;
  const entries = options.entries ?? snapshot.transcript;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (index > 0 && index % 200 === 0) {
      await options.yieldToApp?.();
    }
    if (entry.type !== "message") continue;
    const originClass: MemoryOriginClass =
      entry.role === "user" ? "owner" : "agent";
    if (!STABLE_CUE.test(entry.text) && !EXPLICIT_CUE.test(entry.text))
      continue;
    examined += 1;
    if (isSecretBearingMemoryText(entry.text)) {
      rejectedSecrets += 1;
      continue;
    }
    const explicit = originClass === "owner" && EXPLICIT_CUE.test(entry.text);
    const input = await candidateFromEntry(
      snapshot,
      entry,
      originClass,
      explicit,
    );
    const existing = (
      await database.queryMemoryCandidates({
        scopeKind: input.candidate.scopeKind,
        scopePath: input.candidate.scopePath,
        limit: 10_000,
      })
    ).find((candidate) => candidate.candidate.id === input.candidate.id);
    const origins = dedupeOrigins([
      ...(existing?.origins ?? []),
      ...input.origins,
    ]);
    const conversations = new Set(
      origins.map((origin) => origin.conversationId),
    );
    const days = new Set(
      origins.map((origin) =>
        new Date(origin.observedAt).toISOString().slice(0, 10),
      ),
    );
    const qualifiesRecurring = conversations.size >= 2 && days.size >= 2;
    const state: MemoryDatabaseMemoryCandidateRecord["state"] =
      originClass === "agent"
        ? "review"
        : explicit || qualifiesRecurring
          ? "staged"
          : "review";
    await database.upsertMemoryCandidate({
      candidate: {
        ...(existing?.candidate ?? input.candidate),
        lastSeenAt: Math.max(
          existing?.candidate.lastSeenAt ?? 0,
          input.candidate.lastSeenAt,
        ),
        recurrenceCount: origins.length,
        conversationCount: conversations.size,
        state: existing?.candidate.state === "promoted" ? "promoted" : state,
      },
      origins,
    });
    if (state === "staged") staged += 1;
    else review += 1;
  }
  return { examined, staged, review, rejectedSecrets };
}

async function candidateFromEntry(
  snapshot: ConversationSnapshot,
  entry: Extract<TranscriptEntry, { type: "message" }>,
  originClass: MemoryOriginClass,
  explicit: boolean,
): Promise<MemoryDatabaseMemoryCandidateInput> {
  const scope = candidateScope(snapshot.location.scopeDir, entry.text);
  const normalizedClaim = normalizeClaim(entry.text);
  const claimHash = await sha256Text(normalizedClaim.toLocaleLowerCase());
  const scopePath = scope.kind === "project" ? scope.projectDir : "";
  const kind = candidateKind(entry.text);
  const id = await deterministicMemoryId(
    "candidate",
    scope.kind,
    scopePath,
    kind,
    claimHash,
  );
  const observedAt = Date.parse(entry.createdAt);
  return {
    candidate: {
      id,
      scopeKind: scope.kind,
      scopePath,
      kind,
      normalizedClaim,
      claimHash,
      ...(supersessionKey(entry.text, kind)
        ? { supersessionKey: supersessionKey(entry.text, kind) }
        : {}),
      originClass,
      importance: explicit ? 4 : 3,
      triggers: extractTriggers(normalizedClaim),
      state:
        originClass === "agent" ? "review" : explicit ? "staged" : "review",
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      recurrenceCount: 1,
      conversationCount: 1,
    },
    origins: [
      {
        candidateId: id,
        conversationId: snapshot.location.conversationId,
        entryId: entry.id,
        entryHash: await transcriptEntryHash(entry),
        observedAt,
      },
    ],
  };
}

function candidateScope(scopeDir: string, text: string) {
  if (/\b(?:this|the)\s+project\b/iu.test(text) && scopeDir) {
    return conversationMemoryScope(scopeDir);
  }
  if (/\b(?:i\s+prefer|my\s+preference)\b/iu.test(text)) {
    return { kind: "user" as const };
  }
  return scopeDir
    ? conversationMemoryScope(scopeDir)
    : { kind: "workspace" as const };
}

function normalizeClaim(text: string): string {
  return text
    .replace(/^\s*(?:please\s+)?remember(?:\s+that)?\s+/iu, "")
    .replace(/^\s*i\s+prefer\s+/iu, "Prefer ")
    .replace(/^\s*we\s+decided\s+(?:that\s+|to\s+)?/iu, "")
    .replace(/^\s*always\s+for\s+this\s+project[,;:]?\s*/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "");
}

function candidateKind(text: string): DurableMemoryKind {
  if (/\bprefer(?:ence)?\b/iu.test(text)) return "preference";
  if (/\bdecided\b/iu.test(text)) return "decision";
  if (/\b(?:must|never|always|constraint)\b/iu.test(text)) return "constraint";
  if (/\b(?:workflow|procedure|steps?|run|execute)\b/iu.test(text)) {
    return "procedure";
  }
  return "fact";
}

function supersessionKey(
  text: string,
  kind: DurableMemoryKind,
): string | undefined {
  const normalized = normalizeClaim(text).toLocaleLowerCase();
  const subject = /^(.{2,80}?)\s+(?:is|are|uses?|must|should)\b/u.exec(
    normalized,
  )?.[1];
  if (!subject) return undefined;
  return `${kind}:${subject.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "")}`;
}

function extractTriggers(claim: string): string[] {
  const tokens = claim.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [
    ...new Set(
      tokens.filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
    ),
  ].slice(0, 8);
}

export function isSecretBearingMemoryText(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function dedupeOrigins<T extends { conversationId: string; entryId: string }>(
  origins: T[],
): T[] {
  return [
    ...new Map(
      origins.map((origin) => [
        `${origin.conversationId}\u0000${origin.entryId}`,
        origin,
      ]),
    ).values(),
  ].sort((left, right) =>
    `${left.conversationId}\u0000${left.entryId}`.localeCompare(
      `${right.conversationId}\u0000${right.entryId}`,
    ),
  );
}

export const __candidateExtractorInternals = {
  containsSecret: isSecretBearingMemoryText,
  extractTriggers,
  normalizeClaim,
  supersessionKey,
};
