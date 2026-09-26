import { requireResource } from "../auth/authorize.js";
import { requireScope } from "../auth/scopes.js";
import {
  ControllerError,
  PROTOCOL,
  type AuthSession,
  type Json,
  type ThreadInput,
  type TurnInput,
} from "../contracts.js";
import type { Controller } from "../domain/engine.js";

export type Connection = {
  subscribe(threadId: string, after?: string): unknown;
  unsubscribe(threadId: string): void;
  register(input: Record<string, unknown>): unknown;
  respond(input: Record<string, unknown>): void;
  unregister(id: string): void;
};

export function dispatch(
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
  if (typeof p.turnId === "string") {
    const turnThread = store.turn(p.turnId)?.threadId;
    if (targetThread && turnThread && targetThread !== turnThread)
      throw new ControllerError(
        "scope_conflict",
        "Turn and thread scope do not match",
      );
    targetThread = turnThread ?? targetThread;
  }
  if (method === "interactions.respond")
    targetThread = store.interaction(String(p.id))?.threadId;
  if (method === "commands.get")
    targetThread = store.receipt(owner, String(p.commandId))?.threadId;
  if (targetThread)
    requireResource(session, store.authorizeThread(owner, targetThread));
  switch (method) {
    case "transcript.replay":
      return controller.replayTranscript(
        owner,
        String(p.threadId),
        Number(p.afterSequence ?? 0),
        typeof p.turnId === "string" ? p.turnId : undefined,
      );
    case "interactions.list":
      store.authorizeThread(owner, String(p.threadId));
      return store.interactions(String(p.threadId));
    case "tools.list":
      return controller.inspectTools(owner, String(p.threadId));
    case "threads.configure": {
      const thread = store.authorizeThread(owner, String(p.threadId));
      if (!controller.providers.get(thread.provider)?.capabilities.configuration)
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
      return provider.models(
        String(p.workspace),
        typeof p.sessionId === "string" && p.sessionId.trim()
          ? { sessionId: p.sessionId.trim() }
          : undefined,
      );
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
    case "providers.resources": {
      const id = String(p.provider);
      if (!session.providers.includes(id))
        throw new ControllerError("forbidden", "Provider is not authorized");
      const provider = controller.providers.get(id);
      if (!provider)
        throw new ControllerError("provider_unavailable", "Provider unavailable");
      return provider.resources?.() ?? {
        status: "unavailable",
        observedAt: Date.now(),
        workers: { busy: 0, idle: 0, starting: 0, stopping: 0 },
        sessions: 0,
        rssBytes: null,
      };
    }
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
    case "turns.continue":
      return controller.continueTurn(
        owner,
        p as unknown as import("../contracts.js").ContinueInput,
      );
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
