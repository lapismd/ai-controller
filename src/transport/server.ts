import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  ControllerError,
  PROTOCOL,
  type AuthSession,
  type Json,
} from "../contracts.js";
import { Controller } from "../domain/engine.js";
import { EndpointRegistry } from "./endpoints.js";
import { validateRequest } from "./schema.js";
import { AuthSessionStore } from "../auth/session.js";
import { dispatch } from "./server-dispatch.js";
import { registerSocketEndpoint } from "./server-register.js";

export interface ServerCredential {
  token: string;
  principal: import("../contracts.js").Principal;
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
            const registered = registerSocketEndpoint(
              controller,
              endpoints,
              owner,
              applicationId,
              connectionId,
              send,
              input,
            );
            registrations.set(String(input.id), registered.dispose);
            return { registered: registered.registered };
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
