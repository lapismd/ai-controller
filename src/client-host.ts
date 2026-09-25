import type {
  ControllerEvent,
  EndpointRequest,
  Json,
  Snapshot,
  ToolDefinition,
} from "./contracts.js";

export interface EndpointRegistration {
  id: string;
  context?: boolean;
  mcp?: boolean;
  required?: boolean;
  tools?: ToolDefinition[];
  capture?: boolean;
  transcript?: boolean;
  memory?: { profile: "lapis-v1" | "nostr-v1" };
  handle(request: EndpointRequest, signal: AbortSignal): Promise<Json>;
}

export type Subscription = {
  snapshot?: Snapshot;
  buffered: ControllerEvent[];
  initializing: boolean;
  synchronizing?: Promise<void>;
  listeners: Set<(snapshot: Snapshot, event?: ControllerEvent) => void>;
};

export type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export type ClientOptions = {
  url: string;
  token: string | (() => Promise<string>);
  timeoutMs?: number;
  websocket?: typeof WebSocket;
  onState?(state: "connecting" | "ready" | "offline" | "closed"): void;
  onError?(error: Error): void;
};

export type ClientHost = {
  options: ClientOptions;
  socket?: WebSocket;
  connecting?: Promise<void>;
  disposed: boolean;
  attempt: number;
  reconnect?: ReturnType<typeof setTimeout>;
  pending: Map<string, PendingRequest>;
  subscriptions: Map<string, Subscription>;
  endpoints: Map<string, EndpointRegistration>;
  handlers: Map<string, AbortController>;
  sessionToken?: string;
  sessionId?: string;
  authFallback: boolean;
};
