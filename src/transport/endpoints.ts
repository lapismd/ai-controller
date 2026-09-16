import { randomUUID } from "node:crypto";
import {
  ControllerError,
  type EndpointRequest,
  type Json,
} from "../contracts.js";

type Pending = {
  key: string;
  connectionId: string;
  resolve(value: Json): void;
  reject(error: Error): void;
  cancel(code: string): void;
};
export class EndpointRegistry {
  readonly #entries = new Map<
    string,
    {
      connectionId: string;
      send(request: EndpointRequest): void;
      cancel(id: string): void;
    }
  >();
  readonly #pending = new Map<string, Pending>();
  register(
    owner: string,
    id: string,
    connectionId: string,
    send: (request: EndpointRequest) => void,
    cancel: (id: string) => void = () => {},
  ): () => void {
    const key = `${owner}:${id}`;
    const previous = this.#entries.get(key);
    if (previous && previous.connectionId !== connectionId)
      throw new ControllerError(
        "endpoint_owned",
        "Endpoint already has a connected owner",
      );
    const entry = { connectionId, send, cancel };
    this.#entries.set(key, entry);
    return () => {
      if (this.#entries.get(key) !== entry) return;
      this.#entries.delete(key);
      for (const pending of [...this.#pending.values()])
        if (pending.key === key && pending.connectionId === connectionId)
          pending.cancel("endpoint_disconnected");
    };
  }
  request(
    owner: string,
    endpoint: string,
    operation: string,
    payload: Json,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<Json> {
    const key = `${owner}:${endpoint}`;
    const entry = this.#entries.get(key);
    if (!entry)
      return Promise.reject(
        new ControllerError("endpoint_unavailable", "Endpoint is disconnected"),
      );
    if (signal?.aborted)
      return Promise.reject(
        new ControllerError(
          "cancelled",
          "Endpoint request was cancelled before dispatch",
        ),
      );
    if (this.#pending.size >= 128)
      return Promise.reject(
        new ControllerError("endpoint_busy", "Endpoint queue is full"),
      );
    const id = randomUUID();
    const deadline = Date.now() + timeoutMs;
    return new Promise<Json>((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const cancel = (code: string) =>
        finish(() => {
          try {
            entry.cancel(id);
          } catch {
            /* A disconnected handler cannot receive cancellation. */
          }
          reject(
            new ControllerError(
              code,
              "Endpoint stopped before acknowledgement; effect outcome may be unknown",
            ),
          );
        });
      const abort = () => cancel("cancelled");
      const timer = setTimeout(() => cancel("endpoint_timeout"), timeoutMs);
      this.#pending.set(id, {
        key,
        connectionId: entry.connectionId,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
        cancel,
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        entry.send({ id, endpoint, operation, payload, deadline });
      } catch {
        cancel("endpoint_disconnected");
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
    if (failed)
      pending.reject(
        new ControllerError("endpoint_failed", "Endpoint execution failed"),
      );
    else pending.resolve(result);
  }
}
