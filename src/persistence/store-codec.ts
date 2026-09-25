import type { AuthSessionRow } from "./store-session-row.js";

export type Row = { body: string };
export type EventRow = { sequence: number; body: string };

export function durableErrorCode(error?: string): string | undefined {
  if (!error) return undefined;
  return /^[a-z0-9_]{1,64}$/.test(error) ? error : "execution_failed";
}

export function decode<T>(row: unknown): T | undefined {
  return row ? (JSON.parse((row as Row).body) as T) : undefined;
}

export function decodeSession(row: unknown): AuthSessionRow | undefined {
  if (!row || typeof row !== "object") return;
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    principalId: String(value.principal_id),
    applicationId: String(value.application_id),
    credentialFingerprint: String(value.credential_fingerprint),
    scopes: JSON.parse(String(value.scopes)),
    providers: JSON.parse(String(value.providers)),
    workspaces: JSON.parse(String(value.workspaces)),
    tokenHash: String(value.token_hash),
    createdAt: Number(value.created_at),
    expiresAt: Number(value.expires_at),
    ...(value.revoked_at == null
      ? {}
      : { revokedAt: Number(value.revoked_at) }),
  };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
