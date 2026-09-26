import {
  createAgentRuntimeExecutor,
  type AgentHostSink,
  type AgentRuntimeExecutor,
  type NativeAgentRuntimeEvent,
  type ToolBridgeCall,
  type AcpAgentRegistry,
} from "@lapismd/ai-host";
import { ControllerError, type Json } from "../contracts.js";
import type { ExecutionContext, ExecutionProvider } from "../domain/ports.js";
import { rejectedRequestedConfiguration } from "./acp-configure.js";
import { nativePermissionMode } from "./native-permission-mode.js";
import { AcpWorkerPool } from "./acp-worker-pool.js";
import { receiveAcpFrame } from "./acp-event-ingest.js";
import { callAcpTool } from "./acp-tool-bridge.js";
import { encodePrompt } from "./acp-prompt.js";
import { acpCapabilities } from "./acp-capabilities.js";
import type { Thread } from "../contracts.js";

export interface ActiveSession {
  sessionId: string;
  manifest: string;
  bridgeId?: string;
  context?: ExecutionContext;
  ingest: Promise<void>;
  resolve?(): void;
  reject?(error: Error): void;
  queued: number;
  interactions: Map<string, Promise<void>>;
  settledInteractions: Set<string>;
}
export class AcpProvider implements ExecutionProvider {
  readonly capabilities = acpCapabilities;
  readonly #executor: AgentRuntimeExecutor;
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #sink: AgentHostSink;
  readonly #pool: AcpWorkerPool;
  readonly #ownsPool: boolean;
  readonly #reserved = new Set<string>();
  readonly #evicted = new Set<string>();
  constructor(
    readonly options: {
      id: string;
      agent: string;
      workspaces: Record<string, string>;
      executor?: AgentRuntimeExecutor;
      agentRegistry?: AcpAgentRegistry;
      shimCommand?: { command: string; args: string[] };
      workerPool?: AcpWorkerPool;
    },
  ) {
    this.#pool = options.workerPool ?? new AcpWorkerPool();
    this.#ownsPool = !options.workerPool;
    this.#executor =
      options.executor ??
      createAgentRuntimeExecutor({
        agentRegistry: options.agentRegistry,
        toolBridgeOptions: options.shimCommand
          ? { shimCommand: options.shimCommand }
          : undefined,
      });
    this.#sink = {
      connectionId: `controller:${options.id}`,
      sendProcessMessage: () => {},
      sendRuntimeEvent: (frame: NativeAgentRuntimeEvent) => this.receive(frame),
      sendToolCall: (call: ToolBridgeCall) => {
        void this.tool(call);
      },
      sendToolCancel: () => {},
    };
  }
  listAgents() {
    return this.#executor.listAcpAgents();
  }
  async reserve(thread: Thread, signal: AbortSignal): Promise<() => void> {
    const key = `${this.options.id}:${thread.id}`;
    await this.#pool.reserve(key, async () => {
      const session = this.#sessions.get(thread.id);
      if (!session) return;
      if (session.context) throw new Error("Cannot evict an active ACP session");
      await this.#executor.closeAcpSession(session.sessionId);
      this.#sessions.delete(thread.id);
      this.#evicted.add(thread.id);
    }, signal);
    this.#reserved.add(thread.id);
    return () => {
      this.#reserved.delete(thread.id);
      this.#pool.release(key, this.#sessions.has(thread.id));
    };
  }
  async resources() {
    const executor = this.#executor as AgentRuntimeExecutor & {
      snapshotAcpResources?: () => Promise<unknown>;
    };
    return executor.snapshotAcpResources?.() ?? {
      status: "unavailable",
      observedAt: Date.now(),
      workers: { busy: 0, idle: 0, starting: 0, stopping: 0 },
      sessions: 0,
      rssBytes: null,
    };
  }
  models(workspace: string, options?: { sessionId?: string; agent?: string }) {
    return this.#executor.listAcpModels(this.#sink, {
      agent: options?.agent ?? this.options.agent,
      workspace: this.workspace(workspace),
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    });
  }
  async execute(context: ExecutionContext): Promise<void> {
    const { thread, preparation } = context;
    const localRelease = this.#reserved.has(thread.id)
      ? undefined
      : await this.reserve(thread, context.signal);
    try {
    const workspace = this.workspace(thread.workspace);
    if (
      preparation.configuration.agent &&
      preparation.configuration.agent !== this.options.agent
    )
      throw new ControllerError(
        "instance_mismatch",
        "Select a configured provider instance for this agent",
      );
    let session = this.#sessions.get(thread.id);
    if (!session && this.#evicted.delete(thread.id))
      await context.emit({
        type: "activity",
        data: { type: "session.evicted", message: "The idle ACP worker was closed. This turn starts a fresh agent session using saved conversation context." },
      });
    const manifest = JSON.stringify({
      tools: context.tools,
      mcpServers: context.mcpServers ?? [],
      restricted: preparation.configuration.restricted ?? false,
      vcsIdentity: preparation.configuration.vcsIdentity,
      permissionMode: preparation.configuration.permissionMode,
    });
    if (session && session.manifest !== manifest) {
      await this.#executor.closeAcpSession(session.sessionId);
      this.#sessions.delete(thread.id);
      session = undefined;
      await context.emit({
        type: "activity",
        data: { type: "session.reconfigured", reason: "tool_manifest_changed" },
      });
    }
    if (!session) {
      session = {
        sessionId: `${this.options.id}:${thread.id}`,
        manifest,
        ingest: Promise.resolve(),
        queued: 0,
        interactions: new Map(), settledInteractions: new Set(),
      };
      this.#sessions.set(thread.id, session);
      if (context.tools.length) {
        const bridge = await this.#executor.openToolBridge(this.#sink, {
          bindingId: thread.id,
          conversationId: thread.id,
          descriptors: context.tools.map((tool) => ({
            ...tool,
            effect: tool.effect === "read" ? "read" : "write",
          })),
        });
        session.bridgeId = bridge.bridgeId;
      }
      try {
        const start = {
          sessionId: session.sessionId,
          agent: this.options.agent,
          workspace,
          restricted: preparation.configuration.restricted,
          ...(preparation.configuration.permissionMode
            ? { permissionMode: preparation.configuration.permissionMode }
            : {}),
          metadata: { vcsIdentity: preparation.configuration.vcsIdentity },
          mcpServers: context.mcpServers,
          ...(session.bridgeId ? { appToolBridgeId: session.bridgeId } : {}),
        };
        const result = await this.#executor.startAcpSession(this.#sink, start);
        session.sessionId = result.sessionId;
      } catch (error) {
        this.#sessions.delete(thread.id);
        if (session.bridgeId)
          this.#executor.closeToolBridge(this.#sink, session.bridgeId);
        throw error;
      }
    }
    if (preparation.configuration.permissionMode)
      await context.emit({ type: "execution-policy", nativeMode: nativePermissionMode(this.#executor, session.sessionId, preparation.configuration.permissionMode) });
    const model = preparation.configuration.model;
    const thinking = preparation.configuration.thinking;
    if (thinking && !["off", "low", "medium", "high"].includes(thinking))
      throw new ControllerError(
        "unsupported_configuration",
        "Thinking value is unsupported by the host contract",
      );
    if (model || thinking) {
      const effective = await this.#executor.configureAcpSession({
        sessionId: session.sessionId,
        ...(model ? { model: { model } } : {}),
        ...(thinking
          ? { thinking: thinking as "off" | "low" | "medium" | "high" }
          : {}),
      });
      const rejected = rejectedRequestedConfiguration(
        { model, thinking },
        effective,
      );
      if (rejected)
        throw new ControllerError("unsupported_configuration", rejected.reason);
    }
    session.context = context;
    session.settledInteractions.clear();
    const completion = new Promise<void>((resolve, reject) => {
      session!.resolve = resolve;
      session!.reject = reject;
    });
    let cancellationDeadline: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      cancellationDeadline ??= setTimeout(
        () =>
          session!.reject?.(
            new ControllerError(
              "cancel_unknown",
              "Native cancellation is unconfirmed",
            ),
          ),
        10_000,
      );
      void this.#executor
        .cancelAcpSession(session!.sessionId)
        .catch(() =>
          session!.reject?.(
            new ControllerError(
              "cancel_unknown",
              "Native cancellation is unconfirmed",
            ),
          ),
        );
    };
    context.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => {
      abort();
      session!.reject?.(
        new ControllerError("execution_timeout", "Execution deadline expired"),
      );
    }, 30 * 60_000);
    try {
      context.signal.throwIfAborted();
      const prompt = encodePrompt(context);
      await context.dispatch();
      await this.#executor.promptAcpSession(
        this.#sink,
        session.sessionId,
        prompt,
      );
      await completion;
      await session.ingest;
    } finally {
      clearTimeout(deadline);
      clearTimeout(cancellationDeadline);
      context.signal.removeEventListener("abort", abort);
      session.context = undefined;
      session.resolve = undefined;
      session.reject = undefined;
    }
    } finally {
      localRelease?.();
    }
  }
  async close(): Promise<void> {
    for (const session of this.#sessions.values())
      session.reject?.(
        new ControllerError("execution_interrupted", "Controller is stopping"),
      );
    await this.#executor.close();
    for (const threadId of this.#sessions.keys())
      this.#pool.forget(`${this.options.id}:${threadId}`);
    if (this.#ownsPool) this.#pool.close();
    this.#sessions.clear();
  }
  private workspace(id: string): string {
    const path = this.options.workspaces[id];
    if (!path)
      throw new ControllerError(
        "workspace_unavailable",
        "Workspace is not configured",
      );
    return path;
  }
  private receive(frame: NativeAgentRuntimeEvent): void {
    receiveAcpFrame(this.#executor, this.#sessions, frame);
  }
  private tool(call: ToolBridgeCall): Promise<void> {
    return callAcpTool(this.#executor, this.#sink, this.#sessions, call);
  }
}
