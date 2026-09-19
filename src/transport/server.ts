import { validateMcpServers } from "../domain/mcp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ControllerError,
  PROTOCOL,
  type AuthSession,
  type ContextBlock,
  type Json,
  type Principal,
  type ThreadInput,
  type Thread,
  type ToolDefinition,
  type ToolResult,
  type TurnInput,
  type Turn,
} from "../contracts.js";
import { Controller } from "../domain/engine.js";
import { EndpointRegistry } from "./endpoints.js";
import { validateRequest } from "./schema.js";
import type { MemoryCandidate, MemoryProfile } from "../memory/recall.js";
import { AuthSessionStore } from "../auth/session.js";
import { requireScope } from "../auth/scopes.js";
import { requireResource } from "../auth/authorize.js";

export interface ServerCredential {
  token: string;
  principal: Principal;
}
export async function serveController(
  controller: Controller,
  options: { credentials: ServerCredential[]; bind?: string; port?: number },
) {
  if (
    !options.credentials.length ||
    options.credentials.some((item) => item.token.length < 24)
  )
    throw new ControllerError(
      "configuration_invalid",
      "Controller requires nonempty strong credentials",
    );
  const sessions = new AuthSessionStore(controller.store);
  const endpoints = new EndpointRegistry();
  const http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 1024 * 1024 });
  wss.on("connection", (socket) => {
    const connectionId = randomUUID();
    let session: AuthSession | undefined;
    let inFlight = 0;
    const subscriptions = new Map<string, () => void>();
    const registrations = new Map<string, () => void>();
    const send = (frame: unknown) => {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > 8 * 1024 * 1024) {
        socket.close(4408, "resnapshot_required");
        return;
      }
      socket.send(JSON.stringify(frame));
    };
    const timeout = setTimeout(
      () => socket.close(4401, "authentication_required"),
      5000,
    );
    socket.on("close", () => {
      clearTimeout(timeout);
      for (const dispose of subscriptions.values()) dispose();
      for (const dispose of registrations.values()) dispose();
    });
    socket.on("message", async (raw) => {
      let id: unknown;
      if (++inFlight > 64) {
        inFlight--;
        socket.close(4408, "too_many_requests");
        return;
      }
      try {
        const request = JSON.parse(raw.toString()) as Record<string, unknown>;
        id = request.id;
        if (typeof id !== "string" || id.length > 512)
          throw new ControllerError(
            "invalid_input",
            "Request identity is invalid",
          );
        if (!session) {
          if (request.method !== "hello" || typeof request.token !== "string")
            throw new ControllerError(
              "authentication_failed",
              "Handshake rejected",
            );
          if (request.protocol !== PROTOCOL)
            throw new ControllerError(
              "protocol_unsupported",
              "Unsupported controller protocol",
            );
          const issued = sessions.hello(
            request.token,
            options.credentials,
            request.scopes,
          );
          session = issued.session;
          clearTimeout(timeout);
          send({
            id,
            result: {
              protocol: PROTOCOL,
              principal: session.principalId,
              session: {
                id: session.id,
                expiresAt: session.expiresAt,
                ...(issued.token ? { token: issued.token } : {}),
              },
            },
          });
          return;
        }
        const method = String(request.method);
        const params = request.params ?? {};
        validateRequest(method, params);
        const owner = session.principalId;
        const applicationId = session.applicationId;
        const result = await dispatch(method, params, session, controller, {
          subscribe(threadId, after) {
            subscriptions.get(threadId)?.();
            const snapshot = controller.store.snapshot(owner, threadId);
            const replay = after
              ? controller.store.events(owner, threadId, after, 1000)
              : [];
            // A snapshot is always the current authoritative barrier; replay is an optional diagnostic page.
            subscriptions.set(
              threadId,
              controller.store.onEvent((event) => {
                if (event.threadId === threadId) send({ type: "event", event });
              }),
            );
            return { snapshot, replay };
          },
          unsubscribe(threadId) {
            subscriptions.get(threadId)?.();
            subscriptions.delete(threadId);
          },
          unregister(id) {
            registrations.get(id)?.();
            registrations.delete(id);
          },
          register(input) {
            const endpointId = String(input.id);
            registrations.get(endpointId)?.();
            const unregister = endpoints.register(
              owner,
              applicationId,
              endpointId,
              connectionId,
              (request) => send({ type: "endpoint.request", request }),
              (id) => send({ type: "endpoint.cancel", id }),
            );
            const disposers = [unregister];
            const call = (
              operation: string,
              payload: Json,
              signal?: AbortSignal,
            ) =>
              endpoints.request(
                owner,
                applicationId,
                endpointId,
                operation,
                payload,
                operation === "tool.execute" ? 120_000 : 5000,
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
                  controller.registerMemory(owner, endpointId, {
                    profile: (input.memory as { profile: MemoryProfile })
                      .profile,
                    candidates: async (thread, query, signal) => {
                      const value = await call(
                        "memory.candidates",
                        {
                          thread: thread as unknown as Json,
                          query,
                        },
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
                        {
                          thread: thread as unknown as Json,
                          input,
                        },
                        signal,
                      ),
                  }, applicationId),
                );
              if (input.context)
                disposers.push(
                  controller.registerContext(owner, endpointId, {
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
                  }, applicationId),
                );
              if (input.tools)
                disposers.push(
                  controller.registerTools(owner, endpointId, {
                    definitions: input.tools as ToolDefinition[],
                    ...(input.capture === true ? { capture: (context: { thread: Thread; turn: Turn; signal: AbortSignal }) => ({
                      begin: async (payload: Parameters<import("../domain/ports.js").ToolCapture["begin"]>[0]) => {
                        const value = await call("capture.begin", { ...payload, threadId: context.thread.id, turnId: context.turn.id }, context.signal);
                        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.spanId !== "string" || !value.spanId)
                          throw new ControllerError("capture_unavailable", "Capture endpoint omitted its span identity");
                        return { spanId: value.spanId };
                      },
                      finish: async (payload: Parameters<import("../domain/ports.js").ToolCapture["finish"]>[0]) => { await call("capture.finish", { ...payload, threadId: context.thread.id, turnId: context.turn.id }); },
                      observe: async (payload: Parameters<NonNullable<import("../domain/ports.js").ToolCapture["observe"]>>[0]) => { await call("capture.observe", { ...payload, threadId: context.thread.id, turnId: context.turn.id }, context.signal); },
                    }) } : {}),
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
                  }, applicationId),
                );
            } catch (error) {
              disposers.reverse().forEach((dispose) => dispose());
              throw error;
            }
            registrations.set(endpointId, () =>
              disposers.forEach((dispose) => dispose()),
            );
            return { registered: endpointId };
          },
          respond(input) {
            endpoints.respond(
              owner,
              applicationId,
              connectionId,
              String(input.id),
              input.result as Json,
              input.failed === true,
            );
          },
        });
        send({ id, result: result ?? null });
      } catch (error) {
        const code =
          error instanceof ControllerError ? error.code : "request_failed";
        send({
          id,
          error: {
            code,
            message:
              error instanceof ControllerError
                ? error.message
                : "Controller request failed",
          },
        });
        if (!session)
          socket.close(
            code === "protocol_unsupported" ? 4402 : 4401,
            code === "protocol_unsupported"
              ? "protocol_unsupported"
              : "authentication_failed",
          );
      } finally {
        inFlight--;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, options.bind ?? "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Controller did not bind TCP");
  const bind = options.bind ?? "127.0.0.1";
  return {
    url: `ws://${bind.includes(":") ? `[${bind}]` : bind}:${address.port}`,
    disconnectClients: () => {
      for (const client of wss.clients) client.close(1012, "reconnect");
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
type Connection = {
  subscribe(threadId: string, after?: string): unknown;
  unsubscribe(threadId: string): void;
  register(input: Record<string, unknown>): unknown;
  respond(input: Record<string, unknown>): void;
  unregister(id: string): void;
};
function dispatch(
  method: string,
  p: Record<string, unknown>,
  session: AuthSession,
  controller: Controller,
  connection: Connection,
): unknown {
  requireScope(session, method, p);
  const store = controller.store;
  const owner = session.principalId;
  const allowed = (thread: import("../contracts.js").Thread) => {
    try {
      requireResource(session, thread);
      return true;
    } catch {
      return false;
    }
  };
  let targetThread = typeof p.threadId === "string" ? p.threadId : undefined;
  if (typeof p.turnId === "string")
    targetThread = store.turn(p.turnId)?.threadId;
  if (method === "interactions.respond")
    targetThread = store.interaction(String(p.id))?.threadId;
  if (method === "commands.get")
    targetThread = store.receipt(owner, String(p.commandId))?.threadId;
  if (targetThread) requireResource(session, store.authorizeThread(owner, targetThread));
  switch (method) {
    case "interactions.list":
      store.authorizeThread(owner, String(p.threadId));
      return store.interactions(String(p.threadId));
    case "tools.list":
      return controller.inspectTools(owner, String(p.threadId));
    case "threads.configure": {
      const thread = store.authorizeThread(owner, String(p.threadId));
      if (
        !controller.providers.get(thread.provider)?.capabilities.configuration
      )
        throw new ControllerError(
          "unsupported_configuration",
          "Provider does not support configuration",
        );
      return store.configure(
        owner,
        thread.id,
        Number(p.version),
        p.configuration as import("../contracts.js").ProviderConfig,
      );
    }
    case "providers.models": {
      if (
        !session.providers.includes(String(p.provider)) ||
        !session.workspaces.includes(String(p.workspace))
      )
        throw new ControllerError(
          "forbidden",
          "Provider or workspace is not authorized",
        );
      const provider = controller.providers.get(String(p.provider));
      if (!provider?.models)
        throw new ControllerError(
          "unsupported_discovery",
          "Provider does not support model discovery",
        );
      return provider.models(String(p.workspace));
    }
    case "system.status":
      return {
        protocol: PROTOCOL,
        threads: store.threads(owner).filter(allowed).length,
        providers: session.providers,
        session: session.id,
      };
    case "providers.list":
      return session.providers.map((id) => ({
        id,
        capabilities: controller.providers.get(id)?.capabilities ?? null,
      }));
    case "threads.create": {
      if (
        !session.providers.includes(String(p.provider)) ||
        !session.workspaces.includes(String(p.workspace))
      )
        throw new ControllerError(
          "forbidden",
          "Provider or workspace is not authorized",
        );
      return store.createThread(
        owner,
        p as unknown as ThreadInput,
        session.applicationId,
      );
    }
    case "threads.list":
      return store.threads(owner).filter(allowed);
    case "threads.snapshot":
      return store.snapshot(owner, String(p.threadId));
    case "turns.submit":
      return controller.submit(owner, p as unknown as TurnInput);
    case "turns.get":
    case "context.get":
    case "turns.cancel":
    case "turns.resolve": {
      const turn = store.turn(String(p.turnId));
      if (!turn) throw new ControllerError("not_found", "Turn not found");
      store.authorizeThread(owner, turn.threadId);
      if (method === "turns.cancel") {
        controller.cancel(owner, turn.id);
        return { requested: true };
      }
      if (method === "turns.resolve") {
        controller.resolve(
          owner,
          turn.id,
          p.outcome as "failed" | "cancelled",
          p.externalStopped === true,
        );
        return store.turn(turn.id);
      }
      return method === "context.get"
        ? (store.preparation(turn.id) ?? { unavailable: true })
        : turn;
    }
    case "commands.get":
      return store.receipt(owner, String(p.commandId)) ?? null;
    case "memory.search":
    case "memory.get":
      return controller.readMemory(
        owner,
        String(p.threadId),
        method === "memory.search" ? "search" : "get",
        p.input as Json,
      );
    case "events.read":
      return store.events(
        owner,
        String(p.threadId),
        String(p.after),
        p.limit as number | undefined,
      );
    case "events.subscribe":
      return connection.subscribe(
        String(p.threadId),
        p.after as string | undefined,
      );
    case "events.unsubscribe":
      return connection.unsubscribe(String(p.threadId));
    case "interactions.respond":
      return controller.respond(owner, String(p.id), p.response as Json);
    case "endpoints.register":
      return connection.register(p);
    case "endpoints.respond":
      return connection.respond(p);
    case "endpoints.unregister":
      return connection.unregister(String(p.id));
    default:
      throw new ControllerError("method_unknown", "Unknown operation");
  }
}
function validContext(block: Json): boolean {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  return (
    typeof block.id === "string" &&
    typeof block.revision === "string" &&
    typeof block.content === "string" &&
    block.content.length <= 100_000 &&
    ["instructions", "handoff", "memory", "application"].includes(
      String(block.kind),
    ) &&
    ["instructions", "reference"].includes(String(block.trust))
  );
}
function validCandidate(item: Json): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  return (
    typeof item.ref === "string" &&
    typeof item.revision === "string" &&
    typeof item.content === "string" &&
    item.content.length <= 100_000 &&
    typeof item.active === "boolean" &&
    typeof item.curated === "boolean" &&
    ["owner", "agent", "untrusted", "system"].includes(String(item.origin)) &&
    Array.isArray(item.provenance) &&
    item.provenance.every((value) => typeof value === "string")
  );
}
