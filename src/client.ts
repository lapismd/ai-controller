import {
  ControllerError,
  PROTOCOL,
  type ControllerEvent,
  type EndpointRequest,
  type Json,
  type Receipt,
  type Snapshot,
  type Thread,
  type ThreadInput,
  type ToolDefinition,
  type Turn,
  type TurnInput,
} from "./contracts.js";

export interface EndpointRegistration {
  id: string;
  context?: boolean;
  mcp?: boolean;
  required?: boolean;
  tools?: ToolDefinition[];
  memory?: { profile: "lapis-v1" | "nostr-v1" };
  handle(request: EndpointRequest, signal: AbortSignal): Promise<Json>;
}
type Subscription = {
  snapshot?: Snapshot;
  buffered: ControllerEvent[];
  initializing: boolean;
  synchronizing?: Promise<void>;
  listeners: Set<(snapshot: Snapshot, event?: ControllerEvent) => void>;
};
export class ControllerClient {
  #socket?: WebSocket;
  #connecting?: Promise<void>;
  #disposed = false;
  #attempt = 0;
  #reconnect?: ReturnType<typeof setTimeout>;
  readonly #pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #endpoints = new Map<string, EndpointRegistration>();
  readonly #handlers = new Map<string, AbortController>();
  constructor(
    readonly options: {
      url: string;
      token: string | (() => Promise<string>);
      timeoutMs?: number;
      websocket?: typeof WebSocket;
      onState?(state: "connecting" | "ready" | "offline" | "closed"): void;
      onError?(error: Error): void;
    },
  ) {}
  async connect(): Promise<void> {
    if (this.#disposed)
      throw new ControllerError("client_closed", "Client is closed");
    if (this.#connecting) return this.#connecting;
    if (this.#socket?.readyState === 1) return;
    this.#connecting = this.open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }
  async request<T = Json>(method: string, params: unknown = {}): Promise<T> {
    await this.connect();
    return this.send(method, params) as Promise<T>;
  }
  createThread(input: ThreadInput): Promise<Thread> {
    return this.request("threads.create", input);
  }
  submit(input: TurnInput): Promise<Receipt> {
    return this.request("turns.submit", input);
  }
  getTurn(turnId: string): Promise<Turn> {
    return this.request("turns.get", { turnId });
  }
  snapshot(threadId: string): Promise<Snapshot> {
    return this.request("threads.snapshot", { threadId });
  }
  cancel(turnId: string): Promise<unknown> {
    return this.request("turns.cancel", { turnId });
  }
  resolveTurn(
    turnId: string,
    outcome: "failed" | "cancelled",
    confirmation: { externalStopped: true },
  ): Promise<Turn> {
    return this.request("turns.resolve", {
      turnId,
      outcome,
      externalStopped: confirmation.externalStopped,
    });
  }
  respond(id: string, response: Json): Promise<unknown> {
    return this.request("interactions.respond", { id, response });
  }
  async registerEndpoint(
    registration: EndpointRegistration,
  ): Promise<() => Promise<void>> {
    if (this.#endpoints.has(registration.id))
      throw new ControllerError(
        "endpoint_owned",
        "Client endpoint is already registered",
      );
    await this.connect();
    this.#endpoints.set(registration.id, registration);
    try {
      await this.register(registration);
    } catch (error) {
      this.#endpoints.delete(registration.id);
      throw error;
    }
    return async () => {
      if (!this.#endpoints.delete(registration.id)) return;
      if (this.#socket?.readyState === 1)
        await this.send("endpoints.unregister", { id: registration.id });
    };
  }
  /** Ordered durable delivery for applications that commit their own domain projection.
   * Failed observers retry the same event; commands are never resubmitted.
   */
  async subscribeJournal(
    threadId: string,
    options: {
      after?: string;
      afterSequence?: number;
      onError?(error: unknown): void;
    },
    listener: (event: ControllerEvent) => void | Promise<void>,
  ): Promise<() => void> {
    let cursor = options.after;
    let target: string | undefined;
    let stopped = false;
    let pumping = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const pump = () => {
      if (pumping || stopped || retry || !target) return;
      pumping = true;
      void (async () => {
        cursor ??= `${target!.split(":")[0]}:${options.afterSequence ?? 0}`;
        while (!stopped && cursorAfter(target!, cursor!)) {
          const barrier = target!;
          const page: ControllerEvent[] = await this.request<ControllerEvent[]>(
            "events.read",
            { threadId, after: cursor, limit: 1000 },
          );
          for (const event of page) {
            if (stopped || cursorAfter(event.cursor, barrier)) break;
            if (!cursorAfter(event.cursor, cursor!)) continue;
            await listener(event);
            cursor = event.cursor;
          }
          if (
            !page.length ||
            (page.length < 1000 && !cursorAfter(page.at(-1)!.cursor, barrier))
          )
            cursor = barrier;
        }
      })()
        .catch((error) => {
          options.onError?.(error);
          if (!stopped)
            retry = setTimeout(() => {
              retry = undefined;
              pump();
            }, 1000);
        })
        .finally(() => {
          pumping = false;
        });
    };
    const unsubscribe = await this.subscribe(threadId, (snapshot) => {
      target = snapshot.cursor;
      pump();
    });
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      unsubscribe();
    };
  }
  async subscribe(
    threadId: string,
    listener: (snapshot: Snapshot, event?: ControllerEvent) => void,
  ): Promise<() => void> {
    let subscription = this.#subscriptions.get(threadId);
    if (!subscription) {
      subscription = { buffered: [], initializing: true, listeners: new Set() };
      this.#subscriptions.set(threadId, subscription);
    }
    subscription.listeners.add(listener);
    await this.connect();
    if (!subscription.snapshot || subscription.initializing)
      await this.synchronize(threadId, subscription);
    else this.notify(subscription, listener);
    return () => {
      subscription!.listeners.delete(listener);
      if (!subscription!.listeners.size) {
        this.#subscriptions.delete(threadId);
        if (!this.#disposed)
          void this.request("events.unsubscribe", { threadId }).catch(() => {});
      }
    };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#socket?.close(1000, "client_closed");
    this.#socket = undefined;
    this.failPending();
    this.#subscriptions.clear();
    this.#endpoints.clear();
    for (const handler of this.#handlers.values()) handler.abort();
    this.#handlers.clear();
    this.options.onState?.("closed");
  }
  private async open(): Promise<void> {
    this.options.onState?.("connecting");
    const token =
      typeof this.options.token === "function"
        ? await this.options.token()
        : this.options.token;
    if (this.#disposed)
      throw new ControllerError("client_closed", "Client is closed");
    const Socket = this.options.websocket ?? WebSocket;
    const socket = new Socket(this.options.url);
    this.#socket = socket;
    socket.addEventListener("message", (event) =>
      this.receive(socket, String(event.data)),
    );
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      for (const handler of this.#handlers.values()) handler.abort();
      this.#handlers.clear();
      this.failPending();
      if (!this.#disposed) {
        this.options.onState?.("offline");
        if (event.code !== 4401) this.retry();
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
      }, this.options.timeoutMs ?? 10_000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(
            new ControllerError(
              "connection_failed",
              "Controller connection failed",
            ),
          );
        },
        { once: true },
      );
    });
    try {
      await this.send("hello", undefined, { token, protocol: PROTOCOL });
      for (const registration of this.#endpoints.values())
        await this.register(registration);
      for (const [threadId, subscription] of this.#subscriptions)
        await this.synchronize(threadId, subscription);
      this.#attempt = 0;
      this.options.onState?.("ready");
    } catch (error) {
      socket.close();
      throw error;
    }
  }
  private send(
    method: string,
    params?: unknown,
    extra?: object,
  ): Promise<unknown> {
    if (this.#socket?.readyState !== 1)
      return Promise.reject(
        new ControllerError("disconnected", "Controller is disconnected"),
      );
    if (this.#pending.size >= 128)
      return Promise.reject(
        new ControllerError("client_busy", "Too many pending requests"),
      );
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new ControllerError(
            "request_timeout",
            "Request acknowledgement timed out; inspect its command receipt",
          ),
        );
      }, this.options.timeoutMs ?? 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket!.send(JSON.stringify({ id, method, params, ...extra }));
    });
  }
  private receive(socket: WebSocket, raw: string): void {
    if (this.#socket !== socket || this.#disposed) return;
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
      this.#handlers.get(frame.id)?.abort();
      this.#handlers.delete(frame.id);
    } else if (typeof frame.id === "string") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(frame.id);
      const error = frame.error as
        { code: string; message: string } | undefined;
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
      const subscription = this.#subscriptions.get(event.threadId);
      if (!subscription) return;
      if (subscription.initializing) {
        subscription.buffered.push(event);
        if (subscription.buffered.length > 1000)
          socket.close(4408, "resnapshot_required");
      } else {
        try {
          this.apply(subscription, event);
        } catch {
          socket.close(4408, "resnapshot_required");
        }
      }
    } else if (frame.type === "endpoint.request") {
      const request = frame.request as EndpointRequest;
      if (
        !request ||
        typeof request.endpoint !== "string" ||
        typeof request.operation !== "string" ||
        !Number.isFinite(request.deadline)
      ) {
        socket.close(4400, "invalid_endpoint_request");
        return;
      }
      const endpoint = this.#endpoints.get(request.endpoint);
      const abort = new AbortController();
      this.#handlers.set(request.id, abort);
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
        this.#handlers.delete(request.id);
        // A result never reconnects or migrates to another connection generation.
        if (
          !abort.signal.aborted &&
          this.#socket === socket &&
          socket.readyState === 1
        )
          await this.send("endpoints.respond", {
            id: request.id,
            result,
            failed,
          }).catch(() => {});
      })();
    }
  }
  private async register(registration: EndpointRegistration): Promise<void> {
    const { handle: _handle, ...manifest } = registration;
    await this.send("endpoints.register", manifest);
  }
  private synchronize(
    threadId: string,
    subscription: Subscription,
  ): Promise<void> {
    if (subscription.synchronizing) return subscription.synchronizing;
    subscription.synchronizing = this.synchronizeOnce(
      threadId,
      subscription,
    ).finally(() => {
      subscription.synchronizing = undefined;
    });
    return subscription.synchronizing;
  }
  private async synchronizeOnce(
    threadId: string,
    subscription: Subscription,
  ): Promise<void> {
    subscription.initializing = true;
    subscription.buffered = [];
    const result = (await this.send("events.subscribe", { threadId })) as {
      snapshot: Snapshot;
    };
    if (this.#subscriptions.get(threadId) !== subscription) return;
    subscription.snapshot = result.snapshot;
    subscription.initializing = false;
    for (const event of subscription.buffered.splice(0))
      this.apply(subscription, event);
    for (const listener of subscription.listeners)
      this.notify(subscription, listener);
  }
  private apply(subscription: Subscription, event: ControllerEvent): void {
    if (
      !subscription.snapshot ||
      !cursorAfter(event.cursor, subscription.snapshot.cursor)
    )
      return;
    subscription.snapshot = reduceSnapshot(subscription.snapshot, event);
    for (const listener of subscription.listeners)
      this.notify(subscription, listener, event);
  }
  private notify(
    subscription: Subscription,
    listener: (snapshot: Snapshot, event?: ControllerEvent) => void,
    event?: ControllerEvent,
  ): void {
    try {
      listener(structuredClone(subscription.snapshot!), event);
    } catch (error) {
      this.options.onError?.(
        error instanceof Error
          ? error
          : new Error("Subscription observer failed"),
      );
    }
  }
  private failPending(): void {
    for (const item of this.#pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new ControllerError(
          "disconnected",
          "Connection lost; resolve mutation receipts before retrying",
        ),
      );
    }
    this.#pending.clear();
  }
  private retry(): void {
    if (
      this.#reconnect ||
      this.#disposed ||
      (!this.#subscriptions.size && !this.#endpoints.size)
    )
      return;
    const wait =
      Math.min(10_000, 100 * 2 ** this.#attempt++) +
      Math.floor(Math.random() * 50);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      void this.connect().catch(() => this.retry());
    }, wait);
  }
}
export function reduceSnapshot(
  snapshot: Snapshot,
  event: ControllerEvent,
): Snapshot {
  const next = structuredClone(snapshot);
  next.cursor = event.cursor;
  const data = event.data as Record<string, Json>;
  if (event.type === "thread.configured") {
    next.thread.version = Number(data.version);
    next.thread.configuration = data.configuration as Thread["configuration"];
  }
  if (event.type === "output.activity" || event.type === "output.text") {
    next.transcript.push(event);
    if (next.transcript.length > 2000) {
      next.transcript.shift();
      next.transcriptTruncated = true;
    }
  }
  if (
    event.type === "session.bound" &&
    typeof data.nativeSessionId === "string"
  )
    next.thread.nativeSessionId = data.nativeSessionId;
  let turn = next.turns.find((item) => item.id === event.turnId);
  if (event.type === "turn.accepted" && !turn && event.turnId) {
    // Full accepted-turn identity is supplied in the event envelope below.
    const record = data.turn as unknown as Turn | undefined;
    if (record) {
      next.turns.push(record);
      turn = record;
    }
  }
  if (turn && event.type === "output.text" && typeof data.text === "string")
    turn.output = (turn.output ?? "") + data.text;
  if (turn && event.type === "turn.state") {
    turn.state = data.state as Turn["state"];
    turn.updatedAt = event.at;
    if (typeof data.error === "string") turn.error = data.error;
  }
  if (turn && event.type === "turn.cancel_requested")
    turn.cancelRequested = true;
  if (event.type === "interaction.updated" && typeof data.id === "string") {
    const index = next.interactions.findIndex((item) => item.id === data.id);
    if (index < 0)
      next.interactions.push(
        event.data as unknown as Snapshot["interactions"][number],
      );
    else
      next.interactions[index] =
        event.data as unknown as Snapshot["interactions"][number];
  }
  return next;
}
function cursorAfter(a: string, b: string): boolean {
  const [epochA, offsetA] = a.split(":");
  const [epochB, offsetB] = b.split(":");
  if (epochA !== epochB)
    throw new ControllerError("resnapshot_required", "Stream epoch changed");
  return Number(offsetA) > Number(offsetB);
}
