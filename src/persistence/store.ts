import { CaptureBoundary } from "../capture/boundary.js";
import { storedTables, validateStoredRecord } from "./schemas.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  ControllerError,
  type ControllerEvent,
  type Interaction,
  type Json,
  type Preparation,
  type Receipt,
  type Snapshot,
  type Thread,
  type ThreadInput,
  type Turn,
  type TurnInput,
  type TurnState,
} from "../contracts.js";
import { acquireWriter } from "./lock.js";
import type { StoreHost } from "./store-host.js";
import { appendEvent, ingestText, listEvents, nextTranscriptSequence, replayStoredTranscript, snapshotThread } from "./store-events.js";
import { putInteraction } from "./store-interactions.js";
import { durableRows, recoverStore } from "./store-recover.js";
import {
  authorizeThread,
  listInteractions,
  listThreads,
  listTurns,
  readInteraction,
  readPreparation,
  readReceipt,
  readThread,
  readTurn,
  saveTurn,
} from "./store-records.js";
import {
  activeSessionByCredential,
  refreshSession,
  replaceCredentialSession,
  revokeSession,
  sessionByTokenHash,
} from "./store-sessions.js";
import { bindSession, configureThread, createThread } from "./store-threads.js";
import { runTransaction } from "./store-transaction.js";
import {
  acceptTurn,
  prepareTurn,
  resolveUncertainTurn,
  transitionTurn,
} from "./store-turns.js";
import type { AuthSessionRow } from "./store-session-row.js";

export type { AuthSessionRow } from "./store-session-row.js";

const SCHEMA_VERSION = 2;

export class ControllerStore {
  readonly #db: DatabaseSync;
  readonly #unlock: () => void;
  readonly #host: StoreHost;
  #closed = false;
  readonly epoch: string;

