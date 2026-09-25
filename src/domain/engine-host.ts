import type { Ajv } from "ajv";
import type { CaptureSession } from "../capture/session.js";
import type { Json } from "../contracts.js";
import type { ControllerStore } from "../persistence/store.js";
import type { InteractionLifecycle } from "./interaction-lifecycle.js";
import type {
  ContextSource,
  ExecutionProvider,
  MemoryEndpoint,
  McpEndpoint,
  ToolCapture,
  ToolEndpoint,
  TranscriptEndpoint,
} from "./ports.js";

export type ActiveTurn = {
  promise: Promise<void>;
  abort: AbortController;
  workspace: string;
};

export type ResponseWaiter = {
  resolve(value: Json): void;
  reject(error: Error): void;
};

export type ControllerHost = {
  store: ControllerStore;
  providers: Map<string, ExecutionProvider>;
  concurrency: number;
  transcripts: Map<string, TranscriptEndpoint>;
  captures: Map<string, CaptureSession>;
  mcp: Map<string, McpEndpoint>;
  sources: Map<string, ContextSource>;
  tools: Map<string, ToolEndpoint>;
  memory: Map<string, MemoryEndpoint>;
  active: Map<string, ActiveTurn>;
  interactionLifecycle: InteractionLifecycle;
  responses: Map<string, ResponseWaiter>;
  ajv: Ajv;
  capture?: ToolCapture;
  closing: boolean;
  scheduled: boolean;
};
