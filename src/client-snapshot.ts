import {
  ControllerError,
  type ControllerEvent,
  type Json,
  type Snapshot,
  type Thread,
  type Turn,
} from "./contracts.js";

export function reduceSnapshot(
  snapshot: Snapshot,
  event: ControllerEvent,
): Snapshot {
  const next = structuredClone(snapshot);
  next.cursor = event.cursor;
  const data = event.data as Record<string, Json>;
  if (event.type === "thread.configured") {
    next.thread.version = Number(data.version);
    next.thread.configuration = data.configuration as Thread["configuration"];
  }
  if (
    event.type === "output.activity" ||
    event.type === "transcript.event" ||
    event.type === "output.text"
  ) {
    next.transcript.push(event);
    if (next.transcript.length > 2000) {
      next.transcript.shift();
      next.transcriptTruncated = true;
    }
  }
  if (
    event.type === "session.bound" &&
    typeof data.nativeSessionId === "string"
  )
    next.thread.nativeSessionId = data.nativeSessionId;
  let turn = next.turns.find((item) => item.id === event.turnId);
  if (event.type === "turn.accepted" && !turn && event.turnId) {
    const record = data.turn as unknown as Turn | undefined;
    if (record) {
      next.turns.push(record);
      turn = record;
    }
  }
  if (turn && event.type === "output.text" && typeof data.text === "string")
    turn.output = (turn.output ?? "") + data.text;
  if (turn && event.type === "turn.state") {
    turn.state = data.state as Turn["state"];
    turn.updatedAt = event.at;
    if (typeof data.error === "string") turn.error = data.error;
  }
  if (turn && event.type === "turn.cancel_requested")
    turn.cancelRequested = true;
  if (event.type === "interaction.updated" && typeof data.id === "string") {
    const index = next.interactions.findIndex((item) => item.id === data.id);
    if (index < 0)
      next.interactions.push(
        event.data as unknown as Snapshot["interactions"][number],
      );
    else
      next.interactions[index] =
        event.data as unknown as Snapshot["interactions"][number];
  }
  return next;
}

export function cursorAfter(a: string, b: string): boolean {
  const [epochA, offsetA] = a.split(":");
  const [epochB, offsetB] = b.split(":");
  if (epochA !== epochB)
    throw new ControllerError("resnapshot_required", "Stream epoch changed");
  return Number(offsetA) > Number(offsetB);
}
