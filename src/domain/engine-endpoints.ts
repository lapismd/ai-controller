import {
  applicationOf,
  authorizeMemoryInput,
  endpointKey,
  threadEndpointKey,
} from "../auth/authorize.js";
import { ControllerError, type Json } from "../contracts.js";
import { recallMemory } from "../memory/recall.js";
import { bounded } from "./context.js";
import type { ControllerHost } from "./engine-host.js";
import { memoryToolDefinitions } from "./memory-tools.js";
import type {
  ContextSource,
  MemoryEndpoint,
  McpEndpoint,
  ToolEndpoint,
  TranscriptEndpoint,
} from "./ports.js";

export function inspectTools(
  host: ControllerHost,
  owner: string,
  threadId: string,
) {
  const thread = host.store.authorizeThread(owner, threadId);
  const endpoint = thread.toolEndpoint
    ? host.tools.get(threadEndpointKey(thread, thread.toolEndpoint))
    : undefined;
  return {
    available: !thread.toolEndpoint || !!endpoint,
    memoryAvailable:
      !thread.memoryEndpoint ||
      host.memory.has(threadEndpointKey(thread, thread.memoryEndpoint)),
    definitions: structuredClone([
      ...(endpoint?.definitions ?? []),
      ...(thread.memoryEndpoint ? memoryToolDefinitions : []),
    ]),
  };
}

export function registerTranscript(
  host: ControllerHost,
  owner: string,
  id: string,
  endpoint: TranscriptEndpoint,
  applicationId = owner,
): () => void {
  const key = endpointKey(owner, applicationId, id);
  host.transcripts.set(key, endpoint);
  return () => {
    if (host.transcripts.get(key) === endpoint) host.transcripts.delete(key);
  };
}

export function registerMcp(
  host: ControllerHost,
  owner: string,
  id: string,
  endpoint: McpEndpoint,
  applicationId = owner,
): () => void {
  const key = endpointKey(owner, applicationId, id);
  host.mcp.set(key, endpoint);
  return () => {
    if (host.mcp.get(key) === endpoint) host.mcp.delete(key);
  };
}

export function registerContext(
  host: ControllerHost,
  owner: string,
  id: string,
  source: ContextSource,
  applicationId = owner,
): () => void {
  const key = endpointKey(owner, applicationId, id);
  host.sources.set(key, source);
  return () => {
    if (host.sources.get(key) === source) host.sources.delete(key);
  };
}

export function registerMemory(
  host: ControllerHost,
  owner: string,
  id: string,
  endpoint: MemoryEndpoint,
  applicationId = owner,
): () => void {
  const key = endpointKey(owner, applicationId, id);
  host.memory.set(key, endpoint);
  const dispose = registerContext(
    host,
    owner,
    `__memory.${id}`,
    {
      required: false,
      resolve: async (thread, turn, signal) => {
        const recalled = await recallMemory(
          {
            profile: endpoint.profile,
            candidates: (query, abort) =>
              endpoint.candidates(thread, query, abort),
            authorize: (items, abort) =>
              endpoint.authorize(thread, items, abort),
          },
          turn.text ?? "",
          signal,
        );
        return {
          blocks: recalled.blocks,
          ...(recalled.omitted ? { omitted: recalled.omitted } : {}),
        };
      },
      authorize: (thread, blocks, signal) =>
        endpoint.authorize(
          thread,
          blocks.map((block) => ({ ref: block.id, revision: block.revision })),
          signal,
        ),
    },
    applicationId,
  );
  return () => {
    dispose();
    if (host.memory.get(key) === endpoint) host.memory.delete(key);
  };
}

export function registerTools(
  host: ControllerHost,
  owner: string,
  id: string,
  endpoint: ToolEndpoint,
  applicationId = owner,
): () => void {
  const names = new Set<string>();
  for (const definition of endpoint.definitions) {
    if (names.has(definition.name))
      throw new ControllerError("invalid_tools", "Duplicate tool name");
    names.add(definition.name);
    host.ajv.compile(definition.inputSchema);
  }
  const key = endpointKey(owner, applicationId, id);
  host.tools.set(key, endpoint);
  return () => {
    if (host.tools.get(key) === endpoint) host.tools.delete(key);
  };
}

export async function readMemory(
  host: ControllerHost,
  owner: string,
  threadId: string,
  operation: "search" | "get",
  input: Json,
  signal = new AbortController().signal,
): Promise<Json> {
  const thread = host.store.authorizeThread(owner, threadId);
  const endpoint =
    thread.memoryEndpoint &&
    host.memory.get(threadEndpointKey(thread, thread.memoryEndpoint));
  if (!endpoint)
    throw new ControllerError(
      "memory_unavailable",
      "Memory endpoint is unavailable",
    );
  const access = {
    principalId: thread.owner,
    applicationId: applicationOf(thread),
    workspaceId: thread.workspace,
    threadId: thread.id,
  };
  return host.store.capture.clean(
    await bounded(
      endpoint.read(
        thread,
        operation,
        authorizeMemoryInput(host.store.capture.clean(input), access),
        signal,
      ),
      30_000,
      signal,
    ),
  );
}
