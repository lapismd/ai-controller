import { ControllerError } from "../contracts.js";
import { decodeSession } from "./store-codec.js";
import type { StoreHost } from "./store-host.js";
import type { AuthSessionRow } from "./store-session-row.js";

export function sessionByTokenHash(
  host: StoreHost,
  tokenHash: string,
): AuthSessionRow | undefined {
  return decodeSession(
    host.db.prepare("SELECT * FROM sessions WHERE token_hash=?").get(tokenHash),
  );
}

export function activeSessionByCredential(
  host: StoreHost,
  fingerprint: string,
  now: number,
): AuthSessionRow | undefined {
  return decodeSession(
    host.db
      .prepare(
        "SELECT * FROM sessions WHERE credential_fingerprint=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC",
      )
      .get(fingerprint, now),
  );
}

export function refreshSession(
  host: StoreHost,
  id: string,
  expiresAt: number,
): AuthSessionRow {
  return host.transaction(() => {
    host.db.prepare("UPDATE sessions SET expires_at=? WHERE id=?").run(expiresAt, id);
    const row = decodeSession(
      host.db.prepare("SELECT * FROM sessions WHERE id=?").get(id),
    );
    if (!row) throw new ControllerError("not_found", "Session not found");
    return row;
  });
}

export function replaceCredentialSession(
  host: StoreHost,
  row: AuthSessionRow,
): AuthSessionRow {
  return host.transaction(() => {
    host.db
      .prepare(
        "UPDATE sessions SET revoked_at=? WHERE credential_fingerprint=? AND revoked_at IS NULL",
      )
      .run(row.createdAt, row.credentialFingerprint);
    host.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,NULL)")
      .run(
        row.id,
        row.principalId,
        row.applicationId,
        row.credentialFingerprint,
        JSON.stringify(row.scopes),
        JSON.stringify(row.providers),
        JSON.stringify(row.workspaces),
        row.tokenHash,
        row.createdAt,
        row.expiresAt,
      );
    return row;
  });
}

export function revokeSession(
  host: StoreHost,
  id: string,
  at: number,
): boolean {
  const result = host.db
    .prepare(
      "UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
    )
    .run(at, id);
  return Number(result.changes) > 0;
}
