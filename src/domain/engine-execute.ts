import { threadEndpointKey } from "../auth/authorize.js";
import {
  ControllerError,
  isTerminal,
  type Thread,
  type Turn,
} from "../contracts.js";
import { continuationContext, continuationTarget } from "./continuation.js";
import { authorizePreparation, prepareTurn } from "./context.js";
import { readMemory } from "./engine-endpoints.js";
import type { ControllerHost } from "./engine-host.js";
import { interact } from "./engine-interact.js";
import { callTool } from "./engine-tools.js";
import { captureFor, persistCapture, replayTranscript } from "./engine-transcript.js";
import { recordExecutionPolicy } from "./execution-policy.js";
import { validateMcpServers } from "./mcp.js";
import { bounded } from "./context.js";
import { memoryToolDefinitions } from "./memory-tools.js";
import type { RuntimeEvent, ToolEndpoint } from "./ports.js";

export async function ingestRuntimeEvent(
  host: ControllerHost,
  turnId: string,
  event: RuntimeEvent,
): Promise<void> {
  const turn = host.store.turn(turnId)!;
  if (event.type === "interaction-settled") {
    host.interactionLifecycle.settle(
      host.store,
      turn,
      event.nativeId,
      event.state,
      (id, error) => host.responses.get(id)?.reject(error),
    );
    return;
  }
  if (isTerminal(turn.state)) return;
  if (event.type === "execution-policy") {
    recordExecutionPolicy(
      host.store,
      turn,
      host.store.preparation(turnId)!.configuration,
      event.nativeMode,
    );
    return;
  }
  if (["prepared", "dispatching"].includes(turn.state))
    host.store.transition(turnId, "running");
  await persistCapture(host, turn, captureFor(host, turn).accept(event));
  if (event.type === "completed")
    host.store.transition(turnId, event.outcome ?? "completed");
  else if (event.type === "failed")
    host.store.transition(turnId, "failed", host.store.capture.clean(event.code));
}

