import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  ControllerError,
  isTerminal,
  requiredString,
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

type Row = { body: string };
type EventRow = { sequence: number; body: string };
export class ControllerStore {
  readonly #db: DatabaseSync;
  readonly #unlock: () => void;
  readonly #volatileTurns = new Map<string, Turn>();
  readonly #volatilePreparations = new Map<string, Preparation>();
  readonly #volatileInteractions = new Map<string, Interaction>();
  readonly #volatileEvents = new Map<string, ControllerEvent>();
  readonly #listeners = new Set<(event: ControllerEvent) => void>();
  #pendingEvents: ControllerEvent[] | undefined;
  #closed = false;
  readonly epoch: string;

  constructor(readonly path: string) {
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
      if (version > 1)
        throw new ControllerError(
          "schema_unsupported",
          "Database requires a newer controller",
        );
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id);
        CREATE TABLE IF NOT EXISTS commands(owner TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,id));
        CREATE TABLE IF NOT EXISTS preparations(turn_id TEXT PRIMARY KEY REFERENCES turns(id), body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id), body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id,sequence);
        CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), body TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
      this.#db
        .prepare("INSERT OR IGNORE INTO meta VALUES('epoch',?)")
        .run(randomUUID());
      this.epoch = String(
        this.#db.prepare("SELECT value FROM meta WHERE key='epoch'").get()!
          .value,
      );
    } catch (error) {
      opened?.close();
      this.#unlock();
      throw error;
    }
  }
  transaction<T>(operation: () => T): T {
    if (this.#pendingEvents) return operation();
    this.#db.exec("BEGIN IMMEDIATE");
    this.#pendingEvents = [];
    // Volatile state must roll back alongside its metadata transaction.
    const backup = [
      new Map(this.#volatileTurns),
      new Map(this.#volatilePreparations),
      new Map(this.#volatileInteractions),
      new Map(this.#volatileEvents),
    ] as const;
    let result: T;
    let committed: ControllerEvent[];
    try {
      result = operation();
      this.#db.exec("COMMIT");
      committed = this.#pendingEvents;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      for (const [map, saved] of [
        [this.#volatileTurns, backup[0]],
        [this.#volatilePreparations, backup[1]],
        [this.#volatileInteractions, backup[2]],
        [this.#volatileEvents, backup[3]],
      ] as const) {
        map.clear();
        for (const [key, value] of saved)
          (map as Map<string, unknown>).set(key, value);
      }
      throw error;
    } finally {
      this.#pendingEvents = undefined;
    }
    for (const event of committed)
      for (const listener of this.#listeners) {
        try {
          listener(structuredClone(event));
        } catch {
          /* Observer failures cannot undo a committed receipt. */
        }
      }
    return result;
  }
  onEvent(listener: (event: ControllerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  createThread(owner: string, input: ThreadInput): Thread {
    requiredString(owner, "owner");
    requiredString(input.provider, "provider");
    requiredString(input.workspace, "workspace");
    if (
      input.payloadPolicy &&
      !["durable", "metadata-only"].includes(input.payloadPolicy)
    )
      throw new ControllerError("invalid_input", "Unknown payload policy");
    const id = input.id ? requiredString(input.id, "thread id") : randomUUID();
    const thread: Thread = {
      ...input,
      id,
      owner,
      payloadPolicy: input.payloadPolicy ?? "durable",
      version: 1,
      createdAt: Date.now(),
    };
    return this.transaction(() => {
      if (this.thread(id))
        throw new ControllerError("conflict", "Thread already exists");
      this.#db
        .prepare("INSERT INTO threads VALUES(?,?,?)")
        .run(id, owner, JSON.stringify(thread));
      this.append(id, "thread.created", { provider: thread.provider });
      return thread;
    });
  }
  thread(id: string): Thread | undefined {
    return decode<Thread>(
      this.#db.prepare("SELECT body FROM threads WHERE id=?").get(id),
    );
  }
  bindSession(threadId: string, nativeSessionId: string): void {
    requiredString(nativeSessionId, "native session");
    this.transaction(() => {
      const thread = this.thread(threadId);
      if (!thread) throw new ControllerError("not_found", "Thread not found");
      this.#db
        .prepare("UPDATE threads SET body=? WHERE id=?")
        .run(JSON.stringify({ ...thread, nativeSessionId }), threadId);
      this.append(
        threadId,
        "session.bound",
        { nativeSessionId },
        undefined,
        undefined,
        true,
      );
    });
  }
  configure(
    owner: string,
    threadId: string,
    version: number,
    configuration: import("../contracts.js").ProviderConfig,
  ): Thread {
    return this.transaction(() => {
      const thread = this.authorizeThread(owner, threadId);
      if (thread.version !== version)
        throw new ControllerError(
          "version_conflict",
          "Thread configuration changed",
        );
      if (this.turns(threadId).some((turn) => !isTerminal(turn.state)))
        throw new ControllerError(
          "thread_busy",
          "Configure the thread after pending turns finish",
        );
      const next = { ...thread, version: version + 1, configuration };
      this.#db
        .prepare("UPDATE threads SET body=? WHERE id=?")
        .run(JSON.stringify(next), threadId);
      this.append(
        threadId,
        "thread.configured",
        { version: next.version, configuration: next.configuration as Json },
        undefined,
        undefined,
        true,
      );
      return next;
    });
  }
  authorizeThread(owner: string, id: string): Thread {
    const thread = this.thread(id);
    if (!thread || thread.owner !== owner)
      throw new ControllerError("not_found", "Thread not found");
    return thread;
  }
  threads(owner: string): Thread[] {
    return this.#db
      .prepare("SELECT body FROM threads WHERE owner=? ORDER BY rowid")
      .all(owner)
      .map((row) => decode<Thread>(row)!);
  }
  accept(owner: string, input: TurnInput): Receipt {
    requiredString(input.commandId, "command id");
    if (
      typeof input.text !== "string" ||
      input.text.length > 1_000_000 ||
      (!input.text.trim() && !input.parts?.length)
    )
      throw new ControllerError(
        "invalid_input",
        "Turn input is empty or too large",
      );
    const thread = this.authorizeThread(owner, input.threadId);
    const digest = createHash("sha256").update(canonical(input)).digest("hex");
    return this.transaction(() => {
      const prior = this.#db
        .prepare("SELECT digest,body FROM commands WHERE owner=? AND id=?")
        .get(owner, input.commandId);
      if (prior) {
        if (prior.digest !== digest)
          throw new ControllerError(
            "command_conflict",
            "Command key has different input",
          );
        return decode<Receipt>(prior)!;
      }
      const now = Date.now();
      const turn: Turn = {
        id: randomUUID(),
        threadId: thread.id,
        commandId: input.commandId,
        attemptId: randomUUID(),
        state: "queued",
        text: input.text,
        parts: input.parts,
        output: "",
        externalRef: input.externalRef,
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
      };
      const receipt: Receipt = {
        commandId: input.commandId,
        threadId: thread.id,
        turnId: turn.id,
        acceptedAt: now,
        durability: thread.payloadPolicy,
      };
      this.saveTurn(turn);
      this.#db
        .prepare("INSERT INTO commands VALUES(?,?,?,?)")
        .run(owner, input.commandId, digest, JSON.stringify(receipt));
      this.append(
        thread.id,
        "turn.accepted",
        { turn: turn as unknown as Json },
        turn.id,
      );
      return receipt;
    });
  }
  receipt(owner: string, commandId: string): Receipt | undefined {
    return decode<Receipt>(
      this.#db
        .prepare("SELECT body FROM commands WHERE owner=? AND id=?")
        .get(owner, commandId),
    );
  }
  turn(id: string): Turn | undefined {
    return structuredClone(
      this.#volatileTurns.get(id) ??
        decode<Turn>(
          this.#db.prepare("SELECT body FROM turns WHERE id=?").get(id),
        ),
    );
  }
  turns(threadId?: string): Turn[] {
    const rows = threadId
      ? this.#db
          .prepare("SELECT body FROM turns WHERE thread_id=? ORDER BY rowid")
          .all(threadId)
      : this.#db.prepare("SELECT body FROM turns ORDER BY rowid").all();
    return rows.map((row) => {
      const item = decode<Turn>(row)!;
      return structuredClone(this.#volatileTurns.get(item.id) ?? item);
    });
  }
  saveTurn(turn: Turn): void {
    const privateTurn =
      this.thread(turn.threadId)!.payloadPolicy === "metadata-only";
    const stored = privateTurn
      ? { ...turn, text: undefined, parts: undefined, output: undefined }
      : turn;
    this.#db
      .prepare(
        "INSERT INTO turns VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(turn.id, turn.threadId, JSON.stringify(stored));
    if (privateTurn) this.#volatileTurns.set(turn.id, structuredClone(turn));
  }
  transition(id: string, state: TurnState, error?: string): Turn {
    return this.transaction(() => {
      const turn = this.turn(id);
      if (!turn) throw new ControllerError("not_found", "Turn not found");
      if (isTerminal(turn.state) && state !== turn.state)
        throw new ControllerError("turn_terminal", "Turn is terminal");
      const next = {
        ...turn,
        state,
        updatedAt: Date.now(),
        ...(error ? { error } : {}),
      };
      this.saveTurn(next);
      this.append(
        turn.threadId,
        "turn.state",
        { state, error: error ?? null },
        id,
        undefined,
        true,
      );
      return next;
    });
  }
  prepare(turnId: string, preparation: Preparation): void {
    this.transaction(() => {
      const turn = this.turn(turnId)!;
      const durable = this.thread(turn.threadId)!.payloadPolicy === "durable";
      this.#db
        .prepare(
          "INSERT INTO preparations VALUES(?,?) ON CONFLICT(turn_id) DO UPDATE SET body=excluded.body",
        )
        .run(
          turnId,
          JSON.stringify(
            durable
              ? preparation
              : {
                  version: preparation.version,
                  omitted: preparation.omitted,
                  payloadUnavailable: true,
                },
          ),
        );
      if (!durable)
        this.#volatilePreparations.set(turnId, structuredClone(preparation));
      this.transition(turnId, "prepared");
    });
  }
  preparation(turnId: string): Preparation | undefined {
    const value =
      this.#volatilePreparations.get(turnId) ??
      decode<Preparation>(
        this.#db
          .prepare("SELECT body FROM preparations WHERE turn_id=?")
          .get(turnId),
      );
    return value && typeof value.text === "string"
      ? structuredClone(value)
      : undefined;
  }
  append(
    threadId: string,
    type: string,
    data: Json,
    turnId?: string,
    sourceId?: string,
    metadata = false,
  ): ControllerEvent | undefined {
    if (!this.#pendingEvents)
      return this.transaction(() =>
        this.append(threadId, type, data, turnId, sourceId, metadata),
      );
    const id = sourceId ? `${turnId ?? threadId}:${sourceId}` : randomUUID();
    if (this.#db.prepare("SELECT id FROM events WHERE id=?").get(id))
      return undefined;
    const privatePayload =
      !metadata && this.thread(threadId)!.payloadPolicy === "metadata-only";
    const event: ControllerEvent = {
      id,
      cursor: "",
      threadId,
      ...(turnId ? { turnId } : {}),
      type,
      at: Date.now(),
      data,
    };
    const stored = privatePayload
      ? { ...event, data: { payloadUnavailable: true } }
      : event;
    const result = this.#db
      .prepare("INSERT INTO events(id,thread_id,body) VALUES(?,?,?)")
      .run(id, threadId, JSON.stringify(stored));
    event.cursor = this.cursor(Number(result.lastInsertRowid));
    if (privatePayload) {
      this.#volatileEvents.set(id, event);
      if (this.#volatileEvents.size > 10_000)
        this.#volatileEvents.delete(this.#volatileEvents.keys().next().value!);
    }
    this.#pendingEvents.push(event);
    return event;
  }
  ingestText(turnId: string, text: string, sourceId?: string): void {
    this.transaction(() => {
      const turn = this.turn(turnId)!;
      if (isTerminal(turn.state)) return;
      if ((turn.output?.length ?? 0) + text.length > 8_000_000)
        throw new ControllerError(
          "output_limit",
          "Turn output exceeds the configured capture limit",
        );
      const event = this.append(
        turn.threadId,
        "output.text",
        { text },
        turnId,
        sourceId,
      );
      if (event) this.saveTurn({ ...turn, output: (turn.output ?? "") + text });
    });
  }
  interaction(id: string): Interaction | undefined {
    return structuredClone(
      this.#volatileInteractions.get(id) ??
        decode<Interaction>(
          this.#db.prepare("SELECT body FROM interactions WHERE id=?").get(id),
        ),
    );
  }
  interactions(threadId: string): Interaction[] {
    return this.#db
      .prepare("SELECT id FROM interactions WHERE thread_id=?")
      .all(threadId)
      .map((row) => this.interaction(String(row.id))!);
  }
  putInteraction(interaction: Interaction): void {
    this.transaction(() => {
      const privatePayload =
        this.thread(interaction.threadId)!.payloadPolicy === "metadata-only";
      this.#db
        .prepare(
          "INSERT INTO interactions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
        )
        .run(
          interaction.id,
          interaction.threadId,
          JSON.stringify(
            privatePayload
              ? { ...interaction, request: null, response: undefined }
              : interaction,
          ),
        );
      if (privatePayload)
        this.#volatileInteractions.set(
          interaction.id,
          structuredClone(interaction),
        );
      this.append(
        interaction.threadId,
        "interaction.updated",
        interaction as unknown as Json,
        interaction.turnId,
      );
    });
  }
  snapshot(owner: string, threadId: string): Snapshot {
    return this.transaction(() => ({
      thread: this.authorizeThread(owner, threadId),
      turns: this.turns(threadId),
      interactions: this.interactions(threadId),
      ...this.transcriptSnapshot(threadId),
      cursor: this.cursor(
        Number(
          this.#db
            .prepare("SELECT coalesce(max(sequence),0) AS n FROM events")
            .get()!.n,
        ),
      ),
    }));
  }
  private transcriptSnapshot(threadId: string): {
    transcript: ControllerEvent[];
    transcriptTruncated: boolean;
  } {
    const rows = this.#db
      .prepare(
        "SELECT sequence,body FROM events WHERE thread_id=? AND json_extract(body,'$.type') IN ('output.activity','output.text') ORDER BY sequence DESC LIMIT 2001",
      )
      .all(threadId) as unknown as EventRow[];
    const transcriptTruncated = rows.length > 2000;
    const transcript = rows
      .slice(0, 2000)
      .reverse()
      .map((row) => {
        const event = JSON.parse(row.body) as ControllerEvent;
        return structuredClone({
          ...(this.#volatileEvents.get(event.id) ?? event),
          cursor: this.cursor(row.sequence),
        });
      });
    return { transcript, transcriptTruncated };
  }
  events(
    owner: string,
    threadId: string,
    after: string,
    limit = 1000,
  ): ControllerEvent[] {
    this.authorizeThread(owner, threadId);
    const sequence = this.parseCursor(after);
    return (
      this.#db
        .prepare(
          "SELECT sequence,body FROM events WHERE thread_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(
          threadId,
          sequence,
          Math.max(1, Math.min(limit, 1000)),
        ) as unknown as EventRow[]
    ).map((row) => {
      const stored = JSON.parse(row.body) as ControllerEvent;
      return structuredClone({
        ...(this.#volatileEvents.get(stored.id) ?? stored),
        cursor: this.cursor(row.sequence),
      });
    });
  }
  recover(): void {
    this.transaction(() => {
      for (const turn of this.turns()) {
        if (isTerminal(turn.state)) continue;
        if (turn.state === "dispatching")
          this.transition(
            turn.id,
            "submission-unknown",
            "dispatch_outcome_unknown",
          );
        else if (["running", "waiting"].includes(turn.state))
          this.transition(turn.id, "interrupted", "execution_interrupted");
        else if (turn.text === undefined)
          this.transition(
            turn.id,
            "interrupted",
            "private_payload_unavailable",
          );
        else if (turn.state === "preparing") this.transition(turn.id, "queued");
      }
      for (const row of this.#db.prepare("SELECT id FROM interactions").all()) {
        const interaction = this.interaction(String(row.id))!;
        if (interaction.state === "pending")
          this.putInteraction({
            ...interaction,
            state: interaction.kind === "tool" ? "unknown" : "cancelled",
          });
      }
    });
  }
  durableRows(): unknown[] {
    return [
      "threads",
      "turns",
      "commands",
      "preparations",
      "events",
      "interactions",
    ].flatMap((table) => this.#db.prepare(`SELECT * FROM ${table}`).all());
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#db.close();
    this.#unlock();
  }
  private cursor(sequence: number): string {
    return `${this.epoch}:${sequence}`;
  }
  private parseCursor(cursor: string): number {
    const [epoch, offset, extra] = cursor.split(":");
    const sequence = Number(offset);
    if (
      epoch !== this.epoch ||
      extra !== undefined ||
      !/^(0|[1-9]\d*)$/.test(offset ?? "") ||
      !Number.isSafeInteger(sequence)
    )
      throw new ControllerError(
        "resnapshot_required",
        "Cursor cannot be replayed; fetch a snapshot",
      );
    return sequence;
  }
}
function decode<T>(row: unknown): T | undefined {
  return row ? (JSON.parse((row as Row).body) as T) : undefined;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
