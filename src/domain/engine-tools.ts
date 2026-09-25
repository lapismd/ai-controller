import { randomUUID } from "node:crypto";
import {
  ControllerError,
  isTerminal,
  type Interaction,
  type Json,
  type Thread,
  type ToolResult,
  type Turn,
} from "../contracts.js";
import { bounded } from "./context.js";
import type { ControllerHost } from "./engine-host.js";
import { captureFor, persistCapture } from "./engine-transcript.js";
import type { ToolEndpoint } from "./ports.js";

export async function callTool(
  host: ControllerHost,
  thread: Thread,
  turn: Turn,
  endpoint: ToolEndpoint | undefined,
  name: string,
  input: Json,
  signal: AbortSignal,
  nativeId?: string,
): Promise<ToolResult> {
  const definition = endpoint?.definitions.find((tool) => tool.name === name);
  if (!endpoint || !definition)
    throw new ControllerError("tool_unavailable", "Tool is unavailable");
  if (!host.ajv.validate(definition.inputSchema, input))
    throw new ControllerError(
      "invalid_tool_input",
      "Tool arguments do not match schema",
    );
  const capturedInput = host.store.capture.clean(input);
  const id = nativeId ? `${turn.attemptId}:${nativeId}` : randomUUID();
  const prior = host.store.interaction(id);
  if (prior) {
    if (
      prior.nativeId !== name ||
      JSON.stringify(prior.request) !== JSON.stringify(capturedInput)
    )
      throw new ControllerError(
        "invocation_conflict",
        "Tool invocation identity has different input",
      );
    if (prior.state === "resolved")
      return prior.response as unknown as ToolResult;
    throw new ControllerError(
      "invocation_unknown",
      "Tool invocation must be reconciled before retry",
    );
  }
  const interaction: Interaction = {
    id,
    threadId: thread.id,
    turnId: turn.id,
    kind: "tool",
    nativeId: name,
    request: capturedInput,
    deadline: Date.now() + 120_000,
    state: "pending",
  };
  await persistCapture(host, turn, [
    captureFor(host, turn).record({
      kind: "tool-invocation",
      invocationId: id,
      name,
      input: capturedInput,
      execution: "controller",
    }),
  ]);
  host.store.putInteraction(interaction);
  const mutating = definition.effect !== "read";
  const capture = endpoint.capture?.({ thread, turn, signal }) ?? host.capture;
  let spanId: string | undefined;
  if (capture) {
    if (mutating) {
      try {
        const span = await capture.begin({
          caller: "controller",
          requestKey: interaction.id,
          workspaceId: thread.workspace,
          captureMode: "cooperative",
          intent: "tool",
          toolName: name,
        });
        spanId = span.spanId;
      } catch (error) {
        host.store.putInteraction({
          ...interaction,
          state: "unknown",
        });
        throw error instanceof ControllerError
          ? error
          : new ControllerError(
              "capture_unavailable",
              "Checkpoint capture is unavailable",
            );
      }
    } else if (capture.observe) {
      try {
        await capture.observe({
          caller: "controller",
          requestKey: `${interaction.id}:observe`,
          workspaceId: thread.workspace,
          payload: host.store.capture.clean({ name, input: capturedInput }),
        });
      } catch {
        // Read-effect observations stay non-blocking.
      }
    }
  }
  try {
    const result = await bounded(
      endpoint.execute(name, input, {
        invocationId: interaction.id,
        thread,
        turn,
        signal,
      }),
      120_000,
      signal,
    );
    if (signal.aborted || isTerminal(host.store.turn(turn.id)!.state))
      throw new ControllerError(
        "interaction_stale",
        "Tool result arrived after turn ended",
      );
    let capturedResult: ToolResult;
    try {
      capturedResult = host.store.capture.clean(result);
    } catch {
      capturedResult = {
        content: "Tool completed; result capture omitted",
        isError: true,
      };
    }
    await persistCapture(host, turn, [
      captureFor(host, turn).record({
        kind: "tool-result",
        invocationId: id,
        output: capturedResult.content,
        outcome: result.isError ? "failed" : "succeeded",
      }),
    ]);
    host.store.putInteraction({
      ...interaction,
      state: "resolved",
      response: capturedResult as unknown as Json,
    });
    if (spanId && capture) {
      await capture.finish({
        caller: "controller",
        requestKey: `${interaction.id}:finish`,
        workspaceId: thread.workspace,
        spanId,
        outcome: "succeeded",
      });
    }
    return capturedResult;
  } catch (error) {
    host.store.putInteraction({
      ...interaction,
      state: definition.effect === "read" ? "cancelled" : "unknown",
    });
    if (spanId && capture) {
      try {
        await capture.finish({
          caller: "controller",
          requestKey: `${interaction.id}:failed`,
          workspaceId: thread.workspace,
          spanId,
          outcome: "failed",
        });
      } catch {
        // Preserve the original tool or capture error.
      }
    }
    throw error;
  }
}
