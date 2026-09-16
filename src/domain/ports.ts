import type {
  Capabilities,
  ContextBlock,
  Json,
  Preparation,
  Thread,
  ToolDefinition,
  ToolResult,
  Turn,
} from "../contracts.js";
import type { MemoryCandidate, MemoryProfile } from "../memory/recall.js";

export type RuntimeEvent =
  | { type: "text"; text: string; sourceId?: string }
  | { type: "activity"; data: Json; sourceId?: string }
  | {
      type: "approval" | "input";
      nativeId: string;
      request: Json;
      deadline: number;
    }
  | { type: "completed"; outcome?: "completed" | "cancelled" }
  | { type: "failed"; code: string };
export interface ExecutionContext {
  thread: Thread;
  turn: Turn;
  preparation: Preparation;
  tools: ToolDefinition[];
  signal: AbortSignal;
  emit(event: RuntimeEvent): Promise<void>;
  bindSession(id: string): Promise<void>;
  callTool(
    name: string,
    input: Json,
    nativeInvocationId?: string,
  ): Promise<ToolResult>;
  interact(
    kind: "approval" | "input",
    nativeId: string,
    request: Json,
    deadline: number,
  ): Promise<Json>;
}
export interface ExecutionProvider {
  capabilities: Capabilities;
  execute(context: ExecutionContext): Promise<void>;
  close(): Promise<void>;
}
export interface ContextSource {
  required: boolean;
  resolve(
    thread: Thread,
    turn: Turn,
    signal: AbortSignal,
  ): Promise<ContextBlock[] | { blocks: ContextBlock[]; omitted?: string }>;
  authorize(
    thread: Thread,
    blocks: ContextBlock[],
    signal: AbortSignal,
  ): Promise<boolean>;
}
export interface ToolEndpoint {
  definitions: ToolDefinition[];
  execute(
    name: string,
    input: Json,
    context: {
      invocationId: string;
      thread: Thread;
      turn: Turn;
      signal: AbortSignal;
    },
  ): Promise<ToolResult>;
}
export interface MemoryEndpoint {
  profile: MemoryProfile;
  candidates(
    thread: Thread,
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryCandidate[]>;
  authorize(
    thread: Thread,
    refs: Array<{ ref: string; revision: string }>,
    signal: AbortSignal,
  ): Promise<boolean>;
  read(
    thread: Thread,
    operation: "search" | "get",
    input: Json,
    signal: AbortSignal,
  ): Promise<Json>;
}
