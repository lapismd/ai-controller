import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ControllerError,
  type AuthSession,
  type ControllerScope,
  type Principal,
} from "../contracts.js";
import type {
  AuthSessionRow,
  ControllerStore,
} from "../persistence/store.js";
import { narrowScopes, resolvePrincipal } from "./scopes.js";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface IssuedAuthSession {
  session: AuthSession;
  token?: string;
}

export interface BootstrapCredential {
  token: string;
  principal: Principal;
}

export class AuthSessionStore {
  constructor(
    readonly store: ControllerStore,
    readonly now: () => number = Date.now,
    readonly ttlMs = SESSION_TTL_MS,
  ) {}

  hello(
    token: string,
    credentials: BootstrapCredential[],
    requestedScopes?: unknown,
  ): IssuedAuthSession {
    const session = this.verify(token);
    if (session)
      return {
        session: { ...session, scopes: narrowScopes(session.scopes, requestedScopes) },
      };
    const credential = matchCredential(credentials, token);
    if (!credential)
      throw new ControllerError("authentication_failed", "Handshake rejected");
    const principal = resolvePrincipal(credential.principal);
    const scopes = narrowScopes(principal.scopes, requestedScopes);
    const fingerprint = digest(token);
    const existing = this.store.activeSessionByCredential(
      fingerprint,
      this.now(),
    );
    if (existing) {
      const refreshed = this.store.refreshSession(
        existing.id,
        this.now() + this.ttlMs,
      );
      return { session: this.#toSession(refreshed, scopes, principal) };
    }
    return this.issue({
      principal,
      scopes,
      fingerprint,
    });
  }

  issue(input: {
    principal: Principal & { applicationId: string; scopes: ControllerScope[] };
    scopes: ControllerScope[];
    fingerprint: string;
  }): IssuedAuthSession {
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const session = this.store.replaceCredentialSession({
      id: crypto.randomUUID(),
      principalId: input.principal.id,
      applicationId: input.principal.applicationId,
      credentialFingerprint: input.fingerprint,
      scopes: input.scopes,
      providers: input.principal.providers,
      workspaces: input.principal.workspaces,
      tokenHash: digest(token),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    return { session: this.#public(session), token };
  }

  verify(token: string): AuthSession | undefined {
    const row = this.store.sessionByTokenHash(digest(token));
    if (!row) return;
    if (row.revokedAt || row.expiresAt <= this.now())
      throw new ControllerError("authentication_failed", "Handshake rejected");
    return this.#public(row);
  }

  revoke(id: string): boolean {
    return this.store.revokeSession(id, this.now());
  }

  issueWebSocketToken(_sessionId: string): never {
    throw new ControllerError(
      "unsupported",
      "WebSocket tickets are not issued",
    );
  }

  #toSession(
    row: AuthSessionRow,
    scopes: ControllerScope[],
    principal: Principal & { applicationId: string; scopes: ControllerScope[] },
  ): AuthSession {
    return {
      id: row.id,
      principalId: principal.id,
      applicationId: principal.applicationId,
      scopes,
      providers: principal.providers,
      workspaces: principal.workspaces,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }

  #public(row: AuthSessionRow): AuthSession {
    return {
      id: row.id,
      principalId: row.principalId,
      applicationId: row.applicationId,
      scopes: row.scopes as ControllerScope[],
      providers: row.providers,
      workspaces: row.workspaces,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  }
}

export function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function matchCredential(
  credentials: BootstrapCredential[],
  token: string,
): BootstrapCredential | undefined {
  const presented = createHash("sha256").update(token).digest();
  return credentials.find((item) =>
    timingSafeEqual(createHash("sha256").update(item.token).digest(), presented),
  );
}
