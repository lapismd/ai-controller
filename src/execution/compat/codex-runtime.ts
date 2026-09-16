import { ControllerError } from "../../contracts.js";
import { AsyncEventQueue } from "./event-queue.js";
import {
  NATIVE_CODEX_APPROVAL_CAPABILITIES,
  type AgentCapabilities,
  type AgentEvent,
  type AgentRequest,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionConfiguration,
  type AgentSessionConfigurationResult,
  type AgentTurnOptions,
  type AiThinkingLevel,
  type McpServerContribution,
  type UserInputAnswers,
  projectAgentTurnPrompt,
} from "./types.js";
import type { AgentProcessHandle, AgentProcessHost } from "./process-host.js";
import {
  approvalReplyForServerRequest,
  approvalRequestFromServerRequest,
  mapCodexNotification,
  userInputReplyForServerRequest,
  userInputRequestFromServerRequest,
  type AppServerMessage,
} from "./app-server-protocol.js";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type CodexThreadResponse = {
  thread?: { id?: string; sessionId?: string };
};

type CodexTurnResponse = {
  turn?: { id?: string };
};

export class CodexNativeSession implements AgentSession {
  readonly #process: AgentProcessHandle;
  #request: Omit<AgentRequest, "prompt">;
  readonly #events = new AsyncEventQueue<AgentEvent>();
  readonly #pending = new Map<string | number, PendingRequest>();
  readonly #pendingServerRequests = new Map<string, AppServerMessage>();
  #buffer = "";
  #rpcId = 1;
  #threadId: string | null = null;
  #activeTurnId: string | null = null;
  #closed = false;
  #consume: Promise<void>;

  constructor(
    process: AgentProcessHandle,
    request: Omit<AgentRequest, "prompt">,
  ) {
    this.#process = process;
    this.#request = request;
    this.#consume = this.#pump();
  }

  get id(): string {
    return this.#threadId ?? `codex-${this.#process.id}`;
  }

