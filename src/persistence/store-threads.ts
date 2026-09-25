import { randomUUID } from "node:crypto";
import {
  ControllerError,
  isTerminal,
  requiredString,
  type Json,
  type Thread,
  type ThreadInput,
} from "../contracts.js";
import { appendEvent } from "./store-events.js";
import type { StoreHost } from "./store-host.js";
import { authorizeThread, listTurns, readThread } from "./store-records.js";

export function createThread(
  host: StoreHost,
  owner: string,
  input: ThreadInput,
  application = owner,
): Thread {
  input = host.capture.clean(input, true);
  requiredString(owner, "owner");
  requiredString(input.provider, "provider");
  requiredString(input.workspace, "workspace");
  requiredString(application, "application");
  if (
    input.payloadPolicy &&
    !["durable", "metadata-only"].includes(input.payloadPolicy)
  )
    throw new ControllerError("invalid_input", "Unknown payload policy");
  const id = input.id ? requiredString(input.id, "thread id") : randomUUID();
  const thread: Thread = host.capture.clean(
    {
      ...input,
      id,
      owner,
      application,
      payloadPolicy: input.payloadPolicy ?? "durable",
      capturePolicy: host.capture.policyId,
      version: 1,
      createdAt: Date.now(),
    },
    true,
  );
  return host.transaction(() => {
    if (readThread(host, id))
      throw new ControllerError("conflict", "Thread already exists");
    host.db
      .prepare("INSERT INTO threads VALUES(?,?,?)")
      .run(id, owner, JSON.stringify(thread));
    appendEvent(host, id, "thread.created", { provider: thread.provider });
    return thread;
  });
}

export function bindSession(
  host: StoreHost,
  threadId: string,
  nativeSessionId: string,
): void {
  host.capture.clean({ nativeSessionId }, true);
  requiredString(nativeSessionId, "native session");
  host.transaction(() => {
    const thread = readThread(host, threadId);
    if (!thread) throw new ControllerError("not_found", "Thread not found");
    host.db
      .prepare("UPDATE threads SET body=? WHERE id=?")
      .run(JSON.stringify({ ...thread, nativeSessionId }), threadId);
    appendEvent(
      host,
      threadId,
      "session.bound",
      { nativeSessionId },
      undefined,
      undefined,
      true,
    );
  });
}

export function configureThread(
  host: StoreHost,
  owner: string,
  threadId: string,
  version: number,
  configuration: import("../contracts.js").ProviderConfig,
): Thread {
  return host.transaction(() => {
    const thread = authorizeThread(host, owner, threadId);
    if (thread.version !== version)
      throw new ControllerError(
        "version_conflict",
        "Thread configuration changed",
      );
    if (listTurns(host, threadId).some((turn) => !isTerminal(turn.state)))
      throw new ControllerError(
        "thread_busy",
        "Configure the thread after pending turns finish",
      );
    const next = host.capture.clean(
      { ...thread, version: version + 1, configuration },
      true,
    );
    host.db
      .prepare("UPDATE threads SET body=? WHERE id=?")
      .run(JSON.stringify(next), threadId);
    appendEvent(
      host,
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
