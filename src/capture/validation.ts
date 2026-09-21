import type { TranscriptEvent } from "../transcript-contracts.js";
import { ControllerError } from "../contracts.js";
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const id = (v: unknown): v is string => text(v) && v.length > 0 && v.length <= 1024;
const ids = (v: unknown): boolean => Array.isArray(v) && v.length <= 10000 && v.every(id);
const path = (v: unknown): boolean => record(v) && ["workspace", "home", "temp", "external"].includes(String(v.kind)) && text(v.display) && typeof v.resolvable === "boolean" && (v.kind !== "workspace" || id(v.workspaceId) && text(v.relativePath));
/** Called after the bounded DTO scanner, including on authorized legacy replay. */
export function assertTranscript(value: unknown): asserts value is TranscriptEvent {
  const fail = () => { throw new ControllerError("transcript_invalid", "Transcript record is invalid"); };
  if (!record(value) || value.schema !== "lapis.transcript/1" || ![value.id, value.sessionId, value.threadId, value.turnId, value.attemptId].every(id) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !Number.isFinite(value.at) || !record(value.source) || !id(value.source.provider) || !record(value.payload) || !record(value.coverage) || !["managed-observable", "external-acp", "cooperative-mark", "jj-only", "legacy"].includes(String(value.coverage.mode)) || !["complete-exposed", "normalized", "partial"].includes(String(value.coverage.observations)) || !ids(value.coverage.gaps) || !record(value.sanitization) || !id(value.sanitization.policy)) return fail();
  const p = value.payload;
  let valid = false;
  switch (p.kind) {
    case "message": valid = ["user", "assistant"].includes(String(p.role)) && text(p.text) && id(p.messageId); break;
    case "thinking": valid = p.visible === true && text(p.text) && id(p.blockId); break;
    case "plan": valid = Array.isArray(p.entries) && p.entries.every(e => record(e) && text(e.content) && ["pending", "in_progress", "completed"].includes(String(e.status))); break;
    case "tool-invocation": valid = id(p.invocationId) && text(p.name) && "input" in p && ["controller", "observed"].includes(String(p.execution)); break;
    case "tool-result": valid = id(p.invocationId) && "output" in p && ["succeeded", "failed", "unknown"].includes(String(p.outcome)); break;
    case "file": valid = ["read", "write", "delete", "rename"].includes(String(p.operation)) && path(p.path); break;
    case "patch": valid = Array.isArray(p.paths) && p.paths.every(path) && text(p.patch); break;
    case "command": valid = id(p.invocationId) && text(p.command); break;
    case "permission": case "input": valid = id(p.interactionId) && "request" in p && text(p.state); break;
    case "usage": valid = Number.isFinite(Number(p.used)) && Number(p.used) >= 0 && (p.limit === undefined || Number.isFinite(Number(p.limit)) && Number(p.limit) > 0) && (p.cost === undefined || Number.isFinite(Number(p.cost)) && Number(p.cost) >= 0); break;
    case "lifecycle": valid = text(p.state); break;
    case "error": valid = text(p.code); break;
    case "cancellation": case "omission": valid = text(p.reason); break;
    case "checkpoint": valid = id(p.checkpointId) && ids(p.commitIds) && ids(p.changeIds); break;
    case "compaction": valid = ids(p.coveredEventIds) && text(p.summary); break;
    case "subagent": valid = id(p.childSessionId) && id(p.initiatingToolId) && text(p.state); break;
    case "extension": valid = id(p.sourceType) && "data" in p; break;
  }
  if (!valid) fail();
}
