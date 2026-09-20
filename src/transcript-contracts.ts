import type { Json } from "./contracts.js";
export type { LogicalPath, SanitizationSummary } from "@lapismd/agent-redaction";
import type { LogicalPath, SanitizationSummary } from "@lapismd/agent-redaction";

export interface CaptureCoverage {
  mode: "managed-observable" | "external-acp" | "cooperative-mark" | "jj-only" | "legacy";
  observations: "complete-exposed" | "normalized" | "partial";
  gaps: string[];
}
export type TranscriptPayload =
  | { kind: "message"; role: "user" | "assistant"; text: string; messageId: string }
  | { kind: "thinking"; text: string; visible: true; blockId: string }
  | { kind: "plan"; entries: Array<{ content: string; status: "pending" | "in_progress" | "completed"; priority?: "high" | "medium" | "low" }> }
  | { kind: "tool-invocation"; invocationId: string; name: string; input: Json; execution: "observed" | "controller" }
  | { kind: "tool-result"; invocationId: string; output: Json; outcome: "succeeded" | "failed" | "unknown" }
  | { kind: "file"; operation: "read" | "write" | "delete" | "rename"; path: LogicalPath; details?: Json }
  | { kind: "patch"; paths: LogicalPath[]; patch: string }
  | { kind: "command"; invocationId: string; command: string; output?: string; exitCode?: number }
  | { kind: "permission" | "input"; interactionId: string; request: Json; response?: Json; state: string }
  | { kind: "lifecycle"; state: string; details?: Json }
  | { kind: "error"; code: string; message?: string }
  | { kind: "cancellation"; reason: string }
  | { kind: "checkpoint"; checkpointId: string; commitIds: string[]; changeIds: string[] }
  | { kind: "compaction"; coveredEventIds: string[]; checkpointId?: string; summary: string }
  | { kind: "subagent"; childSessionId: string; initiatingToolId: string; state: string }
  | { kind: "extension"; sourceType: string; data: Json }
  | { kind: "omission"; reason: string; sourceType?: string; blockId?: string };

export interface TranscriptEvent {
  schema: "lapis.transcript/1";
  id: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  attemptId: string;
  sequence: number;
  at: number;
  source: { provider: string; eventId?: string; parentSessionId?: string; initiatingToolId?: string };
  payload: TranscriptPayload;
  coverage: CaptureCoverage;
  sanitization: SanitizationSummary;
}
export interface TranscriptAcknowledgment { eventId: string; sequence: number; durable: true }
export interface TranscriptPage { events: TranscriptEvent[]; nextSequence?: number; complete: boolean }