  async initialize(resumeThreadId?: string): Promise<void> {
    await this.#requestRpc("initialize", {
      clientInfo: {
        name: "lapis_notes_ai",
        title: "Lapis Notes AI",
        version: "0.0.1",
      },
      capabilities: { experimentalApi: true },
    });
    await this.#notify("initialized", {});
    const workspace = this.#request.workspace;
    const common = {
      model: this.#request.model?.model ?? null,
      cwd: workspace ?? null,
      runtimeWorkspaceRoots: workspace ? [workspace] : null,
      approvalPolicy: this.#request.restricted ? "never" : "on-request",
      sandbox: "read-only",
    };
    const response = (await this.#requestRpc(
      resumeThreadId ? "thread/resume" : "thread/start",
      resumeThreadId
        ? { threadId: resumeThreadId, ...common }
        : { ...common, ephemeral: false },
    )) as CodexThreadResponse;
    const threadId = response.thread?.id ?? resumeThreadId;
    if (!threadId) throw new Error("Codex did not return a thread id.");
    this.#threadId = threadId;
  }

  events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }

  async send(input: string, options?: AgentTurnOptions): Promise<void> {
    if (!this.#threadId) throw new Error("Codex session has not initialized.");
    const response = (await this.#requestRpc("turn/start", {
      threadId: this.#threadId,
      input: [
        {
          type: "text",
          text: projectAgentTurnPrompt(input, options?.contextBlocks),
          text_elements: [],
        },
      ],
      ...(this.#request.workspace
        ? {
            cwd: this.#request.workspace,
            runtimeWorkspaceRoots: [this.#request.workspace],
          }
        : {}),
      approvalPolicy: this.#request.restricted ? "never" : "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(this.#request.model?.model
        ? { model: this.#request.model.model }
        : {}),
      ...(thinkingEffort(this.#request.thinking)
        ? { effort: thinkingEffort(this.#request.thinking) }
        : {}),
    })) as CodexTurnResponse;
    this.#activeTurnId = response.turn?.id ?? this.#activeTurnId;
  }

  async configure(
    input: AgentSessionConfiguration,
  ): Promise<AgentSessionConfigurationResult> {
    this.#request = {
      ...this.#request,
      ...(input.model ? { model: { ...input.model } } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
    };
    return {
      ...(input.model ? { model: { status: "applied" as const } } : {}),
      ...(input.thinking ? { thinking: { status: "applied" as const } } : {}),
    };
  }

  async respondToApproval(requestId: string, optionId: string): Promise<void> {
    const pending = this.#pendingServerRequests.get(requestId);
    if (!pending)
      throw new Error(`Unknown Codex approval request: ${requestId}`);
    this.#pendingServerRequests.delete(requestId);
    const reply = approvalReplyForServerRequest(pending, optionId);
    await this.#write({ id: pending.id, ...reply });
  }

  async respondToQuestion(
    requestId: string,
    answers: UserInputAnswers,
  ): Promise<void> {
    const pending = this.#pendingServerRequests.get(requestId);
    if (!pending || pending.method !== "item/tool/requestUserInput") {
      throw new Error(`Unknown Codex user-input request: ${requestId}`);
    }
    this.#pendingServerRequests.delete(requestId);
    const reply = userInputReplyForServerRequest(pending, answers);
    await this.#write({ id: pending.id, ...reply });
  }

  async cancel(): Promise<void> {
    if (!this.#threadId) return;
    try {
      await this.#requestRpc("turn/interrupt", {
        threadId: this.#threadId,
        turnId: this.#activeTurnId ?? undefined,
      });
    } catch {
      // Cancellation is intentionally idempotent for the UI.
    }
    this.#events.push({ type: "status", status: "cancelled" });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new Error("Codex session closed."));
    this.#pendingServerRequests.clear();
    await this.#process.kill();
    await this.#consume;
    this.#events.close();
  }

  async #pump(): Promise<void> {
    try {
      for await (const message of this.#process.messages()) {
        if (message.type === "stderr") continue;
        if (message.type === "exit") {
          if (!this.#closed) {
            const error = new Error(
              `Codex app-server exited with code ${message.exitCode}.`,
            );
            this.#events.push({ type: "error", error });
            this.#rejectAll(error);
          }
          break;
        }
        this.#buffer += message.data;
        const lines = this.#buffer.split("\n");
        this.#buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) this.#handleLine(line);
        }
      }
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#events.push({ type: "error", error: normalized });
      this.#rejectAll(normalized);
    } finally {
      if (!this.#closed) this.#events.close();
    }
  }

  #handleLine(line: string): void {
    let parsed: AppServerMessage;
    try {
      parsed = JSON.parse(line) as AppServerMessage;
    } catch {
      this.#events.push({
        type: "error",
        error: new Error("Codex app-server returned invalid JSONL."),
      });
      return;
    }
    if (parsed.id !== undefined && !parsed.method) {
      const pending = this.#pending.get(parsed.id);
      if (!pending) return;
      this.#pending.delete(parsed.id);
      if (parsed.error) {
        const error = parsed.error as { message?: unknown };
        pending.reject(
          new Error(String(error.message ?? "Codex request failed")),
        );
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }
    const approval = approvalRequestFromServerRequest(parsed);
    if (approval && parsed.id !== undefined) {
      this.#pendingServerRequests.set(approval.id, parsed);
      this.#events.push({ type: "permission.request", request: approval });
      return;
    }
    const question = userInputRequestFromServerRequest(parsed);
    if (question && parsed.id !== undefined) {
      this.#pendingServerRequests.set(question.id, parsed);
      this.#events.push({ type: "question.request", request: question });
      return;
    }
    if (parsed.id !== undefined && parsed.method) {
      this.#events.push({
        type: "status",
        status: "unsupported_provider_request",
      });
      void this.#write({
        id: parsed.id,
        error: { code: -32601, message: "Unsupported provider request" },
      }).catch(() => {
        this.#events.push({
          type: "error",
          error: new Error("Provider response delivery failed"),
        });
      });
      return;
    }
    const event = mapCodexNotification(parsed);
    if (!event) return;
    if (event.type === "completed" || event.type === "error") {
      this.#activeTurnId = null;
    }
    this.#events.push(event);
  }

  async #requestRpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const id = this.#rpcId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex ${method} request timed out.`));
      }, 15_000);
      this.#pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    try {
      await this.#write({ id, method, params });
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.#pending.get(id)?.reject(normalized);
      this.#pending.delete(id);
      return result;
    }
    return result;
  }

  async #notify(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.#write({ method, params });
  }

  async #write(message: AppServerMessage): Promise<void> {
    await this.#process.write(`${JSON.stringify(message)}\n`);
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}

