import { validateMcpServers } from "../domain/mcp.js";
import {
  ControllerError,
  type ContextBlock,
  type Json,
} from "../contracts.js";
import type { Controller } from "../domain/engine.js";
import type { MemoryCandidate, MemoryProfile } from "../memory/recall.js";
import type { EndpointRegistry } from "./endpoints.js";
import { registerTranscriptAndTools } from "./server-register-tools.js";
import { validCandidate, validContext } from "./server-validate.js";

export function registerSocketEndpoint(
  controller: Controller,
  endpoints: EndpointRegistry,
  owner: string,
  applicationId: string,
  connectionId: string,
  send: (frame: unknown) => void,
  input: Record<string, unknown>,
): { registered: string; dispose: () => void } {
  const endpointId = String(input.id);
  const unregister = endpoints.register(
    owner,
    applicationId,
    endpointId,
    connectionId,
    (request) => send({ type: "endpoint.request", request }),
    (id) => send({ type: "endpoint.cancel", id }),
  );
  const disposers = [unregister];
  const call = (operation: string, payload: Json, signal?: AbortSignal) =>
    endpoints.request(
      owner,
      applicationId,
      endpointId,
      operation,
      payload,
      operation === "tool.execute" || operation.startsWith("transcript.")
        ? 120_000
        : 5000,
      signal,
    );
  try {
    if (input.mcp)
      disposers.push(
        controller.registerMcp(
          owner,
          endpointId,
          {
            resolve: async (thread, signal) => {
              const value = await call(
                "mcp.resolve",
                { thread: thread as unknown as Json },
                signal,
              );
              validateMcpServers(value);
              return value;
            },
          },
          applicationId,
        ),
      );
    if (input.memory)
      disposers.push(
        controller.registerMemory(
          owner,
          endpointId,
          {
            profile: (input.memory as { profile: MemoryProfile }).profile,
            candidates: async (thread, query, signal) => {
              const value = await call(
                "memory.candidates",
                { thread: thread as unknown as Json, query },
                signal,
              );
              if (
                !Array.isArray(value) ||
                value.length > 40 ||
                value.some((item) => !validCandidate(item))
              )
                throw new ControllerError(
                  "invalid_memory",
                  "Memory candidate response is invalid",
                );
              return value as unknown as MemoryCandidate[];
            },
            authorize: async (thread, refs, signal) =>
              (await call(
                "memory.authorize",
                {
                  thread: thread as unknown as Json,
                  refs: refs as unknown as Json,
                },
                signal,
              )) === true,
            read: (thread, operation, input, signal) =>
              call(
                `memory.${operation}`,
                { thread: thread as unknown as Json, input },
                signal,
              ),
          },
          applicationId,
        ),
      );
    if (input.context)
      disposers.push(
        controller.registerContext(
          owner,
          endpointId,
          {
            required: input.required === true,
            resolve: async (thread, turn, signal) => {
              const value = await call(
                "context.resolve",
                {
                  thread: thread as unknown as Json,
                  turn: turn as unknown as Json,
                },
                signal,
              );
              if (
                !Array.isArray(value) ||
                value.some((block) => !validContext(block))
              )
                throw new ControllerError(
                  "invalid_context",
                  "Context response is invalid",
                );
              return value as unknown as ContextBlock[];
            },
            authorize: async (thread, blocks, signal) =>
              (await call(
                "context.authorize",
                {
                  thread: thread as unknown as Json,
                  blocks: blocks as unknown as Json,
                },
                signal,
              )) === true,
          },
          applicationId,
        ),
      );
    registerTranscriptAndTools(
      controller,
      owner,
      applicationId,
      endpointId,
      input,
      call,
      disposers,
    );
  } catch (error) {
    disposers.reverse().forEach((dispose) => dispose());
    throw error;
  }
  return {
    registered: endpointId,
    dispose: () => disposers.forEach((dispose) => dispose()),
  };
}
