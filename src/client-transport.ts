import { ControllerError, PROTOCOL, type ControllerEvent, type EndpointRequest, type Json } from "./contracts.js";
import { applySubscriptionEvent } from "./client-apply.js";
import type { ClientHost, EndpointRegistration, Subscription } from "./client-host.js";

export function sendRequest(
  host: ClientHost,
  method: string,
  params?: unknown,
  extra?: object,
): Promise<unknown> {
  if (host.socket?.readyState !== 1)
    return Promise.reject(
      new ControllerError("disconnected", "Controller is disconnected"),
    );
  if (host.pending.size >= 128)
    return Promise.reject(
      new ControllerError("client_busy", "Too many pending requests"),
    );
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      host.pending.delete(id);
      reject(
        new ControllerError(
          "request_timeout",
          "Request acknowledgement timed out; inspect its command receipt",
        ),
      );
    }, host.options.timeoutMs ?? 30_000);
    host.pending.set(id, { resolve, reject, timer });
    host.socket!.send(JSON.stringify({ id, method, params, ...extra }));
  });
}

export function failPending(host: ClientHost): void {
  for (const item of host.pending.values()) {
    clearTimeout(item.timer);
    item.reject(
      new ControllerError(
        "disconnected",
        "Connection lost; resolve mutation receipts before retrying",
      ),
    );
  }
  host.pending.clear();
}

export function retryConnect(host: ClientHost, connect: () => Promise<void>): void {
  if (
    host.reconnect ||
    host.disposed ||
    (!host.subscriptions.size && !host.endpoints.size)
  )
    return;
  const wait =
    Math.min(10_000, 100 * 2 ** host.attempt++) + Math.floor(Math.random() * 50);
  host.reconnect = setTimeout(() => {
    host.reconnect = undefined;
    void connect().catch(() => retryConnect(host, connect));
  }, wait);
}

export function receiveFrame(
  host: ClientHost,
  socket: WebSocket,
  raw: string,
): void {
  if (host.socket !== socket || host.disposed) return;
  let frame: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid frame");
    frame = value as Record<string, unknown>;
  } catch {
    socket.close(4400, "invalid_frame");
    return;
  }
  if (frame.type === "endpoint.cancel" && typeof frame.id === "string") {
    host.handlers.get(frame.id)?.abort();
    host.handlers.delete(frame.id);
  } else if (typeof frame.id === "string") {
    const pending = host.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    host.pending.delete(frame.id);
    const error = frame.error as { code: string; message: string } | undefined;
    if (error) pending.reject(new ControllerError(error.code, error.message));
    else pending.resolve(frame.result);
  } else if (frame.type === "event") {
    const event = frame.event as ControllerEvent;
    if (
      !event ||
      typeof event.threadId !== "string" ||
      typeof event.cursor !== "string" ||
      typeof event.type !== "string" ||
      !event.data ||
      typeof event.data !== "object"
    ) {
      socket.close(4400, "invalid_event");
      return;
    }
    const subscription = host.subscriptions.get(event.threadId);
    if (!subscription) return;
    if (subscription.initializing) {
      subscription.buffered.push(event);
      if (subscription.buffered.length > 1000)
        socket.close(4408, "resnapshot_required");
    } else {
      try {
        applySubscriptionEvent(host, subscription, event);
      } catch {
        socket.close(4408, "resnapshot_required");
      }
    }
  } else if (frame.type === "endpoint.request") {
    handleEndpointRequest(host, socket, frame.request as EndpointRequest);
  }
}

function handleEndpointRequest(
  host: ClientHost,
  socket: WebSocket,
  request: EndpointRequest,
): void {
  if (
    !request ||
    typeof request.endpoint !== "string" ||
    typeof request.operation !== "string" ||
    !Number.isFinite(request.deadline)
  ) {
    socket.close(4400, "invalid_endpoint_request");
    return;
  }
  const endpoint = host.endpoints.get(request.endpoint);
  const abort = new AbortController();
  host.handlers.set(request.id, abort);
  void (async () => {
    let result: Json = null;
    let failed = false;
    try {
      if (!endpoint || request.deadline <= Date.now())
        throw new Error("Endpoint unavailable");
      result = await endpoint.handle(request, abort.signal);
    } catch {
      failed = true;
    }
    host.handlers.delete(request.id);
    if (
      !abort.signal.aborted &&
      host.socket === socket &&
      socket.readyState === 1
    )
      await sendRequest(host, "endpoints.respond", {
        id: request.id,
        result,
        failed,
      }).catch(() => {});
  })();
}

export async function registerEndpointManifest(
  host: ClientHost,
  registration: EndpointRegistration,
): Promise<void> {
  const { handle: _handle, ...manifest } = registration;
  await sendRequest(host, "endpoints.register", manifest);
}

export async function openSocket(
  host: ClientHost,
  synchronize: (threadId: string, subscription: Subscription) => Promise<void>,
  connect: () => Promise<void>,
): Promise<void> {
  host.options.onState?.("connecting");
  const bootstrap =
    typeof host.options.token === "function"
      ? await host.options.token()
      : host.options.token;
  const token = host.sessionToken ?? bootstrap;
  if (host.disposed)
    throw new ControllerError("client_closed", "Client is closed");
  const Socket = host.options.websocket ?? WebSocket;
  const socket = new Socket(host.options.url);
  host.socket = socket;
  socket.addEventListener("message", (event) =>
    receiveFrame(host, socket, String(event.data)),
  );
  socket.addEventListener("close", (event) => {
    if (host.socket !== socket) return;
    host.socket = undefined;
    for (const handler of host.handlers.values()) handler.abort();
    host.handlers.clear();
    failPending(host);
    if (!host.disposed) {
      host.options.onState?.("offline");
      if (event.code === 4401 && host.sessionToken && !host.authFallback) {
        host.sessionToken = undefined;
        host.authFallback = true;
        retryConnect(host, connect);
        return;
      }
      if (event.code !== 4401) retryConnect(host, connect);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(
        new ControllerError(
          "connection_timeout",
          "Controller connection timed out",
        ),
      );
    }, host.options.timeoutMs ?? 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(
        new ControllerError(
          "connection_failed",
          "Controller connection failed",
        ),
      );
    }, { once: true });
  });
  try {
    const hello = (await sendRequest(host, "hello", undefined, {
      token,
      protocol: PROTOCOL,
    })) as { session?: { id?: string; token?: string } };
    if (typeof hello.session?.id === "string") host.sessionId = hello.session.id;
    if (typeof hello.session?.token === "string")
      host.sessionToken = hello.session.token;
    host.authFallback = false;
    for (const registration of host.endpoints.values())
      await registerEndpointManifest(host, registration);
    for (const [threadId, subscription] of host.subscriptions)
      await synchronize(threadId, subscription);
    host.attempt = 0;
    host.options.onState?.("ready");
  } catch (error) {
    socket.close();
    throw error;
  }
}
