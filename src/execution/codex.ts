import { ControllerError, type Capabilities, type Json } from "../contracts.js";
import type { ExecutionContext, ExecutionProvider } from "../domain/ports.js";
import { CodexNativeRuntime } from "./compat/codex-runtime.js";
import type {
  AgentSession,
  AiThinkingLevel,
  UserInputAnswers,
} from "./compat/types.js";
import { executionProcessHost } from "./process-host.js";
import {
  createAgentRuntimeExecutor,
  type AgentRuntimeExecutor,
  type AgentHostSink,
  type ToolBridgeCall,
} from "@lapismd/ai-host";

export class CodexProvider implements ExecutionProvider {
  readonly capabilities: Capabilities = {
    driver: "codex-native",
    content: ["text"],
    configuration: true,
    resume: "context",
    approvals: true,
    approvalFeatures: {
      persistentDecisions: true,
      granularPermissions: true,
      policyAmendments: true,
    },
    input: true,
    tools: true,
    externalMcp: true,
  };
  readonly #executor: AgentRuntimeExecutor;
  readonly #sink: AgentHostSink;
  readonly #host: ReturnType<typeof executionProcessHost>;
  readonly #runtime: CodexNativeRuntime;
  readonly #sessions = new Map<
    string,
    {
      session: AgentSession;
      manifest: string;
      bridgeId?: string;
      context?: ExecutionContext;
      completion?: { resolve(): void; reject(error: Error): void };
      pump: Promise<void>;
    }
  >();
  constructor(
    readonly workspaces: Record<string, string>,
    options: {
      id?: string;
      shimCommand?: { command: string; args: string[] };
      executor?: AgentRuntimeExecutor;
    } = {},
  ) {
    this.#executor =
      options.executor ??
      createAgentRuntimeExecutor({
        toolBridgeOptions: options.shimCommand
          ? { shimCommand: options.shimCommand }
          : undefined,
      });
    this.#sink = {
      connectionId: `controller-native:${options.id ?? "codex"}`,
      sendRuntimeEvent: () => {},
      sendProcessMessage: () => {},
      sendToolCancel: () => {},
      sendToolCall: (call: ToolBridgeCall) => {
        void this.tool(call);
      },
    };
    this.#host = executionProcessHost(this.#executor, this.#sink);
    this.#runtime = new CodexNativeRuntime(this.#host);
  }
  async execute(context: ExecutionContext): Promise<void> {
    const { thread, preparation } = context;
    const workspace = this.workspaces[thread.workspace];
    if (!workspace)
      throw new ControllerError(
        "workspace_unavailable",
        "Workspace is not configured",
      );
    const configuration = preparation.configuration;
    if (
      configuration.thinking &&
      !["off", "low", "medium", "high"].includes(configuration.thinking)
    )
      throw new ControllerError(
        "unsupported_configuration",
        "Thinking configuration is unsupported",
      );
    let state = this.#sessions.get(thread.id);
    const manifest = JSON.stringify({
      tools: context.tools,
      mcpServers: context.mcpServers ?? [],
      restricted: preparation.configuration.restricted ?? false,
    });
    if (state && state.manifest !== manifest) {
      await state.session.close();
      await state.pump;
      this.#sessions.delete(thread.id);
      state = undefined;
      await context.emit({
        type: "activity",
        data: { type: "session.reconfigured", reason: "tool_manifest_changed" },
      });
    }
    if (!state) {
      const bridgeId = context.tools.length
        ? (
            await this.#executor.openToolBridge(this.#sink, {
              bindingId: thread.id,
              conversationId: thread.id,
              descriptors: context.tools.map((tool) => ({
                ...tool,
                effect: tool.effect === "read" ? "read" : "write",
              })),
            })
          ).bridgeId
        : undefined;
      const request = {
        prompt: "",
        workspace,
        restricted: configuration.restricted,
        mcpServers: context.mcpServers,
        model: configuration.model
          ? { provider: "codex", model: configuration.model }
          : undefined,
        thinking: configuration.thinking as AiThinkingLevel | undefined,
        ...(bridgeId
          ? {
              appToolSession: {
                bridgeId,
                conversationId: thread.id,
                agentBindingId: thread.id,
                scopeDir: workspace,
                tools: [],
              },
            }
          : {}),
      };
      let session: AgentSession;
      try {
        session = thread.nativeSessionId
          ? await this.#runtime.resume(thread.nativeSessionId, request)
          : await this.#runtime.start(request);
      } catch (error) {
        if (bridgeId) this.#executor.closeToolBridge(this.#sink, bridgeId);
        throw error;
      }
      await context.bindSession(session.id);
      state = { session, manifest, bridgeId, pump: Promise.resolve() };
      this.#sessions.set(thread.id, state);
      const owned = state;
      state.pump = (async () => {
        for await (const event of session.events()) {
          const active = owned.context;
          if (!active) continue;
          if (event.type === "text")
            await active.emit({ type: "text", text: event.text });
          else if (event.type === "completed") {
            await active.emit({ type: "completed" });
            owned.completion?.resolve();
          } else if (event.type === "error") {
            await active.emit({ type: "failed", code: "provider_failed" });
            owned.completion?.resolve();
          } else if (
            event.type === "permission.request" ||
            event.type === "question.request"
          ) {
            const kind =
              event.type === "permission.request" ? "approval" : "input";
            void active
              .interact(
                kind,
                event.request.id,
                event.request as unknown as Json,
                Date.now() + 15 * 60_000,
              )
              .then((value) =>
                kind === "approval"
                  ? session.respondToApproval(event.request.id, String(value))
                  : session.respondToQuestion!(
                      event.request.id,
                      value as UserInputAnswers,
                    ),
              )
              .catch(() =>
                owned.completion?.reject(
                  new ControllerError(
                    "interaction_stale",
                    "Native interaction could not be answered",
                  ),
                ),
              );
          } else
            await active.emit({
              type: "activity",
              data: event as unknown as Json,
            });
        }
        owned.completion?.reject(
          new ControllerError("provider_closed", "Native process closed"),
        );
      })().catch(() =>
        owned.completion?.reject(
          new ControllerError(
            "ingestion_failed",
            "Native output could not be persisted",
          ),
        ),
      );
    }
    await state.session.configure?.({
      model: configuration.model
        ? { provider: "codex", model: configuration.model }
        : undefined,
      thinking: configuration.thinking as AiThinkingLevel | undefined,
    });
    state.context = context;
    const completion = new Promise<void>((resolve, reject) => {
      state!.completion = { resolve, reject };
    });
    const abort = () => {
      void state!.session
        .cancel?.()
        .finally(() =>
          state!.completion?.reject(
            new ControllerError(
              "cancel_unconfirmed",
              "Native turn cancellation requested",
            ),
          ),
        );
    };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      context.signal.throwIfAborted();
      await state.session.send(
        [
          ...preparation.blocks.map((block) => block.content),
          preparation.text,
        ].join("\n\n"),
      );
      await completion;
    } finally {
      context.signal.removeEventListener("abort", abort);
      state.context = undefined;
      state.completion = undefined;
    }
  }
  async close(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map(async (state) => {
        await state.session.close();
        await state.pump;
      }),
    );
    await this.#host.close();
  }
  private async tool(call: ToolBridgeCall): Promise<void> {
    const state = this.#sessions.get(call.bindingId);
    try {
      if (!state?.context || state.bridgeId !== call.bridgeId)
        throw new ControllerError(
          "tool_stale",
          "Tool binding is no longer live",
        );
      const result = await state.context.callTool(
        call.name,
        call.input as Json,
        call.callId,
      );
      this.#executor.respondToolBridge(this.#sink, {
        bridgeId: call.bridgeId,
        callId: call.callId,
        result,
      });
    } catch {
      try {
        this.#executor.respondToolBridge(this.#sink, {
          bridgeId: call.bridgeId,
          callId: call.callId,
          error: {
            code: "tool_failed",
            message: "Application tool did not complete",
          },
        });
      } catch {
        /* The process may have closed the native call. */
      }
    }
  }
}
