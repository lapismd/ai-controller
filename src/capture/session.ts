import type { Json, Thread, Turn } from "../contracts.js";
import type { RuntimeEvent } from "../domain/ports.js";
import {
  mergeToolActivity,
  snapshotFromToolActivity,
  toolDisplayInput,
  toolEndActivity,
  toolStartProjection,
  usageCost,
} from "../execution/compat/tool-snapshot.js";
import type { CaptureCoverage, TranscriptEvent, TranscriptPayload } from "../transcript-contracts.js";
import { CaptureBoundary } from "./boundary.js";

export interface Captured { event?: TranscriptEvent; projection?: RuntimeEvent }
type Block = { id: string; messageId?: string; kind: "message" | "thinking"; text: string; bytes: number; omitted?: string };
const textLimit = 2 * 1024 * 1024;

/** Transport chunks remain volatile. Only complete, scanned logical records leave. */
export class CaptureSession {
  #sequence = 0;
  #block?: Block;
  #blockNumber = 0;
  #tools = new Map<string, Record<string, Json>>();
  #seen = new Set<string>();
  #usage?: Captured;
  readonly coverage: CaptureCoverage;
  constructor(readonly thread: Thread, readonly turn: Turn, readonly boundary: CaptureBoundary, readonly allocateSequence?: () => number) {
    this.coverage = { mode: "managed-observable", observations: "complete-exposed", gaps: ["external-provider-traffic", "external-native-session-files"] };
  }
  record(payload: TranscriptPayload, projection?: RuntimeEvent): Captured {
    let sanitized;
    try { sanitized = this.boundary.scan(payload, true); }
    catch { sanitized = this.boundary.scan<TranscriptPayload>({ kind: "omission", reason: "capture_rejected" }); projection = undefined; }
    const sequence = this.allocateSequence?.() ?? ++this.#sequence;
    const event: TranscriptEvent = {
      schema: "lapis.transcript/1", id: `${this.turn.attemptId}:capture:${sequence}`,
      sessionId: this.thread.nativeSessionId ?? this.thread.id, threadId: this.thread.id,
      turnId: this.turn.id, attemptId: this.turn.attemptId, sequence, at: Date.now(),
      source: { provider: this.thread.provider }, payload: sanitized.value,
      coverage: { ...this.coverage, gaps: [...this.coverage.gaps] }, sanitization: sanitized.summary,
    };
    return { event, ...(projection ? { projection: this.boundary.clean(projection) } : {}) };
  }
  #status(status: string): Captured {
    return { projection: { type: "activity", data: { type: "status", status, pending: true } } };
  }
  #flush(reason?: string): Captured[] {
    const block = this.#block;
    this.#block = undefined;
    if (!block) return [];
    if (reason || block.omitted) return [this.record({ kind: "omission", reason: reason ?? block.omitted!, blockId: block.id })];
    if (!block.text) return [];
    const payload: TranscriptPayload = block.kind === "thinking"
      ? { kind: "thinking", visible: true, blockId: block.id, text: block.text }
      : { kind: "message", role: "assistant", messageId: block.id, text: block.text };
    const captured = this.record(payload);
    const clean = captured.event!.payload;
    if (clean.kind === "message") captured.projection = { type: "text", text: clean.text, messageId: clean.messageId, sourceId: captured.event!.id, complete: true };
    if (clean.kind === "thinking") captured.projection = { type: "activity", data: { type: "thinking", text: clean.text, complete: true, blockId: clean.blockId }, sourceId: captured.event!.id };
    return [captured];
  }
  #append(kind: Block["kind"], text: string, messageId?: string, complete = false): Captured[] {
    const output: Captured[] = [];
    if (this.#block && (this.#block.kind !== kind || messageId && this.#block.messageId && messageId !== this.#block.messageId)) output.push(...this.#flush());
    if (!this.#block) {
      this.#block = { id: `${this.turn.attemptId}:block:${++this.#blockNumber}`, kind, messageId, text: "", bytes: 0 };
      output.push(this.#status(kind === "thinking" ? "Thinking" : "Working"));
    }
    const block = this.#block;
    block.bytes += new TextEncoder().encode(text).byteLength;
    if (block.bytes > textLimit) { block.text = ""; block.omitted = "limit_exceeded"; }
    if (!block.omitted) block.text += text;
    if (complete) output.push(...this.#flush());
    return output;
  }
  #recordUsage(used: number, limit?: number, cost?: number): Captured {
    const payload: TranscriptPayload = { kind: "usage", used, ...(limit !== undefined ? { limit } : {}), ...(cost !== undefined ? { cost } : {}) };
    if (this.#usage?.event) {
      let sanitized;
      try { sanitized = this.boundary.scan(payload, true); }
      catch { return this.#usage; }
      this.#usage = {
        event: {
          ...this.#usage.event,
          at: Date.now(),
          payload: sanitized.value,
          coverage: { ...this.coverage, gaps: [...this.coverage.gaps] },
          sanitization: sanitized.summary,
        },
      };
      return this.#usage;
    }
    const captured = this.record(payload);
    captured.event = { ...captured.event!, id: `${this.turn.attemptId}:usage` };
    this.#usage = captured;
    return captured;
  }
  accept(input: RuntimeEvent): Captured[] {
    if ("sourceId" in input && input.sourceId) {
      if (this.#seen.has(input.sourceId)) return [];
      if (this.#seen.size >= 100_000) return [this.record({ kind: "omission", reason: "event_limit" })];
      this.#seen.add(input.sourceId);
    }
    if (input.type === "text") return this.#append("message", input.text, input.messageId, input.complete);
    if (input.type === "completed" || input.type === "failed") {
      const reason = input.type === "failed" ? "provider_failed" : input.outcome === "cancelled" ? "cancelled" : undefined;
      const output = this.finish(reason);
      if (input.type === "failed") output.push(this.record({ kind: "error", code: input.code }));
      else if (input.outcome === "cancelled") output.push(this.record({ kind: "cancellation", reason: "cancelled" }));
      return output;
    }
    if (input.type !== "activity") return [];
    const data = object(input.data), type = String(data.type ?? "unknown");
    if (data.payloadUnavailable === true) return [{ projection: input }];
    if (["thinking", "reasoning", "reasoning_delta"].includes(type)) return this.#append("thinking", String(data.text ?? data.delta ?? ""), undefined, data.complete === true);
    if (type === "message_complete") return this.#flush();
    const output = ["tool.start", "tool.end", "plan"].includes(type) ? this.#flush() : [];
    if (type === "capture_coverage") {
      this.coverage.mode = "external-acp"; this.coverage.observations = "normalized";
      this.coverage.gaps = ["native-agent-storage", "native-provider-traffic", "unexposed-acp-updates"];
    } else if (type === "usage") {
      const usage = object(data.usage);
      const used = Number(usage.used ?? data.used);
      const limit = Number(usage.limit ?? data.limit);
      const cost = usageCost(usage.cost ?? data.cost);
      if (Number.isFinite(used) && used >= 0)
        output.push(this.#recordUsage(used, Number.isFinite(limit) && limit > 0 ? limit : undefined, cost));
    } else if (type === "tool.start") {
      const id = String(data.id ?? "tool");
      const merged = mergeToolActivity(this.#tools.get(id), data);
      if (this.#tools.size >= 128 || new TextEncoder().encode(JSON.stringify(merged)).byteLength > 4 * 1024 * 1024) {
        output.push(this.record({ kind: "omission", reason: "tool_capture_limit" }));
      } else {
        this.#tools.set(id, merged);
        output.push({ projection: { type: "activity", data: toolStartProjection(snapshotFromToolActivity(merged)) } });
      }
    } else if (type === "tool.end") {
      const id = String(data.id ?? "tool");
      const merged = mergeToolActivity(this.#tools.get(id), data);
      this.#tools.delete(id);
      const snapshot = snapshotFromToolActivity(merged);
      const envelope = (toolDisplayInput(snapshot) ?? {}) as Json;
      output.push(this.record({
        kind: "tool-invocation", invocationId: id, name: snapshot.name || "tool", input: envelope, execution: "observed",
        ...(snapshot.command ? { command: snapshot.command } : {}),
        ...(snapshot.locations ? { locations: merged.locations } : {}),
        ...(snapshot.kind ? { toolKind: snapshot.kind } : {}),
      }));
      output.push(this.record({
        kind: "tool-result", invocationId: id, output: (snapshot.output ?? snapshot.error ?? null) as Json,
        outcome: snapshot.error == null ? "succeeded" : "failed",
        ...(snapshot.content !== undefined ? { content: merged.content } : {}),
      }, { type: "activity", data: toolEndActivity(snapshot), ...(input.sourceId ? { sourceId: input.sourceId } : {}) }));
    } else if (type === "plan" && Array.isArray(data.entries)) {
      const entries = data.entries.map(entry => object(entry)).filter(entry => typeof entry.content === "string" && ["pending", "in_progress", "completed"].includes(String(entry.status))).map(entry => ({ content: String(entry.content), status: entry.status as "pending" | "in_progress" | "completed", ...(["high", "medium", "low"].includes(String(entry.priority)) ? { priority: entry.priority as "high" | "medium" | "low" } : {}) }));
      output.push(this.record({ kind: "plan", entries }, input));
    } else if (/delta|chunk/i.test(type)) {
      output.push(this.record({ kind: "omission", reason: "unsupported_stream_boundary", sourceType: type }));
    }
    return output;
  }
  completeBlock(): Captured[] { return this.#flush(); }
  finish(reason?: string): Captured[] {
    const output = this.#flush(reason);
    for (const _ of this.#tools) output.push(this.record({ kind: "omission", reason: reason ?? "tool_result_unavailable" }));
    this.#tools.clear();
    return output;
  }
}
function object(value: Json | undefined): Record<string, Json> { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
