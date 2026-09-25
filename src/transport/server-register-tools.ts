import { assertTranscript } from "../capture/validation.js";
import {
  ControllerError,
  type Json,
  type Thread,
  type ToolDefinition,
  type ToolResult,
  type Turn,
} from "../contracts.js";
import type { Controller } from "../domain/engine.js";

export type EndpointCall = (
  operation: string,
  payload: Json,
  signal?: AbortSignal,
) => Promise<Json>;

export function registerTranscriptAndTools(
  controller: Controller,
  owner: string,
  applicationId: string,
  endpointId: string,
  input: Record<string, unknown>,
  call: EndpointCall,
  disposers: Array<() => void>,
): void {
  if (input.transcript === true)
    disposers.push(
      controller.registerTranscript(
        owner,
        endpointId,
        {
          append: async (thread, event) => {
            const response = await call("transcript.append", {
              threadId: thread.id,
              workspaceId: thread.workspace,
              event: event as unknown as Json,
            });
            if (
              !response ||
              typeof response !== "object" ||
              Array.isArray(response) ||
              response.durable !== true ||
              response.eventId !== event.id ||
              response.sequence !== event.sequence
            )
              throw new ControllerError(
                "transcript_unacknowledged",
                "Transcript endpoint did not acknowledge durable capture",
              );
            return {
              eventId: event.id,
              sequence: event.sequence,
              durable: true,
            };
          },
          replay: async (thread, afterSequence, turnId) => {
            const response = await call("transcript.replay", {
              threadId: thread.id,
              workspaceId: thread.workspace,
              afterSequence,
              ...(turnId ? { turnId } : {}),
            });
            if (
              !response ||
              typeof response !== "object" ||
              Array.isArray(response) ||
              !Array.isArray(response.events) ||
              response.events.length > 1000 ||
              typeof response.complete !== "boolean"
            )
              throw new ControllerError(
                "transcript_invalid",
                "Transcript replay is invalid",
              );
            for (const item of response.events)
              if (
                !item ||
                typeof item !== "object" ||
                Array.isArray(item) ||
                item.schema !== "lapis.transcript/1" ||
                item.threadId !== thread.id ||
                (turnId && item.turnId !== turnId)
              )
                throw new ControllerError(
                  "transcript_invalid",
                  "Transcript replay scope is invalid",
                );
            for (const item of response.events)
              assertTranscript(controller.store.capture.clean(item));
            return response as unknown as import("../transcript-contracts.js").TranscriptPage;
          },
        },
        applicationId,
      ),
    );
  if (input.tools)
    disposers.push(
      controller.registerTools(
        owner,
        endpointId,
        {
          definitions: input.tools as ToolDefinition[],
          ...(input.capture === true
            ? {
                capture: (context: {
                  thread: Thread;
                  turn: Turn;
                  signal: AbortSignal;
                }) => ({
                  begin: async (
                    payload: Parameters<
                      import("../domain/ports.js").ToolCapture["begin"]
                    >[0],
                  ) => {
                    const value = await call(
                      "capture.begin",
                      {
                        ...payload,
                        threadId: context.thread.id,
                        turnId: context.turn.id,
                      },
                      context.signal,
                    );
                    if (
                      !value ||
                      typeof value !== "object" ||
                      Array.isArray(value) ||
                      typeof value.spanId !== "string" ||
                      !value.spanId
                    )
                      throw new ControllerError(
                        "capture_unavailable",
                        "Capture endpoint omitted its span identity",
                      );
                    return { spanId: value.spanId };
                  },
                  finish: async (
                    payload: Parameters<
                      import("../domain/ports.js").ToolCapture["finish"]
                    >[0],
                  ) => {
                    await call("capture.finish", {
                      ...payload,
                      threadId: context.thread.id,
                      turnId: context.turn.id,
                    });
                  },
                  observe: async (
                    payload: Parameters<
                      NonNullable<
                        import("../domain/ports.js").ToolCapture["observe"]
                      >
                    >[0],
                  ) => {
                    await call(
                      "capture.observe",
                      {
                        ...payload,
                        threadId: context.thread.id,
                        turnId: context.turn.id,
                      },
                      context.signal,
                    );
                  },
                }),
              }
            : {}),
          execute: async (name, args, context) => {
            const result = await call(
              "tool.execute",
              {
                name,
                arguments: args,
                invocationId: context.invocationId,
                thread: context.thread as unknown as Json,
                turn: context.turn as unknown as Json,
              },
              context.signal,
            );
            if (
              !result ||
              typeof result !== "object" ||
              Array.isArray(result) ||
              !("content" in result)
            )
              throw new ControllerError(
                "invalid_tool_result",
                "Tool response is invalid",
              );
            return result as unknown as ToolResult;
          },
        },
        applicationId,
      ),
    );
}