export async function executeTurn(
  host: ControllerHost,
  thread: Thread,
  turn: Turn,
  signal: AbortSignal,
): Promise<void> {
  let releaseProvider: (() => void) | undefined;
  try {
    const provider = host.providers.get(thread.provider);
    if (!provider)
      throw new ControllerError("provider_unavailable", "Provider unavailable");
    releaseProvider = await provider.reserve?.(thread, signal);
    if (
      thread.nativeSessionId &&
      thread.capturePolicy !== host.store.capture.policyId
    )
      throw new ControllerError(
        "legacy_context_handoff_required",
        "Create a fresh thread with sanitized context before resuming this legacy session",
      );
    await persistCapture(host, turn, [
      captureFor(host, turn).record({
        kind: "message",
        role: "user",
        text: turn.text ?? "",
        messageId: `${turn.attemptId}:request`,
      }),
    ]);
    let preparation = host.store.preparation(turn.id);
    if (!preparation) {
      host.store.transition(turn.id, "preparing");
      preparation = host.store.capture.clean(
        await prepareTurn(thread, turn, host.sources, signal),
      );
      if (turn.continuedFrom) {
        continuationTarget(host.store, thread.owner, {
          turnId: turn.continuedFrom,
          commandId: turn.commandId,
          text: turn.text ?? "",
        });
        const blocks = await continuationContext(thread, turn, (sequence, parent) =>
          replayTranscript(host, thread.owner, thread.id, sequence, parent),
        );
        preparation = host.store.capture.clean({
          ...preparation,
          blocks: [...blocks, ...preparation.blocks],
        });
      }
      host.store.prepare(turn.id, preparation);
    }
    const mcpEndpoint = thread.mcpEndpoint
      ? host.mcp.get(threadEndpointKey(thread, thread.mcpEndpoint))
      : undefined;
    if (thread.mcpEndpoint && !mcpEndpoint)
      throw new ControllerError(
        "mcp_unavailable",
        "External MCP endpoint is unavailable",
      );
    const mcpServers = mcpEndpoint
      ? await bounded(mcpEndpoint.resolve(thread, signal), 5000, signal)
      : [];
    validateMcpServers(mcpServers);
    if (
      mcpServers.length &&
      (!provider.capabilities.externalMcp || preparation.configuration.restricted)
    )
      throw new ControllerError(
        "mcp_unsupported",
        "External MCP servers are unsupported for this execution",
      );
    const endpoint = thread.toolEndpoint
      ? host.tools.get(threadEndpointKey(thread, thread.toolEndpoint))
      : undefined;
    if (thread.toolEndpoint && !endpoint)
      throw new ControllerError(
        "tools_unavailable",
        "Tool endpoint is unavailable",
      );
    const memoryTools = thread.memoryEndpoint ? memoryToolDefinitions : [];
    if (
      preparation.configuration.restricted &&
      ((endpoint?.definitions.length ?? 0) || memoryTools.length)
    )
      throw new ControllerError(
        "restricted_tools",
        "Restricted execution cannot receive application or memory tools",
      );
    if (
      endpoint?.definitions.some((tool) =>
        memoryTools.some((memory) => memory.name === tool.name),
      )
    )
      throw new ControllerError(
        "tool_conflict",
        "Memory tools are owned by controller preparation",
      );
    const combined: ToolEndpoint = {
      ...(endpoint?.capture ? { capture: endpoint.capture } : {}),
      definitions: [...(endpoint?.definitions ?? []), ...memoryTools],
      execute: async (name, input, call) => {
        if (memoryTools.some((tool) => tool.name === name))
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  await readMemory(
                    host,
                    thread.owner,
                    thread.id,
                    name === "memory_search" ? "search" : "get",
                    input,
                    call.signal,
                  ),
                ),
              },
            ],
          };
        if (!endpoint)
          throw new ControllerError(
            "tool_unavailable",
            "Tool endpoint is unavailable",
          );
        return endpoint.execute(name, input, call);
      },
    };
    await authorizePreparation(thread, preparation, host.sources, signal);
    signal.throwIfAborted();
    recordExecutionPolicy(host.store, turn, preparation.configuration);
    await provider.execute({
      thread,
      turn,
      preparation,
      tools: host.store.capture.clean(combined.definitions),
      mcpServers,
      signal,
      dispatch: async () => {
        signal.throwIfAborted();
        await authorizePreparation(thread, preparation, host.sources, signal);
        signal.throwIfAborted();
        host.store.transition(turn.id, "dispatching");
      },
      emit: (event) => ingestRuntimeEvent(host, turn.id, event),
      bindSession: async (id) => host.store.bindSession(thread.id, id),
      callTool: (name, input, nativeId) =>
        callTool(host, thread, turn, combined, name, input, signal, nativeId),
      interact: (kind, nativeId, request, deadline) =>
        interact(host, thread, turn, kind, nativeId, request, deadline, signal),
    });
    if (!isTerminal(host.store.turn(turn.id)!.state))
      host.store.transition(
        turn.id,
        "interrupted",
        signal.aborted ? "cancellation_unconfirmed" : "missing_completion",
      );
  } catch (error) {
    const current = host.store.turn(turn.id)!;
    if (!isTerminal(current.state)) {
      const code =
        error instanceof ControllerError ? error.code : "execution_failed";
      const state = signal.aborted
        ? ["queued", "preparing", "prepared"].includes(current.state)
          ? "cancelled"
          : "interrupted"
        : current.state === "dispatching"
          ? "submission-unknown"
          : ["running", "waiting"].includes(current.state)
            ? "interrupted"
            : "failed";
      host.store.transition(
        turn.id,
        state,
        signal.aborted ? "cancellation_unconfirmed" : code,
      );
    }
  } finally {
    releaseProvider?.();
    try {
      await persistCapture(
        host,
        turn,
        captureFor(host, turn).finish("interrupted"),
      );
    } catch {
      host.store.append(
        thread.id,
        "capture.gap",
        { reason: "capture_acknowledgment_unavailable" },
        turn.id,
        `${turn.attemptId}:gap`,
        true,
      );
    } finally {
      host.captures.delete(turn.id);
      host.interactionLifecycle.clear(turn.id);
    }
    for (const interaction of host.store.interactions(thread.id))
      if (interaction.turnId === turn.id && interaction.state === "pending") {
        host.store.putInteraction({
          ...interaction,
          state: interaction.kind === "tool" ? "unknown" : "cancelled",
        });
        host.responses
          .get(interaction.id)
          ?.reject(new ControllerError("interaction_stale", "Turn ended"));
        host.responses.delete(interaction.id);
      }
  }
}
