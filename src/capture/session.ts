import type { Json, Thread, Turn } from "../contracts.js";
import type { RuntimeEvent } from "../domain/ports.js";
import type { CaptureCoverage, TranscriptEvent, TranscriptPayload } from "../transcript-contracts.js";
import { CaptureBoundary } from "./boundary.js";

export interface Captured { event: TranscriptEvent; projection?: RuntimeEvent }
type Block = { id: string; messageId?: string; kind: "message" | "thinking"; text: string; bytes: number; omitted?: string };
const textLimit = 2 * 1024 * 1024;

/** Transport chunks remain volatile. Only complete, scanned logical records leave. */
export class CaptureSession {
  #sequence = 0;
  #block?: Block;
  #blockNumber = 0;
  #tools = new Map<string, Record<string, Json>>();
  #seen = new Set<string>();
  readonly coverage: CaptureCoverage;
  constructor(readonly thread: Thread, readonly turn: Turn, readonly boundary: CaptureBoundary, readonly allocateSequence?: () => number) {
    this.coverage = { mode: "managed-observable", observations: "complete-exposed", gaps: ["external-provider-traffic", "external-native-session-files"] };
  }
  record(payload: TranscriptPayload, projection?: RuntimeEvent): Captured {
    let sanitized;
    try { sanitized = this.boundary.scan(payload); }
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
    const clean = captured.event.payload;
    if (clean.kind === "message") captured.projection = { type: "text", text: clean.text, messageId: clean.messageId, sourceId: captured.event.id, complete: true };
    if (clean.kind === "thinking") captured.projection = { type: "activity", data: { type: "thinking", text: clean.text, complete: true, blockId: clean.blockId }, sourceId: captured.event.id };
    return [captured];
  }
  #append(kind: Block["kind"], text: string, messageId?: string, complete = false): Captured[] {
    const output: Captured[] = [];
    if (this.#block && (this.#block.kind !== kind || messageId && this.#block.messageId && messageId !== this.#block.messageId)) output.push(...this.#flush());
    if (!this.#block) {
      this.#block = { id: `${this.turn.attemptId}:block:${++this.#blockNumber}`, kind, messageId, text: "", bytes: 0 };
      output.push(this.record({ kind: "lifecycle", state: kind === "thinking" ? "thinking" : "working" }, { type: "activity", data: { type: "status", status: kind === "thinking" ? "Thinking" : "Working", pending: true } }));
    }
    const block = this.#block;
    block.bytes += new TextEncoder().encode(text).byteLength;
    if (block.bytes > textLimit) { block.text = ""; block.omitted = "limit_exceeded"; }
    if (!block.omitted) block.text += text;
    if (complete) output.push(...this.#flush());
    return output;
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
      output.push(this.record(input.type === "failed" ? { kind: "error", code: input.code } : input.outcome === "cancelled" ? { kind: "cancellation", reason: "cancelled" } : { kind: "lifecycle", state: "completed" }));
      return output;
    }
    if (input.type !== "activity") return [];
    const data = object(input.data), type = String(data.type ?? "unknown");
    if (["thinking", "reasoning", "reasoning_delta"].includes(type)) return this.#append("thinking", String(data.text ?? data.delta ?? ""), undefined, data.complete === true);
    if (type === "message_complete") return this.#flush();
    const output = ["tool.start", "tool.end", "plan", "subagent"].includes(type) ? this.#flush() : [];
    if (type === "capture_coverage") {
      this.coverage.mode = "external-acp"; this.coverage.observations = "normalized";
      this.coverage.gaps = ["native-agent-storage", "native-provider-traffic", "unexposed-acp-updates"];
      output.push(this.record({ kind: "lifecycle", state: "capture_coverage", details: input.data }));
    } else if (type === "tool.start") {
      const id = String(data.id ?? "tool");
      if (this.#tools.size >= 128 || new TextEncoder().encode(JSON.stringify(data)).byteLength > 4 * 1024 * 1024) {
        output.push(this.record({ kind: "omission", reason: "tool_capture_limit" }));
      } else {
        this.#tools.set(id, data);
        output.push(this.record({ kind: "lifecycle", state: "tool_running" }, { type: "activity", data: { type: "status", status: "Tool running", pending: true } }));
      }
    } else if (type === "tool.end") {
      const id = String(data.id ?? "tool"), previous = this.#tools.get(id);
      this.#tools.delete(id);
      const name = String(data.name ?? previous?.name ?? "tool");
      output.push(this.record({ kind: "tool-invocation", invocationId: id, name, input: data.input ?? previous?.input ?? null, execution: "observed" }));
      output.push(this.record({ kind: "tool-result", invocationId: id, output: data.output ?? data.error ?? null, outcome: data.error == null ? "succeeded" : "failed" }, input));
      if (data.observation) output.push(this.record({ kind: "extension", sourceType: "acp.tool", data: data.observation }));
    } else if (type === "plan" && Array.isArray(data.entries)) {
      const entries = data.entries.map(entry => object(entry)).filter(entry => typeof entry.content === "string" && ["pending", "in_progress", "completed"].includes(String(entry.status))).map(entry => ({ content: String(entry.content), status: entry.status as "pending" | "in_progress" | "completed", ...(["high", "medium", "low"].includes(String(entry.priority)) ? { priority: entry.priority as "high" | "medium" | "low" } : {}) }));
      output.push(this.record({ kind: "plan", entries }, input));
    } else if (type === "subagent" && typeof data.childSessionId === "string" && typeof data.initiatingToolId === "string") {
      output.push(this.record({ kind: "subagent", childSessionId: data.childSessionId, initiatingToolId: data.initiatingToolId, state: String(data.state ?? "observed") }, input));
    } else if (["file.changed", "file.read", "file.write", "file.delete", "file.rename"].includes(type) && typeof data.path === "string") {
      try { output.push(this.record({ kind: "file", operation: type === "file.changed" ? "write" : type.slice(5) as "read" | "write" | "delete" | "rename", path: this.boundary.path(data.path), details: data })); }
      catch { output.push(this.record({ kind: "omission", reason: "path_capture_rejected" })); }
    } else if (type === "patch" && Array.isArray(data.paths) && typeof data.patch === "string") {
      try { output.push(this.record({ kind: "patch", paths: data.paths.map(path => this.boundary.path(String(path))), patch: data.patch })); }
      catch { output.push(this.record({ kind: "omission", reason: "path_capture_rejected" })); }
    } else if (type === "command.end" && typeof data.command === "string") {
      output.push(this.record({ kind: "command", invocationId: String(data.id ?? `${this.turn.attemptId}:command:${++this.#blockNumber}`), command: data.command, ...(typeof data.output === "string" ? { output: data.output } : {}), ...(typeof data.exitCode === "number" ? { exitCode: data.exitCode } : {}) }));
    } else if (type === "compaction" && Array.isArray(data.coveredEventIds) && typeof data.summary === "string") {
      output.push(this.record({ kind: "compaction", coveredEventIds: data.coveredEventIds.filter((id): id is string => typeof id === "string"), summary: data.summary, ...(typeof data.checkpointId === "string" ? { checkpointId: data.checkpointId } : {}) }));
    } else if (type === "checkpoint" && typeof data.checkpointId === "string" && Array.isArray(data.commitIds) && Array.isArray(data.changeIds)) {
      output.push(this.record({ kind: "checkpoint", checkpointId: data.checkpointId, commitIds: data.commitIds.filter((id): id is string => typeof id === "string"), changeIds: data.changeIds.filter((id): id is string => typeof id === "string") }));
    } else if (/delta|chunk/i.test(type)) {
      output.push(this.record({ kind: "omission", reason: "unsupported_stream_boundary", sourceType: type }));
    } else {
      output.push(this.record({ kind: "extension", sourceType: type, data: input.data }, input));
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
