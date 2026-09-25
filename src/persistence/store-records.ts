import { ControllerError, type Interaction, type Preparation, type Receipt, type Thread, type Turn } from "../contracts.js";
import { decode, durableErrorCode } from "./store-codec.js";
import type { StoreHost } from "./store-host.js";

export function readThread(host: StoreHost, id: string): Thread | undefined {
  const thread = decode<Thread>(
    host.db.prepare("SELECT body FROM threads WHERE id=?").get(id),
  );
  return thread ? host.capture.clean(thread, true) : undefined;
}

export function authorizeThread(
  host: StoreHost,
  owner: string,
  id: string,
): Thread {
  const thread = readThread(host, id);
  if (!thread || thread.owner !== owner)
    throw new ControllerError("not_found", "Thread not found");
  return thread;
}

export function listThreads(host: StoreHost, owner: string): Thread[] {
  return host.db
    .prepare("SELECT body FROM threads WHERE owner=? ORDER BY rowid")
    .all(owner)
    .map((row) => host.capture.clean(decode<Thread>(row)!, true));
}

export function readTurn(host: StoreHost, id: string): Turn | undefined {
  const value = structuredClone(
    host.volatileTurns.get(id) ??
      decode<Turn>(host.db.prepare("SELECT body FROM turns WHERE id=?").get(id)),
  );
  return value ? host.capture.clean(value, true) : undefined;
}

export function listTurns(host: StoreHost, threadId?: string): Turn[] {
  const rows = threadId
    ? host.db
        .prepare("SELECT body FROM turns WHERE thread_id=? ORDER BY rowid")
        .all(threadId)
    : host.db.prepare("SELECT body FROM turns ORDER BY rowid").all();
  return rows.map((row) => {
    const item = decode<Turn>(row)!;
    return host.capture.clean(host.volatileTurns.get(item.id) ?? item, true);
  });
}

export function saveTurn(host: StoreHost, turn: Turn): void {
  turn = host.capture.clean(turn, true);
  const privateTurn =
    readThread(host, turn.threadId)!.payloadPolicy === "metadata-only";
  const stored = privateTurn
    ? {
        ...turn,
        text: undefined,
        parts: undefined,
        output: undefined,
        error: durableErrorCode(turn.error),
      }
    : turn;
  host.db
    .prepare(
      "INSERT INTO turns VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .run(turn.id, turn.threadId, JSON.stringify(stored));
  if (privateTurn) host.volatileTurns.set(turn.id, structuredClone(turn));
}

export function readReceipt(
  host: StoreHost,
  owner: string,
  commandId: string,
): Receipt | undefined {
  return decode<Receipt>(
    host.db
      .prepare("SELECT body FROM commands WHERE owner=? AND id=?")
      .get(owner, commandId),
  );
}

export function readPreparation(
  host: StoreHost,
  turnId: string,
): Preparation | undefined {
  const value =
    host.volatilePreparations.get(turnId) ??
    decode<Preparation>(
      host.db
        .prepare("SELECT body FROM preparations WHERE turn_id=?")
        .get(turnId),
    );
  return value && typeof value.text === "string"
    ? host.capture.clean(value)
    : undefined;
}

export function readInteraction(
  host: StoreHost,
  id: string,
): Interaction | undefined {
  const value = structuredClone(
    host.volatileInteractions.get(id) ??
      decode<Interaction>(
        host.db.prepare("SELECT body FROM interactions WHERE id=?").get(id),
      ),
  );
  return value ? host.capture.clean(value, true) : undefined;
}

export function listInteractions(
  host: StoreHost,
  threadId: string,
): Interaction[] {
  return host.db
    .prepare("SELECT id FROM interactions WHERE thread_id=?")
    .all(threadId)
    .map((row) => readInteraction(host, String(row.id))!);
}
