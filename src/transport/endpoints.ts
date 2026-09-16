import { randomUUID } from "node:crypto";
import {
  ControllerError,
  type EndpointRequest,
  type Json,
} from "../contracts.js";

export class EndpointRegistry {
  readonly #entries = new Map<
    string,
    { connectionId: string; send(request: EndpointRequest): void }
  >();
  readonly #pending = new Map<
    string,
    {
      key: string;
      connectionId: string;
      resolve(value: Json): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  register(
    owner: string,
    id: string,
    connectionId: string,
    send: (request: EndpointRequest) => void,
  ): () => void {
    const key = `${owner}:${id}`;
    const previous = this.#entries.get(key);
    if (previous && previous.connectionId !== connectionId)
      throw new ControllerError(
        "endpoint_owned",
        "Endpoint already has a connected owner",
      );
    const entry = { connectionId, send };
    this.#entries.set(key, entry);
    return () => {
      if (this.#entries.get(key) !== entry) return;
      this.#entries.delete(key);
      for (const [requestId, pending] of this.#pending)
        if (pending.key === key && pending.connectionId === connectionId) {
          clearTimeout(pending.timer);
          this.#pending.delete(requestId);
          pending.reject(
            new ControllerError(
              "endpoint_disconnected",
              "Endpoint disconnected; effect outcome may be unknown",
            ),
          );
        }
    };
  }
  request(
    owner: string,
    endpoint: string,
    operation: string,
    payload: Json,
    timeoutMs = 30_000,
  ): Promise<Json> {
    const key = `${owner}:${endpoint}`;
    const entry = this.#entries.get(key);
    if (!entry)
      return Promise.reject(
        new ControllerError("endpoint_unavailable", "Endpoint is disconnected"),
      );
    if (this.#pending.size >= 128)
      return Promise.reject(
        new ControllerError("endpoint_busy", "Endpoint queue is full"),
      );
    const id = randomUUID();
    const deadline = Date.now() + timeoutMs;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new ControllerError(
            "endpoint_timeout",
            "Endpoint result deadline expired",
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        key,
        connectionId: entry.connectionId,
        resolve,
        reject,
        timer,
      });
      try {
        entry.send({ id, endpoint, operation, payload, deadline });
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(
          new ControllerError(
            "endpoint_disconnected",
            "Endpoint delivery failed",
          ),
        );
      }
    });
  }
  respond(
    owner: string,
    connectionId: string,
    id: string,
    result: Json,
    failed = false,
  ): void {
    const pending = this.#pending.get(id);
    if (
      !pending ||
      !pending.key.startsWith(`${owner}:`) ||
      pending.connectionId !== connectionId
    )
      throw new ControllerError(
        "endpoint_stale",
        "Endpoint request is no longer owned by this connection",
      );
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (failed)
      pending.reject(
        new ControllerError("endpoint_failed", "Endpoint execution failed"),
      );
    else pending.resolve(result);
  }
}