export class CodexNativeRuntime implements AgentRuntime {
  readonly id = "codex-native";
  readonly #host: AgentProcessHost;

  constructor(host: AgentProcessHost) {
    this.#host = host;
  }

  capabilities(): AgentCapabilities {
    return {
      sessions: true,
      resume: true,
      cancel: true,
      steer: false,
      modelSelection: true,
      nativeTools: true,
      mcpTools: true,
      approvals: NATIVE_CODEX_APPROVAL_CAPABILITIES,
    };
  }

  async supports(request: AgentRequest): Promise<boolean> {
    return this.#host.available && request.agent !== "cursor";
  }

  async start(request: AgentRequest): Promise<AgentSession> {
    return this.#open(request);
  }

  async resume(
    sessionId: string,
    request: Omit<AgentRequest, "prompt"> = {},
  ): Promise<AgentSession> {
    return this.#open({ ...request, prompt: "" }, sessionId);
  }

  async #open(
    request: AgentRequest,
    resumeThreadId?: string,
  ): Promise<AgentSession> {
    const process = await this.#host.spawn({
      command: "codex",
      args: codexArgsFor(request.mcpServers),
      env: codexEnvironmentFor(request.mcpServers),
      cwd: request.workspace,
      appToolBridgeId: request.appToolSession?.bridgeId,
    });
    const session = new CodexNativeSession(process, request);
    try {
      await session.initialize(resumeThreadId);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}

function thinkingEffort(
  thinking: AiThinkingLevel | undefined,
): "none" | "low" | "medium" | "high" | undefined {
  return thinking === "off" ? "none" : thinking;
}

function codexArgsFor(
  mcpServers: McpServerContribution[] | undefined,
): string[] {
  const args = ["app-server", "--stdio"];
  for (const server of mcpServers ?? []) {
    const prefix = `mcp_servers.${server.name}`;
    args.push("-c", `${prefix}.command=${JSON.stringify(server.command)}`);
    args.push("-c", `${prefix}.required=true`);
    if (server.env) {
      args.push(
        "-c",
        `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
      );
    }
    if (server.args) {
      args.push("-c", `${prefix}.args=${JSON.stringify(server.args)}`);
    }
    if (server.cwd) {
      args.push("-c", `${prefix}.cwd=${JSON.stringify(server.cwd)}`);
    }
    if (server.enabledTools) {
      args.push(
        "-c",
        `${prefix}.enabled_tools=${JSON.stringify(server.enabledTools)}`,
      );
    }
  }
  return args;
}

function codexEnvironmentFor(
  servers: McpServerContribution[] | undefined,
): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  for (const server of servers ?? []) {
    for (const [name, value] of Object.entries(server.env ?? {})) {
      if (
        name.startsWith("LAPIS_TOOL_BRIDGE_") ||
        (Object.hasOwn(env, name) && env[name] !== value)
      ) {
        throw new ControllerError(
          "unsupported_configuration",
          "Conflicting native MCP environment variable",
        );
      }
      env[name] = value;
    }
  }
  return env;
}