  constructor(readonly path: string, readonly capture = new CaptureBoundary()) {
    this.#unlock = acquireWriter(path);
    let opened: DatabaseSync | undefined;
    try {
      this.#db = opened = new DatabaseSync(path);
      this.#db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
      );
      const version = Number(
        this.#db.prepare("PRAGMA user_version").get()?.user_version,
      );
      if (version > SCHEMA_VERSION)
        throw new ControllerError(
          "schema_unsupported",
          "Database requires a newer controller",
        );
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transcript_sequence(thread_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id);
        CREATE TABLE IF NOT EXISTS commands(owner TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,id));
        CREATE TABLE IF NOT EXISTS preparations(turn_id TEXT PRIMARY KEY REFERENCES turns(id), body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id), body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id,sequence);
        CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(
          id TEXT PRIMARY KEY,
          principal_id TEXT NOT NULL,
          application_id TEXT NOT NULL,
          credential_fingerprint TEXT NOT NULL,
          scopes TEXT NOT NULL,
          providers TEXT NOT NULL,
          workspaces TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS sessions_credential ON sessions(credential_fingerprint);
        PRAGMA user_version=${SCHEMA_VERSION};
      `);
      for (const table of storedTables)
        for (const row of this.#db
          .prepare(`SELECT body FROM ${table}`)
          .iterate())
          validateStoredRecord(table, row.body);
      this.#db
        .prepare("INSERT OR IGNORE INTO meta VALUES('epoch',?)")
        .run(randomUUID());
      this.epoch = String(
        this.#db.prepare("SELECT value FROM meta WHERE key='epoch'").get()!
          .value,
      );
      this.#host = {
        db: this.#db,
        capture: this.capture,
        epoch: this.epoch,
        volatileTurns: new Map(),
        volatilePreparations: new Map(),
        volatileInteractions: new Map(),
        volatileEvents: new Map(),
        listeners: new Set(),
        transaction: (operation) => this.transaction(operation),
      };
    } catch (error) {
      opened?.close();
      this.#unlock();
      throw error;
    }
  }

  transaction<T>(operation: () => T): T {
    return runTransaction(this.#host, operation);
  }

  onEvent(listener: (event: ControllerEvent) => void): () => void {
    this.#host.listeners.add(listener);
    return () => this.#host.listeners.delete(listener);
  }

  createThread(owner: string, input: ThreadInput, application = owner): Thread {
    return createThread(this.#host, owner, input, application);
  }
  thread(id: string): Thread | undefined {
    return readThread(this.#host, id);
  }
  bindSession(threadId: string, nativeSessionId: string): void {
    bindSession(this.#host, threadId, nativeSessionId);
  }
  configure(
    owner: string,
    threadId: string,
    version: number,
    configuration: import("../contracts.js").ProviderConfig,
  ): Thread {
    return configureThread(this.#host, owner, threadId, version, configuration);
  }
  authorizeThread(owner: string, id: string): Thread {
    return authorizeThread(this.#host, owner, id);
  }
  threads(owner: string): Thread[] {
    return listThreads(this.#host, owner);
  }
  accept(owner: string, input: TurnInput): Receipt {
    return acceptTurn(this.#host, owner, input);
  }
  receipt(owner: string, commandId: string): Receipt | undefined {
    return readReceipt(this.#host, owner, commandId);
  }
  turn(id: string): Turn | undefined {
    return readTurn(this.#host, id);
  }
  turns(threadId?: string): Turn[] {
    return listTurns(this.#host, threadId);
  }
  saveTurn(turn: Turn): void {
    saveTurn(this.#host, turn);
  }
  transition(id: string, state: TurnState, error?: string): Turn {
    return transitionTurn(this.#host, id, state, error);
  }
  resolveUncertain(id: string, outcome: "failed" | "cancelled"): void {
    resolveUncertainTurn(this.#host, id, outcome);
  }
  prepare(turnId: string, preparation: Preparation): void {
    prepareTurn(this.#host, turnId, preparation);
  }
  preparation(turnId: string): Preparation | undefined {
    return readPreparation(this.#host, turnId);
  }
  append(
    threadId: string,
    type: string,
    data: Json,
    turnId?: string,
    sourceId?: string,
    metadata = false,
  ): ControllerEvent | undefined {
    return appendEvent(this.#host, threadId, type, data, turnId, sourceId, metadata);
  }
  ingestText(
    turnId: string,
    text: string,
    sourceId?: string,
    boundary?: { messageId?: string; complete?: boolean },
  ): void {
    ingestText(this.#host, turnId, text, sourceId, boundary);
  }
  interaction(id: string): Interaction | undefined {
    return readInteraction(this.#host, id);
  }
  interactions(threadId: string): Interaction[] {
    return listInteractions(this.#host, threadId);
  }
  putInteraction(interaction: Interaction): void {
    putInteraction(this.#host, interaction);
  }
  snapshot(owner: string, threadId: string): Snapshot {
    return snapshotThread(this.#host, owner, threadId);
  }
  events(owner: string, threadId: string, after: string, limit = 1000) {
    return listEvents(this.#host, owner, threadId, after, limit);
  }
  nextTranscriptSequence(threadId: string): number {
    return nextTranscriptSequence(this.#host, threadId);
  }
  replayTranscript(
    owner: string,
    threadId: string,
    afterSequence: number,
    turnId?: string,
  ) {
    return replayStoredTranscript(
      this.#host,
      owner,
      threadId,
      afterSequence,
      turnId,
    );
  }
  recover(): void {
    recoverStore(this.#host);
  }
  durableRows(): unknown[] {
    return durableRows(this.#host);
  }
  sessionByTokenHash(tokenHash: string): AuthSessionRow | undefined {
    return sessionByTokenHash(this.#host, tokenHash);
  }
  activeSessionByCredential(fingerprint: string, now: number) {
    return activeSessionByCredential(this.#host, fingerprint, now);
  }
  refreshSession(id: string, expiresAt: number): AuthSessionRow {
    return refreshSession(this.#host, id, expiresAt);
  }
  replaceCredentialSession(row: AuthSessionRow): AuthSessionRow {
    return replaceCredentialSession(this.#host, row);
  }
  revokeSession(id: string, at: number): boolean {
    return revokeSession(this.#host, id, at);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#host.listeners.clear();
    this.capture.close();
    this.#db.close();
    this.#unlock();
  }
}
