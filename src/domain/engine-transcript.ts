import { assertTranscript } from "../capture/validation.js";
import { CaptureSession, type Captured } from "../capture/session.js";
import { ControllerError, type Json, type Turn } from "../contracts.js";
import { threadEndpointKey } from "../auth/authorize.js";
import type { ControllerHost } from "./engine-host.js";

export function captureFor(host: ControllerHost, turn: Turn): CaptureSession {
  let capture = host.captures.get(turn.id);
  if (!capture) {
    capture = new CaptureSession(
      host.store.thread(turn.threadId)!,
      turn,
      host.store.capture,
      () => host.store.nextTranscriptSequence(turn.threadId),
    );
    host.captures.set(turn.id, capture);
  }
  return capture;
}

export async function persistCapture(
  host: ControllerHost,
  turn: Turn,
  records: Captured[],
): Promise<void> {
  if (!records.length) return;
  const thread = host.store.thread(turn.threadId)!;
  const endpoint = thread.transcriptEndpoint
    ? host.transcripts.get(threadEndpointKey(thread, thread.transcriptEndpoint))
    : undefined;
  if (thread.transcriptEndpoint && !endpoint)
    throw new ControllerError(
      "transcript_unavailable",
      "Transcript endpoint unavailable",
    );
  for (const { event, projection } of records) {
    if (event) {
      assertTranscript(event);
      if (endpoint) {
        const ack = await endpoint.append(thread, event);
        if (
          ack.durable !== true ||
          ack.eventId !== event.id ||
          ack.sequence !== event.sequence
        )
          throw new ControllerError(
            "transcript_unacknowledged",
            "Transcript was not durably acknowledged",
          );
      }
    }
    host.store.transaction(() => {
      if (event)
        host.store.append(
          thread.id,
          "transcript.event",
          event as unknown as Json,
          turn.id,
          event.id,
        );
      if (projection?.type === "text" && event)
        host.store.ingestText(
          turn.id,
          projection.text,
          `${event.id}:projection`,
          projection,
        );
      else if (projection?.type === "activity") {
        const data =
          projection.data &&
          typeof projection.data === "object" &&
          !Array.isArray(projection.data)
            ? projection.data
            : {};
        const status = String(data.status ?? data.type ?? "activity");
        host.store.append(
          thread.id,
          "output.activity",
          projection.data,
          turn.id,
          `${event?.id ?? `${turn.attemptId}:${status}`}:projection`,
        );
      }
    });
    if (projection?.type === "activity" && host.capture?.observe) {
      try {
        await host.capture.observe({
          caller: "controller",
          requestKey: event?.id ?? `${turn.attemptId}:status`,
          workspaceId: thread.workspace,
          payload: projection.data,
        });
      } catch {
        /* Advisory native observations never repeat tool effects. */
      }
    }
  }
}

export async function replayTranscript(
  host: ControllerHost,
  owner: string,
  threadId: string,
  afterSequence = 0,
  turnId?: string,
) {
  const thread = host.store.authorizeThread(owner, threadId);
  const endpoint = thread.transcriptEndpoint
    ? host.transcripts.get(threadEndpointKey(thread, thread.transcriptEndpoint))
    : undefined;
  if (thread.transcriptEndpoint && !endpoint)
    throw new ControllerError(
      "transcript_unavailable",
      "Transcript endpoint unavailable",
    );
  if (endpoint)
    return host.store.capture.clean(
      await endpoint.replay(thread, afterSequence, turnId),
    );
  return host.store.replayTranscript(owner, threadId, afterSequence, turnId);
}
