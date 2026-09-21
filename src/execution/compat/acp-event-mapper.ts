import {
  extractToolCommand,
  firstLocationPath,
  snapshotFromToolActivity,
  toolDisplayInput,
  usageCost,
} from "./tool-snapshot.js";
import {
  DEFAULT_APPROVAL_OPTIONS,
  type AgentEvent,
  type AgentEventSource,
  type AgentUsage,
  type ApprovalKind,
  type ApprovalOption,
  type ApprovalRequest,
} from "./types.js";

export type AcpRuntimeEventLike = {
  type: string;
  text?: string;
  tag?: string;
  used?: number;
  size?: number;
  stream?: "output" | "thought";
  toolCallId?: string;
  title?: string;
  status?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: unknown[];
  content?: unknown[];
  message?: string;
  stopReason?: string;
  cost?: unknown;
  commands?: Array<{
    name?: string;
    description?: string;
    argumentHint?: string;
    hint?: string;
  }>;
  __source?: AgentEventSource;
};

export type AcpPermissionRequestLike = {
  requestId?: string;
  id?: string;
  sessionId?: string;
  title?: string;
  kind?: string;
  inferredKind?: string;
  toolName?: string;
  tool?: { name?: string; input?: unknown };
  input?: unknown;
  raw?: Record<string, unknown>;
  options?: Array<{
    optionId?: string;
    id?: string;
    name?: string;
    label?: string;
    kind?: string;
  }>;
  __source?: AgentEventSource;
  [key: string]: unknown;
};

export type AcpPermissionDecision = {
  outcome:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always"
    | "cancel";
};

export function mapAcpRuntimeEvent(
  event: AcpRuntimeEventLike,
): AgentEvent | null {
  if (event.type === "text_delta") {
    if (event.stream === "thought") {
      return withSource(event, {
        type: "thinking",
        text: event.text ?? "",
        kind: "reasoning",
      });
    }
    return withSource(event, { type: "text", text: event.text ?? "" });
  }
  if (event.type === "available_commands_update") {
    return withSource(event, {
      type: "commands.update",
      commands: nativeCommandsFromAcp(event),
    });
  }
  if (event.type === "status") {
    const usage = usageFromAcpStatus(event);
    if (usage) return withSource(event, { type: "usage", usage });
    if (event.commands) {
      return withSource(event, {
        type: "commands.update",
        commands: nativeCommandsFromAcp(event),
      });
    }
    return withSource(event, {
      type: "status",
      status: event.text ?? event.status ?? "status",
    });
  }
  if (event.type === "tool_call" || event.type === "tool_call_update") {
    const snapshot = snapshotFromToolActivity({
      ...event,
      id: event.toolCallId ?? event.title ?? "acp-tool",
      output: event.rawOutput ?? event.content ?? event.text,
    });
    if (event.status === "completed" || event.status === "failed") {
      return withSource(event, {
        type: "tool.end",
        ...mappedToolFields(snapshot),
        ...(snapshot.output !== undefined ? { output: snapshot.output } : {}),
        ...(event.status === "failed" && snapshot.output !== undefined
          ? { error: snapshot.output }
          : {}),
        ...(snapshot.content !== undefined ? { content: snapshot.content } : {}),
      });
    }
    return withSource(event, {
      type: "tool.start",
      ...mappedToolFields(snapshot),
    });
  }
  if (event.type === "done") {
    return withSource(event, {
      type: "completed",
      result: { stopReason: event.stopReason },
    });
  }
  if (event.type === "error") {
    return withSource(event, {
      type: "error",
      error: new Error(event.message ?? "ACP runtime error"),
    });
  }
  return null;
}

function withSource(
  event: AcpRuntimeEventLike,
  mapped: AgentEvent,
): AgentEvent {
  return event.__source ? { ...mapped, source: { ...event.__source } } : mapped;
}

function usageFromAcpStatus(event: AcpRuntimeEventLike): AgentUsage | null {
  const cost = usageCost(event.cost);
  if (
    event.tag === "usage_update" &&
    isFiniteNonNegative(event.used) &&
    isFinitePositive(event.size)
  ) {
    return {
      used: event.used,
      limit: event.size,
      ...(cost !== undefined ? { cost } : {}),
    };
  }
  const match = event.text?.match(
    /^usage updated:\s*([\d,]+)\s*\/\s*([\d,]+)$/i,
  );
  if (!match) return null;
  const used = Number(match[1]?.replaceAll(",", ""));
  const limit = Number(match[2]?.replaceAll(",", ""));
  return isFiniteNonNegative(used) && isFinitePositive(limit)
    ? { used, limit, ...(cost !== undefined ? { cost } : {}) }
    : null;
}

