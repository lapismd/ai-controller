import {
  DEFAULT_APPROVAL_OPTIONS,
  type AgentEvent,
  type ApprovalKind,
  type ApprovalRequest,
  type UserInputAnswers,
  type UserInputRequest,
} from "./types.js";

export type AppServerMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string } | unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function streamedText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  for (const key of ["text", "delta", "content", "message", "value"]) {
    const candidate = record[key];
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function isToolItem(item: Record<string, unknown>): boolean {
  return [
    "mcpToolCall",
    "dynamicToolCall",
    "commandExecution",
    "fileChange",
  ].includes(String(item.type ?? ""));
}

function toolName(item: Record<string, unknown>): string {
  if (item.type === "commandExecution") return "command";
  if (item.type === "fileChange") return "file change";
  return String(item.tool ?? item.command ?? item.type ?? "tool");
}

function toolInput(item: Record<string, unknown>): unknown {
  return item.command ?? item.arguments ?? item.input ?? item.changes;
}

export function mapCodexNotification(
  message: AppServerMessage,
): AgentEvent | null {
  const params = asRecord(message.params);
  const item = asRecord(params.item);
  const method = message.method ?? "";

  if (
    method === "item/agentMessage/delta" ||
    method === "turn/agentMessage/delta"
  ) {
    const text = streamedText(params.delta ?? params.text);
    return text ? { type: "text", text } : null;
  }
  if (
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/delta" ||
    method === "turn/reasoning/delta"
  ) {
    const text = streamedText(params.delta ?? params.text);
    return text ? { type: "thinking", text, kind: "reasoning" } : null;
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const text = streamedText(params.delta ?? params.text);
    return text ? { type: "thinking", text, kind: "summary" } : null;
  }
  if (method === "item/plan/delta") {
    const text = streamedText(params.delta ?? params.text);
    return text ? { type: "thinking", text, kind: "plan" } : null;
  }
  if (method === "thread/tokenUsage/updated") {
    const tokenUsage = asRecord(params.tokenUsage);
    const total = asRecord(tokenUsage.total);
    const used = numberValue(total.totalTokens);
    const limit = numberValue(tokenUsage.modelContextWindow);
    return used !== undefined && used >= 0 && limit !== undefined && limit > 0
      ? { type: "usage", usage: { used, limit } }
      : null;
  }
  if (method === "item/started" || method === "item/toolCall/started") {
    if (!isToolItem(item) && method !== "item/toolCall/started") return null;
    return {
      type: "tool.start",
      id: String(item.id ?? params.itemId ?? "codex-tool"),
      name: toolName(item),
      server: stringValue(item.server),
      input: toolInput(item),
    };
  }
  if (method === "item/completed") {
    if (isToolItem(item)) {
      return {
        type: "tool.end",
        id: String(item.id ?? params.itemId ?? "codex-tool"),
        name: toolName(item),
        server: stringValue(item.server),
        output:
          item.result ??
          item.aggregatedOutput ??
          item.contentItems ??
          item.output,
        error: item.error,
      };
    }
    return null;
  }
  if (method === "turn/completed") {
    const turn = asRecord(params.turn);
    if (turn.status === "failed") {
      const error = asRecord(turn.error);
      return {
        type: "error",
        error: new Error(stringValue(error.message) ?? "Codex turn failed"),
      };
    }
    return { type: "completed", result: params };
  }
  if (
    method === "warning" ||
    method === "guardianWarning" ||
    method === "configWarning" ||
    method === "deprecationNotice"
  ) {
    return {
      type: "status",
      status: String(params.message ?? params.warning ?? "Codex warning"),
    };
  }
  if (method === "error" || message.error) {
    const record = asRecord(message.error);
    const paramsError = asRecord(params.error);
    return {
      type: "error",
      error: new Error(
        stringValue(record.message) ??
          stringValue(params.message) ??
          stringValue(paramsError.message) ??
          "Codex app-server error",
      ),
    };
  }
  return null;
}

export function approvalRequestFromServerRequest(
  message: AppServerMessage,
): ApprovalRequest | null {
  if (message.id === undefined || !message.method) return null;
  const request = asRecord(message.params);
  const method = message.method;
  if (method === "mcpServer/elicitation/request") {
    const schema = asRecord(request.requestedSchema);
    if (
      request.mode !== "form" ||
      schema.type !== "object" ||
      !schema.properties ||
      Object.keys(asRecord(schema.properties)).length > 0 ||
      (Array.isArray(schema.required) && schema.required.length > 0)
    )
      return null;
    return {
      id: String(message.id),
      origin: "runtime",
      kind: "other",
      title: stringValue(request.message) ?? "Allow this MCP action?",
      options: DEFAULT_APPROVAL_OPTIONS.filter(
        (option) => option.id === "allow-once" || option.id === "deny-once",
      ),
    };
  }
  if (
    ![
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "applyPatchApproval",
      "execCommandApproval",
    ].includes(method)
  ) {
    return null;
  }
  const kind = mapCodexApprovalKind(
    method.includes("command") || method === "execCommandApproval"
      ? "command"
      : method.includes("file") || method === "applyPatchApproval"
        ? "file_change"
        : "permissions",
  );
  return {
    id: String(message.id),
    origin: "runtime",
    kind,
    title:
      stringValue(request.reason) ??
      stringValue(request.header) ??
      "Allow this Codex action?",
    tool: request.command
      ? { name: "command", input: request.command }
      : undefined,
    options: DEFAULT_APPROVAL_OPTIONS,
  };
}

export function userInputRequestFromServerRequest(
  message: AppServerMessage,
): UserInputRequest | null {
  if (
    message.id === undefined ||
    message.method !== "item/tool/requestUserInput"
  ) {
    return null;
  }
  const params = asRecord(message.params);
  const questions = Array.isArray(params.questions)
    ? params.questions.flatMap((value, questionIndex) => {
        const question = asRecord(value);
        const id = stringValue(question.id);
        const prompt = stringValue(question.question);
        if (!id || !prompt) return [];
        const rawOptions = Array.isArray(question.options)
          ? question.options
          : [];
        const options = rawOptions.flatMap((optionValue, optionIndex) => {
          const option = asRecord(optionValue);
          const label = stringValue(option.label);
          if (!label) return [];
          return [
            {
              id: `${id}-option-${optionIndex + 1}`,
              label,
              description: stringValue(option.description),
            },
          ];
        });
        return [
          {
            id,
            header:
              stringValue(question.header) ?? `Question ${questionIndex + 1}`,
            prompt,
            options: options.length > 0 ? options : undefined,
            allowOther: question.isOther === true,
            secret: question.isSecret === true,
          },
        ];
      })
    : [];
  if (questions.length === 0) return null;
  return {
    id: String(message.id),
    title: "Agent needs input",
    questions,
  };
}

export function userInputReplyForServerRequest(
  message: AppServerMessage,
  answers: UserInputAnswers,
): {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
} {
  if (message.method !== "item/tool/requestUserInput") {
    return { error: { code: -32601, message: "Unsupported input request" } };
  }
  return {
    result: {
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, values]) => [
          id,
          { answers: [...values] },
        ]),
      ),
    },
  };
}

