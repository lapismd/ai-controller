import { Ajv } from "ajv";
import type { Json, Receipt, TurnInput } from "../contracts.js";
import { ControllerStore } from "../persistence/store.js";
import {
  inspectTools,
  readMemory,
  registerContext,
  registerMcp,
  registerMemory,
  registerTools,
  registerTranscript,
} from "./engine-endpoints.js";
import type { ControllerHost } from "./engine-host.js";
import { respondToInteraction } from "./engine-respond.js";
import {
  closeController,
  drainController,
  scheduleController,
} from "./engine-schedule.js";
import { replayTranscript } from "./engine-transcript.js";
import {
  cancelTurn,
  continueTurn,
  resolveTurn,
  submitTurn,
} from "./engine-turns.js";
import { InteractionLifecycle } from "./interaction-lifecycle.js";
import type {
  ContextSource,
  ExecutionProvider,
  MemoryEndpoint,
  McpEndpoint,
  ToolCapture,
  ToolEndpoint,
  TranscriptEndpoint,
} from "./ports.js";

export class Controller {
  readonly #host: ControllerHost;

  constructor(
    readonly store: ControllerStore,
    readonly providers: Map<string, ExecutionProvider>,
    readonly concurrency = 4,
    capture?: ToolCapture,
  ) {
    this.#host = {
      store,
      providers,
      concurrency,
      transcripts: new Map(),
      captures: new Map(),
      mcp: new Map(),
      sources: new Map(),
      tools: new Map(),
      memory: new Map(),
      active: new Map(),
      interactionLifecycle: new InteractionLifecycle(),
      responses: new Map(),
      ajv: new Ajv({ strict: false, allErrors: true }),
      capture,
      closing: false,
      scheduled: false,
    };
  }

  inspectTools(owner: string, threadId: string) {
    return inspectTools(this.#host, owner, threadId);
  }

  start(): void {
    this.store.recover();
    scheduleController(this.#host);
  }

  registerTranscript(
    owner: string,
    id: string,
    endpoint: TranscriptEndpoint,
    applicationId = owner,
  ): () => void {
    return registerTranscript(this.#host, owner, id, endpoint, applicationId);
  }

  replayTranscript(
    owner: string,
    threadId: string,
    afterSequence = 0,
    turnId?: string,
  ) {
    return replayTranscript(
      this.#host,
      owner,
      threadId,
      afterSequence,
      turnId,
    );
  }

  registerMcp(
    owner: string,
    id: string,
    endpoint: McpEndpoint,
    applicationId = owner,
  ): () => void {
    return registerMcp(this.#host, owner, id, endpoint, applicationId);
  }

  registerMemory(
    owner: string,
    id: string,
    endpoint: MemoryEndpoint,
    applicationId = owner,
  ): () => void {
    return registerMemory(this.#host, owner, id, endpoint, applicationId);
  }

  readMemory(
    owner: string,
    threadId: string,
    operation: "search" | "get",
    input: Json,
    signal = new AbortController().signal,
  ): Promise<Json> {
    return readMemory(this.#host, owner, threadId, operation, input, signal);
  }

  registerContext(
    owner: string,
    id: string,
    source: ContextSource,
    applicationId = owner,
  ): () => void {
    return registerContext(this.#host, owner, id, source, applicationId);
  }

  registerTools(
    owner: string,
    id: string,
    endpoint: ToolEndpoint,
    applicationId = owner,
  ): () => void {
    return registerTools(this.#host, owner, id, endpoint, applicationId);
  }

  continueTurn(
    owner: string,
    input: import("../contracts.js").ContinueInput,
  ): Receipt {
    return continueTurn(this.#host, owner, input);
  }

  submit(owner: string, input: TurnInput): Receipt {
    return submitTurn(this.#host, owner, input);
  }

  cancel(owner: string, turnId: string): void {
    cancelTurn(this.#host, owner, turnId);
  }

  resolve(
    owner: string,
    turnId: string,
    outcome: "failed" | "cancelled",
    externalStopped: boolean,
  ): void {
    resolveTurn(this.#host, owner, turnId, outcome, externalStopped);
  }

  respond(
    owner: string,
    id: string,
    response: Json,
    resolution: "owner" | "automatic" = "owner",
  ): void {
    respondToInteraction(this.#host, owner, id, response, resolution);
  }

  drain(): Promise<void> {
    return drainController(this.#host);
  }

  close(): Promise<void> {
    return closeController(this.#host);
  }
}