function nativeCommandsFromAcp(
  event: AcpRuntimeEventLike,
): Array<{ name: string; description?: string; argumentHint?: string }> {
  return (event.commands ?? [])
    .map((command) => ({
      name: (command.name ?? "").trim(),
      description: command.description,
      argumentHint: command.argumentHint ?? command.hint,
    }))
    .filter((command) => command.name.length > 0);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function mapAcpPermissionRequest(
  request: AcpPermissionRequestLike,
): ApprovalRequest {
  const raw = isRecord(request.raw) ? request.raw : {};
  const toolCall = isRecord(raw.toolCall) ? raw.toolCall : {};
  const id = String(
    request.requestId ??
      request.id ??
      toolCall.toolCallId ??
      raw.toolCallId ??
      cryptoRandomId(),
  );
  const options = mapApprovalOptions(
    request.options ??
      (Array.isArray(raw.options)
        ? (raw.options as AcpPermissionRequestLike["options"])
        : undefined),
  );
  const toolName =
    request.tool?.name ??
    request.toolName ??
    stringValue(toolCall.title) ??
    stringValue(toolCall.kind);
  const rawInput = request.tool?.input ?? request.input ?? toolCall.rawInput;
  const locations = Array.isArray(toolCall.locations)
    ? toolCall.locations
    : undefined;
  const command = extractToolCommand(
    rawInput,
    stringValue(toolCall.title) ?? request.title,
  );
  const input = toolDisplayInput({
    input: rawInput,
    command,
    locations,
    kind: stringValue(toolCall.kind),
  });
  const path = firstLocationPath(locations);
  return {
    id,
    origin: "runtime",
    kind: mapApprovalKind(
      request.kind ?? request.inferredKind ?? stringValue(toolCall.kind),
    ),
    title:
      request.title ??
      stringValue(toolCall.title) ??
      (toolName ? `Allow ${toolName}?` : "Allow this agent action?"),
    ...(toolName
      ? {
          tool: {
            name: String(toolName),
            ...(input !== undefined ? { input } : {}),
          },
        }
      : {}),
    ...(path ? { details: { path } } : {}),
    options: options.length > 0 ? options : DEFAULT_APPROVAL_OPTIONS,
  };
}

export function mapApprovalOptionToAcpDecision(
  optionId: string,
): AcpPermissionDecision {
  switch (optionId) {
    case "allow-always":
    case "allow_always":
      return { outcome: "allow_always" };
    case "deny-once":
    case "deny_once":
    case "reject-once":
    case "reject_once":
      return { outcome: "reject_once" };
    case "deny-always":
    case "deny_always":
    case "reject-always":
    case "reject_always":
      return { outcome: "reject_always" };
    case "cancel":
      return { outcome: "cancel" };
    default:
      return { outcome: "allow_once" };
  }
}

function mappedToolFields(snapshot: ReturnType<typeof snapshotFromToolActivity>) {
  const input = toolDisplayInput(snapshot);
  return {
    id: snapshot.id,
    name: snapshot.name,
    ...(snapshot.kind ? { kind: snapshot.kind } : {}),
    ...(snapshot.title ? { title: snapshot.title } : {}),
    ...(snapshot.command ? { command: snapshot.command } : {}),
    ...(snapshot.server ? { server: snapshot.server } : {}),
    ...(snapshot.locations ? { locations: snapshot.locations } : {}),
    ...(input !== undefined ? { input } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapApprovalOptions(
  options: AcpPermissionRequestLike["options"],
): ApprovalOption[] {
  if (!options?.length) return [];
  return options.map((option, index) => {
    const id = String(option.optionId ?? option.id ?? `option-${index}`);
    const kind = normalizeOptionKind(option.kind ?? id);
    return {
      id,
      label: option.label ?? option.name ?? labelForKind(kind),
      kind,
    };
  });
}

function mapApprovalKind(kind: string | undefined): ApprovalKind {
  if (kind === "read" || kind === "search") return "read";
  if (
    kind === "write" ||
    kind === "edit" ||
    kind === "delete" ||
    kind === "move"
  ) {
    return "write";
  }
  if (kind === "execute") return "execute";
  if (kind === "network" || kind === "fetch") return "network";
  return "other";
}

function normalizeOptionKind(value: string): ApprovalOption["kind"] {
  const normalized = value.replaceAll("_", "-");
  if (
    normalized === "allow-once" ||
    normalized === "allow-always" ||
    normalized === "deny-once" ||
    normalized === "deny-always"
  ) {
    return normalized;
  }
  if (normalized.includes("always") && normalized.includes("deny")) {
    return "deny-always";
  }
  if (normalized.includes("always")) return "allow-always";
  if (normalized.includes("deny")) return "deny-once";
  return "allow-once";
}

function labelForKind(kind: ApprovalOption["kind"]): string {
  switch (kind) {
    case "allow-always":
      return "Allow always";
    case "deny-once":
      return "Deny once";
    case "deny-always":
      return "Deny always";
    default:
      return "Allow once";
  }
}

function cryptoRandomId(): string {
  return `acp-${Math.random().toString(36).slice(2, 10)}`;
}