export function approvalResponseForOption(
  optionId: string,
): Record<string, unknown> {
  if (optionId === "allow-always") return { decision: "acceptForSession" };
  if (optionId === "deny-once" || optionId === "deny-always") {
    return { decision: "decline" };
  }
  return { decision: "accept" };
}

export function approvalReplyForServerRequest(
  message: AppServerMessage,
  optionId: string,
): {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
} {
  if (message.method === "mcpServer/elicitation/request") {
    if (optionId !== "allow-once" && optionId !== "deny-once")
      throw new Error("Unsupported MCP approval decision");
    return {
      result:
        optionId === "allow-once"
          ? { action: "accept", content: {} }
          : { action: "decline" },
    };
  }
  if (message.method === "item/permissions/requestApproval") {
    if (optionId.startsWith("deny")) {
      return {
        error: { code: -32000, message: "Permission request declined" },
      };
    }
    const params = asRecord(message.params);
    return {
      result: {
        permissions: params.permissions ?? {},
        scope: optionId === "allow-always" ? "session" : "turn",
      },
    };
  }
  if (
    message.method === "applyPatchApproval" ||
    message.method === "execCommandApproval"
  ) {
    return {
      result: {
        decision: optionId.startsWith("deny") ? "denied" : "approved",
      },
    };
  }
  return { result: approvalResponseForOption(optionId) };
}

function mapCodexApprovalKind(kind: string | undefined): ApprovalKind {
  if (kind === "command" || kind === "execute") return "execute";
  if (kind === "file_change" || kind === "apply_patch" || kind === "write") {
    return "write";
  }
  if (kind === "permissions" || kind === "network") return "network";
  if (kind === "read") return "read";
  return "other";
}
