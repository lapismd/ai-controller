import {
  ControllerError,
  type Json,
  type Receipt,
  type Snapshot,
  type Thread,
  type ThreadInput,
  type Turn,
  type TurnInput,
} from "./contracts.js";
import type {
  ClientHost,
  ClientOptions,
  EndpointRegistration,
} from "./client-host.js";
import { subscribeJournal, subscribeThread, synchronizeSubscription } from "./client-subscribe.js";
import {
  failPending,
  openSocket,
  registerEndpointManifest,
  sendRequest,
} from "./client-transport.js";

export type { EndpointRegistration } from "./client-host.js";
export { reduceSnapshot } from "./client-snapshot.js";

export class ControllerClient {
  readonly #host: ClientHost;

  get sessionId(): string | undefined {
    return this.#host.sessionId;
  }

  constructor(readonly options: ClientOptions) {
    this.#host = {
      options,
      disposed: false,
      attempt: 0,
      pending: new Map(),
      subscriptions: new Map(),
      endpoints: new Map(),
      handlers: new Map(),
      authFallback: false,
    };
  }

  async connect(): Promise<void> {
    if (this.#host.disposed)
      throw new ControllerError("client_closed", "Client is closed");
    if (this.#host.connecting) return this.#host.connecting;
    if (this.#host.socket?.readyState === 1) return;
    this.#host.connecting = openSocket(
      this.#host,
      (threadId, subscription) =>
        synchronizeSubscription(this.#host, threadId, subscription),
      () => this.connect(),
    ).finally(() => {
      this.#host.connecting = undefined;
    });
    return this.#host.connecting;
  }

  async request<T = Json>(method: string, params: unknown = {}): Promise<T> {
    await this.connect();
    return sendRequest(this.#host, method, params) as Promise<T>;
  }

  createThread(input: ThreadInput): Promise<Thread> {
    return this.request("threads.create", input);
  }
  submit(input: TurnInput): Promise<Receipt> {
    return this.request("turns.submit", input);
  }
  continueTurn(input: import("./contracts.js").ContinueInput): Promise<Receipt> {
    return this.request("turns.continue", input);
  }
  getTurn(turnId: string): Promise<Turn> {
    return this.request("turns.get", { turnId });
  }
  snapshot(threadId: string): Promise<Snapshot> {
    return this.request("threads.snapshot", { threadId });
  }
  replayTranscript(
    threadId: string,
    afterSequence = 0,
    turnId?: string,
  ): Promise<import("./transcript-contracts.js").TranscriptPage> {
    return this.request("transcript.replay", {
      threadId,
      afterSequence,
      ...(turnId ? { turnId } : {}),
    });
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
    if (this.#host.endpoints.has(registration.id))
      throw new ControllerError(
        "endpoint_owned",
        "Client endpoint is already registered",
      );
    await this.connect();
    this.#host.endpoints.set(registration.id, registration);
    try {
      await registerEndpointManifest(this.#host, registration);
    } catch (error) {
      this.#host.endpoints.delete(registration.id);
      throw error;
    }
    return async () => {
      if (!this.#host.endpoints.delete(registration.id)) return;
      if (this.#host.socket?.readyState === 1)
        await sendRequest(this.#host, "endpoints.unregister", {
          id: registration.id,
        });
    };
  }

  subscribeJournal(
    threadId: string,
    options: {
      after?: string;
      afterSequence?: number;
      onError?(error: unknown): void;
    },
    listener: (event: import("./contracts.js").ControllerEvent) => void | Promise<void>,
  ): Promise<() => void> {
    return subscribeJournal(
      this.#host,
      () => this.connect(),
      (id, next) => this.subscribe(id, next),
      threadId,
      options,
      listener,
    );
  }

  subscribe(
    threadId: string,
    listener: (
      snapshot: Snapshot,
      event?: import("./contracts.js").ControllerEvent,
    ) => void,
  ): Promise<() => void> {
    return subscribeThread(this.#host, () => this.connect(), threadId, listener);
  }

  dispose(): void {
    if (this.#host.disposed) return;
    this.#host.disposed = true;
    if (this.#host.reconnect) clearTimeout(this.#host.reconnect);
    this.#host.socket?.close(1000, "client_closed");
    this.#host.socket = undefined;
    failPending(this.#host);
    this.#host.subscriptions.clear();
    this.#host.endpoints.clear();
    for (const handler of this.#host.handlers.values()) handler.abort();
    this.#host.handlers.clear();
    this.options.onState?.("closed");
  }
}
