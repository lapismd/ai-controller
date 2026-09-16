import type { TranscriptEntry } from "./conversation-types.js";

function canonicalize(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot hash a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot hash ${typeof value}`);
}

export function canonicalConversationJson(value: unknown): string {
  return canonicalize(value);
}

export async function sha256ConversationText(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function transcriptEntryHash(entry: TranscriptEntry): Promise<string> {
  return sha256ConversationText(canonicalConversationJson(entry));
}

export async function transcriptRangeHash(
  entries: readonly TranscriptEntry[],
): Promise<string> {
  const hashes = await Promise.all(
    entries.map(
      async (entry) => `${entry.id}:${await transcriptEntryHash(entry)}`,
    ),
  );
  return sha256ConversationText(hashes.join("\n"));
}
