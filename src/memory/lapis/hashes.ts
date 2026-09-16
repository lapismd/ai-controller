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
    if (!Number.isFinite(value))
      throw new Error("Cannot hash a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
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

export async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function transcriptEntryHash(entry: TranscriptEntry): Promise<string> {
  return sha256Text(canonicalJson(entry));
}

export async function deterministicMemoryId(
  namespace: string,
  ...parts: string[]
): Promise<string> {
  return `${namespace}-${(await sha256Text(parts.join("\u0000"))).slice(0, 32)}`;
}
