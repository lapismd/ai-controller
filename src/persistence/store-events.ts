import { randomUUID } from "node:crypto";
import {
  ControllerError,
  isTerminal,
  type ControllerEvent,
  type Json,
  type Snapshot,
} from "../contracts.js";
import { eventCursor, parseCursor } from "./store-cursors.js";
import type { EventRow } from "./store-codec.js";
import type { StoreHost } from "./store-host.js";
import {
  authorizeThread,
  listInteractions,
  listTurns,
  readThread,
  readTurn,
  saveTurn,
} from "./store-records.js";

export function appendEvent(
  host: StoreHost,
  threadId: string,
  type: string,
  data: Json,
  turnId?: string,
  sourceId?: string,
  metadata = false,
): ControllerEvent | undefined {
  if (!host.pendingEvents)
    return host.transaction(() =>
      appendEvent(host, threadId, type, data, turnId, sourceId, metadata),
    );
  data = host.capture.clean(data);
  host.capture.clean({ threadId, turnId, sourceId }, true);
  const id = sourceId ? `${turnId ?? threadId}:${sourceId}` : randomUUID();
  if (host.db.prepare("SELECT id FROM events WHERE id=?").get(id))
    return undefined;
  const privatePayload =
    !metadata && readThread(host, threadId)!.payloadPolicy === "metadata-only";
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
    ? {
        ...event,
        data: {
          payloadUnavailable: true,
          ...(type === "transcript.event" &&
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof data.sequence === "number"
            ? { sequence: data.sequence }
            : {}),
        },
      }
    : event;
  const result = host.db
    .prepare("INSERT INTO events(id,thread_id,body) VALUES(?,?,?)")
    .run(id, threadId, JSON.stringify(stored));
  event.cursor = eventCursor(host, Number(result.lastInsertRowid));
  if (privatePayload) {
    host.volatileEvents.set(id, event);
    if (host.volatileEvents.size > 10_000)
      host.volatileEvents.delete(host.volatileEvents.keys().next().value!);
  }
  host.pendingEvents.push(event);
  return event;
}

export function ingestText(
  host: StoreHost,
  turnId: string,
  text: string,
  sourceId?: string,
  boundary?: { messageId?: string; complete?: boolean },
): void {
  text = host.capture.clean(text);
  host.transaction(() => {
    const turn = readTurn(host, turnId)!;
    if (isTerminal(turn.state)) return;
    if ((turn.output?.length ?? 0) + text.length > 8_000_000)
      throw new ControllerError(
        "output_limit",
        "Turn output exceeds the configured capture limit",
      );
    const event = appendEvent(
      host,
      turn.threadId,
      "output.text",
      {
        text,
        ...(boundary?.messageId ? { messageId: boundary.messageId } : {}),
        ...(boundary?.complete ? { complete: true } : {}),
      },
      turnId,
      sourceId,
    );
    if (event) saveTurn(host, { ...turn, output: (turn.output ?? "") + text });
  });
}

export function snapshotThread(
  host: StoreHost,
  owner: string,
  threadId: string,
): Snapshot {
  return host.transaction(() => ({
    thread: authorizeThread(host, owner, threadId),
    turns: listTurns(host, threadId),
    interactions: listInteractions(host, threadId),
    ...transcriptSnapshot(host, threadId),
    cursor: eventCursor(
      host,
      Number(
        host.db
          .prepare("SELECT coalesce(max(sequence),0) AS n FROM events")
          .get()!.n,
      ),
    ),
  }));
}

export function transcriptSnapshot(
  host: StoreHost,
  threadId: string,
): {
  transcript: ControllerEvent[];
  transcriptTruncated: boolean;
} {
  const rows = host.db
    .prepare(
      "SELECT sequence,body FROM events WHERE thread_id=? AND json_extract(body,'$.type') IN ('output.activity','output.text','transcript.event') ORDER BY sequence DESC LIMIT 2001",
    )
    .all(threadId) as unknown as EventRow[];
  const transcriptTruncated = rows.length > 2000;
  const transcript = rows
    .slice(0, 2000)
    .reverse()
    .map((row) => {
      const event = JSON.parse(row.body) as ControllerEvent;
      return host.capture.clean(
        {
          ...(host.volatileEvents.get(event.id) ?? event),
          cursor: eventCursor(host, row.sequence),
        },
        true,
      );
    });
  return { transcript, transcriptTruncated };
}

export function listEvents(
  host: StoreHost,
  owner: string,
  threadId: string,
  after: string,
  limit = 1000,
): ControllerEvent[] {
  authorizeThread(host, owner, threadId);
  const sequence = parseCursor(host, after);
  return (
    host.db
      .prepare(
        "SELECT sequence,body FROM events WHERE thread_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(threadId, sequence, Math.max(1, Math.min(limit, 1000))) as unknown as EventRow[]
  ).map((row) => {
    const stored = JSON.parse(row.body) as ControllerEvent;
    return host.capture.clean(
      {
        ...(host.volatileEvents.get(stored.id) ?? stored),
        cursor: eventCursor(host, row.sequence),
      },
      true,
    );
  });
}

export function nextTranscriptSequence(
  host: StoreHost,
  threadId: string,
): number {
  host.capture.clean({ threadId }, true);
  return Number(
    host.db.prepare(
      "INSERT INTO transcript_sequence(thread_id,sequence) VALUES(?,1) ON CONFLICT(thread_id) DO UPDATE SET sequence=sequence+1 RETURNING sequence",
    ).get(threadId)!.sequence,
  );
}

export function replayStoredTranscript(
  host: StoreHost,
  owner: string,
  threadId: string,
  afterSequence: number,
  turnId?: string,
) {
  authorizeThread(host, owner, threadId);
  const records = host.db
    .prepare(
      "SELECT body FROM events WHERE thread_id=? AND json_extract(body,'$.type')='transcript.event' AND COALESCE(json_extract(body,'$.data.sequence'),9223372036854775807)>? AND (? IS NULL OR json_extract(body,'$.turnId')=?) ORDER BY sequence LIMIT 1001",
    )
    .all(threadId, afterSequence, turnId ?? null, turnId ?? null);
  const events = records.slice(0, 1000).map((row) => {
    const stored = JSON.parse(String(row.body)) as ControllerEvent;
    const data = (host.volatileEvents.get(stored.id) ?? stored).data;
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      data.payloadUnavailable
    )
      throw new ControllerError(
        "transcript_unavailable",
        "Private transcript content is unavailable after interruption",
      );
    return host.capture.clean(data) as unknown as import("../transcript-contracts.js").TranscriptEvent;
  });
  return {
    events,
    complete: records.length <= 1000,
    ...(records.length > 1000 ? { nextSequence: events.at(-1)!.sequence } : {}),
  };
}
