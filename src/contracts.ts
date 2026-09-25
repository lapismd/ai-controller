/** Browser-safe, versioned controller contracts. No server or consumer imports. */
import type { TranscriptEvent } from "./transcript-contracts.js";
export type { ExecutionPolicy, NativePermissionMode } from "./policy-contracts.js";
export type { TranscriptEvent, TranscriptPayload, TranscriptAcknowledgment, TranscriptPage, CaptureCoverage, LogicalPath, SanitizationSummary } from "./transcript-contracts.js";
export const PROTOCOL = "lapis-ai-controller/1";
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type PayloadPolicy = "durable" | "metadata-only";
export type TurnState =
  | "queued"
  | "preparing"
  | "prepared"
  | "dispatching"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "submission-unknown"
  | "interrupted";
export const TERMINAL_STATES: readonly TurnState[] = [
  "completed",
  "failed",
  "cancelled",
  "submission-unknown",
  "interrupted",
];
export type ApprovalPolicy = "ask" | "allow-all";
export type ProviderConfig = {
  approvalPolicy?: ApprovalPolicy;
  vcsIdentity?: { name: string; email: string };
  restricted?: boolean;
  model?: string;
  thinking?: string; permissionMode?: string;
  agent?: string;
  options?: Record<string, Json>;
};
export interface ThreadInput {
  id?: string;
  provider: string;
  workspace: string;
  externalRef?: string;
  payloadPolicy?: PayloadPolicy;
  configuration?: ProviderConfig;
  contextSources?: string[];
  toolEndpoint?: string;
  memoryEndpoint?: string;
  mcpEndpoint?: string;
  transcriptEndpoint?: string;
}
export interface Thread extends ThreadInput {
  id: string;
  owner: string;
  application?: string;
  payloadPolicy: PayloadPolicy;
  version: number;
  createdAt: number;
  nativeSessionId?: string;
  capturePolicy?: string;
}
export interface ContentPart {
  type: "text" | "resource" | "image";
  text?: string;
  uri?: string;
  mimeType?: string;
}
export interface ContinueInput {
  turnId: string;
  commandId: string;
  text: string;
}
export interface TurnInput {
  continuedFrom?: string;
  threadId: string;
  commandId: string;
  text: string;
  parts?: ContentPart[];
  externalRef?: string;
}
export interface Turn {
  executionPolicy?: import("./policy-contracts.js").ExecutionPolicy;
  continuedFrom?: string;
  id: string;
  threadId: string;
  commandId: string;
  attemptId: string;
  state: TurnState;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  text?: string;
  parts?: ContentPart[];
  output?: string;
  externalRef?: string;
  error?: string;
}
export interface Receipt {
  commandId: string;
  threadId: string;
  turnId: string;
  acceptedAt: number;
  durability: PayloadPolicy;
}
export interface ControllerEvent {
  id: string;
  cursor: string;
  threadId: string;
  turnId?: string;
  type: string;
  at: number;
  data: Json;
}
export interface Snapshot {
  thread: Thread;
  turns: Turn[];
  interactions: Interaction[];
  cursor: string;
  transcript: ControllerEvent[];
  transcriptTruncated: boolean;
}
export interface ContextBlock {
  id: string;
  revision: string;
  kind: "instructions" | "handoff" | "memory" | "application";
  content: string;
  trust: "instructions" | "reference";
  required?: boolean;
  sourceId?: string;
}
export interface Preparation {
  version: number;
  text: string;
  blocks: ContextBlock[];
  omitted: string[];
  configuration: ProviderConfig;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, Json>;
  effect: "read" | "idempotent" | "reconcilable" | "write";
}
export interface ToolCall {
  id: string;
  threadId: string;
  turnId: string;
  name: string;
  arguments: Json;
  deadline: number;
}
export interface ToolResult {
  content: Json;
  isError?: boolean;
}
export interface Interaction {
  id: string;
  threadId: string;
  turnId: string;
  kind: "approval" | "input" | "tool";
  state: "pending" | "resolved" | "expired" | "cancelled" | "unknown";
  nativeId: string;
  request: Json;
  response?: Json;
  resolution?: "automatic" | "owner";
  deadline: number;
}
export interface Capabilities {
  externalMcp?: boolean;
  driver: string;
  content: ContentPart["type"][];
  configuration: boolean;
  resume: "none" | "context" | "history" | "active";
  approvals: boolean;
  approvalFeatures?: {
    persistentDecisions: boolean;
    granularPermissions: boolean;
    policyAmendments: boolean;
  };
  input: boolean;
  tools: boolean;
}
export const CONTROLLER_SCOPES = [
  "threads:read",
  "threads:operate",
  "memory:read",
  "memory:write",
  "tools:provide",
  "providers:read",
  "providers:configure",
  "admin",
] as const;
export type ControllerScope = (typeof CONTROLLER_SCOPES)[number];
export interface Principal {
  id: string;
  applicationId?: string;
  providers: string[];
  workspaces: string[];
  scopes?: ControllerScope[];
}
export interface AuthSession {
  id: string;
  principalId: string;
  applicationId: string;
  scopes: ControllerScope[];
  providers: string[];
  workspaces: string[];
  createdAt: number;
  expiresAt: number;
}
export interface MemoryAccess {
  principalId: string;
  applicationId: string;
  workspaceId: string;
  threadId: string;
}
export interface EndpointRequest {
  id: string;
  endpoint: string;
  operation: string;
  payload: Json;
  deadline: number;
}
export interface RemoteError {
  code: string;
  message: string;
}
export class ControllerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ControllerError";
  }
}
export function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ControllerError("invalid_input", "Expected an object");
}
export function requiredString(
  value: unknown,
  label: string,
  maximum = 512,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new ControllerError("invalid_input", `Invalid ${label}`);
  return value;
}
export function isTerminal(state: TurnState): boolean {
  return TERMINAL_STATES.includes(state);
}

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
