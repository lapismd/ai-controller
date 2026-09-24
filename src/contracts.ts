/** Browser-safe, versioned controller contracts. No server or consumer imports. */
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
export interface TurnInput {
  threadId: string;
  commandId: string;
  text: string;
  parts?: ContentPart[];
  externalRef?: string;
}
export interface Turn {
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

export { assertTranscript } from "./capture/validation.js";
