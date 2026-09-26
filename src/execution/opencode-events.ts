import type { ExecutionContext } from "../domain/ports.js";
import type { Json } from "../contracts.js";
import type { OpenCodeServer } from "./opencode-server.js";

export type OpenCodeEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

/** Reads bounded SSE frames from the authenticated local server. */
export async function* openCodeEvents(response: Response): AsyncGenerator<OpenCodeEvent> {
  if (!response.body) throw new Error("OpenCode event stream is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error("OpenCode event frame is too large");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const event = JSON.parse(data) as OpenCodeEvent;
        if (typeof event.type === "string") yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Map OpenCode's session-scoped stream to the controller's durable events. */
export async function consumeOpenCodeEvents(
  events: AsyncIterable<OpenCodeEvent>,
  server: OpenCodeServer,
  sessionId: string,
  context: ExecutionContext,
): Promise<void> {
  const textByPart = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  const interactions = new Set<string>();
  let terminal = false;
  for await (const event of events) {
    const props = record(event.properties);
    if (props.sessionID !== sessionId) continue;
    if (event.type === "session.next.text.delta") {
      const key = String(props.textID ?? "");
      const delta = String(props.delta ?? "");
      textByPart.set(key, (textByPart.get(key) ?? "") + delta);
      if (delta) await context.emit({ type: "text", text: delta, messageId: String(props.assistantMessageID ?? "") });
    } else if (event.type === "message.part.updated") {
      const part = record(props.part);
      if (part.type !== "text" || typeof part.text !== "string") continue;
      const key = String(part.id ?? "");
      const previous = textByPart.get(key) ?? "";
      const delta = part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text;
      textByPart.set(key, part.text);
      if (delta) await context.emit({ type: "text", text: delta, messageId: String(part.messageID ?? "") });
    } else if (event.type === "permission.asked" || event.type === "permission.v2.asked") {
      const id = String(props.id ?? "");
      if (!/^per[_a-zA-Z0-9-]+$/.test(id)) continue;
      if (interactions.has(id)) continue;
      interactions.add(id);
      const decision = context.interact("approval", id, props as Json, Date.now() + 15 * 60_000)
        .then((value) => server.json(`/permission/${encodeURIComponent(id)}/reply`, "POST", {
          reply: value === "allow_always" ? "always" : value === "allow_once" ? "once" : "reject",
        }).then(() => undefined),
        () => server.json(`/permission/${encodeURIComponent(id)}/reply`, "POST", { reply: "reject" }).then(() => undefined))
        .finally(() => pending.delete(decision));
      pending.add(decision);
    } else if (event.type === "question.asked" || event.type === "question.v2.asked") {
      const id = String(props.id ?? "");
      if (!/^que[_a-zA-Z0-9-]+$/.test(id)) continue;
      if (interactions.has(id)) continue;
      interactions.add(id);
      const answer = context.interact("input", id, props as Json, Date.now() + 15 * 60_000)
        .then((value) => {
          const answers = value && typeof value === "object" && !Array.isArray(value)
            ? (value as { answers?: unknown }).answers : value;
          if (!Array.isArray(answers) || !answers.every((item) => Array.isArray(item) && item.every((label) => typeof label === "string")))
            throw new Error("Invalid OpenCode question answers");
          return server.json(`/question/${encodeURIComponent(id)}/reply`, "POST", { answers });
        }, () => server.json(`/question/${encodeURIComponent(id)}/reject`, "POST"))
        .then(() => undefined)
        .finally(() => pending.delete(answer));
      pending.add(answer);
    } else if (event.type === "session.error") {
      await context.emit({ type: "failed", code: "provider_failed" });
      terminal = true;
      break;
    } else if (event.type === "session.idle") {
      await context.emit({ type: "completed" });
      terminal = true;
      break;
    } else if (event.type.startsWith("session.next.tool.")) {
      await context.emit({ type: "activity", data: { type: "provider_extension", sourceType: event.type, observation: props } as Json });
    }
  }
  await Promise.allSettled(pending);
  if (!terminal) throw new Error("OpenCode event stream ended before the session completed");
}
