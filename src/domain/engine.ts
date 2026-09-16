import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import {
  ControllerError,
  isTerminal,
  type Interaction,
  type Json,
  type Receipt,
  type Thread,
  type ToolResult,
  type Turn,
  type TurnInput,
} from "../contracts.js";
import { ControllerStore } from "../persistence/store.js";
import { authorizePreparation, bounded, prepareTurn } from "./context.js";
import type {
  ContextSource,
  ExecutionProvider,
  RuntimeEvent,
  ToolEndpoint,
  MemoryEndpoint,
} from "./ports.js";
import { recallMemory } from "../memory/recall.js";

export class Controller {
  readonly #sources = new Map<string, ContextSource>();
  readonly #tools = new Map<string, ToolEndpoint>();
  readonly #memory = new Map<string, MemoryEndpoint>();
  readonly #active = new Map<
    string,
    { promise: Promise<void>; abort: AbortController; workspace: string }
  >();
  readonly #responses = new Map<
    string,
    { resolve(value: Json): void; reject(error: Error): void }
  >();
  readonly #ajv = new Ajv({ strict: false, allErrors: true });
  #closing = false;
  #scheduled = false;
  constructor(
    readonly store: ControllerStore,
    readonly providers: Map<string, ExecutionProvider>,
    readonly concurrency = 4,
  ) {}
  start(): void {
    this.store.recover();
    this.schedule();
  }
  registerMemory(
    owner: string,
    id: string,
    endpoint: MemoryEndpoint,
  ): () => void {
    const key = `${owner}:${id}`;
    this.#memory.set(key, endpoint);
    const dispose = this.registerContext(owner, `__memory.${id}`, {
      required: false,
      resolve: async (thread, turn, signal) => {
        const recalled = await recallMemory(
          {
            profile: endpoint.profile,
            candidates: (query, abort) =>
              endpoint.candidates(thread, query, abort),
            authorize: (items, abort) =>
              endpoint.authorize(thread, items, abort),
          },
          turn.text ?? "",
          signal,
        );
        return {
          blocks: recalled.blocks,
          ...(recalled.omitted ? { omitted: recalled.omitted } : {}),
        };
      },
      authorize: (thread, blocks, signal) =>
        endpoint.authorize(
          thread,
          blocks.map((block) => ({ ref: block.id, revision: block.revision })),
          signal,
        ),
    });
    return () => {
      dispose();
      if (this.#memory.get(key) === endpoint) this.#memory.delete(key);
    };
  }
  async readMemory(
    owner: string,
    threadId: string,
    operation: "search" | "get",
    input: Json,
    signal = new AbortController().signal,
  ): Promise<Json> {
    const thread = this.store.authorizeThread(owner, threadId);
    const endpoint =
      thread.memoryEndpoint &&
      this.#memory.get(`${owner}:${thread.memoryEndpoint}`);
    if (!endpoint)
      throw new ControllerError(
        "memory_unavailable",
        "Memory endpoint is unavailable",
      );
    return bounded(
      endpoint.read(thread, operation, input, signal),
      30_000,
      signal,
    );
  }
  registerContext(
    owner: string,
    id: string,
    source: ContextSource,
  ): () => void {
    const key = `${owner}:${id}`;
    this.#sources.set(key, source);
    return () => {
      if (this.#sources.get(key) === source) this.#sources.delete(key);
    };
  }
  registerTools(owner: string, id: string, endpoint: ToolEndpoint): () => void {
    const names = new Set<string>();
    for (const definition of endpoint.definitions) {
      if (names.has(definition.name))
        throw new ControllerError("invalid_tools", "Duplicate tool name");
      names.add(definition.name);
      this.#ajv.compile(definition.inputSchema);
    }
    const key = `${owner}:${id}`;
    this.#tools.set(key, endpoint);
    return () => {
      if (this.#tools.get(key) === endpoint) this.#tools.delete(key);
    };
  }
  submit(owner: string, input: TurnInput): Receipt {
    if (this.#closing)
      throw new ControllerError("stopping", "Controller is stopping");
    const thread = this.store.authorizeThread(owner, input.threadId);
    const provider = this.providers.get(thread.provider);
    if (!provider)
      throw new ControllerError(
        "provider_unavailable",
        "Provider is unavailable",
      );
    if (
      input.parts?.some(
        (part) => !provider.capabilities.content.includes(part.type),
      )
    )
      throw new ControllerError(
        "unsupported_content",
        "Provider cannot accept this content",
      );
    const receipt = this.store.accept(owner, input);
    this.schedule();
    return receipt;
  }
  cancel(owner: string, turnId: string): void {
    const turn = this.requireTurn(owner, turnId);
    if (isTerminal(turn.state)) return;
    this.store.transaction(() => {
      this.store.saveTurn({ ...turn, cancelRequested: true });
      this.store.append(
        turn.threadId,
        "turn.cancel_requested",
        {},
        turnId,
        undefined,
        true,
      );
      if (!this.#active.has(turnId)) this.store.transition(turnId, "cancelled");
    });
    this.#active.get(turnId)?.abort.abort();
  }
  respond(owner: string, id: string, response: Json): void {
    const interaction = this.store.interaction(id);
    if (!interaction)
      throw new ControllerError("not_found", "Interaction not found");
    const turn = this.requireTurn(owner, interaction.turnId);
    const waiting = this.#responses.get(id);
    if (
      isTerminal(turn.state) ||
      turn.cancelRequested ||
      interaction.state !== "pending" ||
      !waiting ||
      interaction.deadline <= Date.now()
    )
      throw new ControllerError(
        "interaction_stale",
        "Interaction is no longer live",
      );
    if (interaction.kind === "approval") {
      const options =
        (interaction.request as { options?: Json[] })?.options ?? [];
      if (
        !options.some((option) =>
          typeof option === "string"
            ? option === response
            : option &&
              typeof option === "object" &&
              !Array.isArray(option) &&
              (option.id ?? option.optionId) === response,
        )
      )
        throw new ControllerError(
          "invalid_response",
          "Approval outcome was not offered",
        );
    } else if (interaction.kind === "input") {
      const schema = (interaction.request as { schema?: Record<string, Json> })
        ?.schema;
      if (schema && !this.#ajv.validate(schema, response))
        throw new ControllerError(
          "invalid_response",
          "Input does not match the requested schema",
        );
    } else
      throw new ControllerError(
        "invalid_response",
        "Tool results use the executor endpoint",
      );
    this.store.putInteraction({ ...interaction, state: "resolved", response });
    this.#responses.delete(id);
    waiting.resolve(response);
  }
  async drain(): Promise<void> {
    do {
      await Promise.resolve();
      await Promise.all([...this.#active.values()].map((item) => item.promise));
    } while (this.#scheduled || this.#active.size > 0);
  }
  async close(): Promise<void> {
    this.#closing = true;
    for (const active of this.#active.values()) active.abort.abort();
    await Promise.all(
      [...this.providers.values()].map((provider) => provider.close()),
    );
    await this.drain();
  }
  private requireTurn(owner: string, id: string): Turn {
    const turn = this.store.turn(id);
    if (!turn) throw new ControllerError("not_found", "Turn not found");
    this.store.authorizeThread(owner, turn.threadId);
    return turn;
  }
  private schedule(): void {
    if (this.#scheduled || this.#closing) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.pump();
    });
  }
  private pump(): void {
    if (this.#closing) return;
    for (const turn of this.store.turns()) {
      if (this.#active.size >= this.concurrency) break;
      if (
        !["queued", "prepared"].includes(turn.state) ||
        this.#active.has(turn.id)
      )
        continue;
      const thread = this.store.thread(turn.threadId)!;
      const workspace = thread.workspace;
      if (
        [...this.#active.values()].some(
          (active) => active.workspace === workspace,
        )
      )
        continue;
      const abort = new AbortController();
      const promise = Promise.resolve()
        .then(() => this.execute(thread, turn, abort.signal))
        .finally(() => {
          this.#active.delete(turn.id);
          this.schedule();
        });
      this.#active.set(turn.id, { promise, abort, workspace });
    }
  }
  private async execute(
    thread: Thread,
    turn: Turn,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const provider = this.providers.get(thread.provider);
      if (!provider)
        throw new ControllerError(
          "provider_unavailable",
          "Provider unavailable",
        );
      let preparation = this.store.preparation(turn.id);
      if (!preparation) {
        this.store.transition(turn.id, "preparing");
        preparation = await prepareTurn(thread, turn, this.#sources, signal);
        this.store.prepare(turn.id, preparation);
      }
      await authorizePreparation(thread, preparation, this.#sources, signal);
      const endpoint = thread.toolEndpoint
        ? this.#tools.get(`${thread.owner}:${thread.toolEndpoint}`)
        : undefined;
      if (thread.toolEndpoint && !endpoint)
        throw new ControllerError(
          "tools_unavailable",
          "Tool endpoint is unavailable",
        );
      const memoryTools = thread.memoryEndpoint ? memoryToolDefinitions : [];
      if (
        endpoint?.definitions.some((tool) =>
          memoryTools.some((memory) => memory.name === tool.name),
        )
      )
        throw new ControllerError(
          "tool_conflict",
          "Memory tools are owned by controller preparation",
        );
      const combined: ToolEndpoint = {
        definitions: [...(endpoint?.definitions ?? []), ...memoryTools],
        execute: async (name, input, call) => {
          if (memoryTools.some((tool) => tool.name === name))
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    await this.readMemory(
                      thread.owner,
                      thread.id,
                      name === "memory_search" ? "search" : "get",
                      input,
                      call.signal,
                    ),
                  ),
                },
              ],
            };
          if (!endpoint)
            throw new ControllerError(
              "tool_unavailable",
              "Tool endpoint is unavailable",
            );
          return endpoint.execute(name, input, call);
        },
      };
      signal.throwIfAborted();
      this.store.transition(turn.id, "dispatching");
      await provider.execute({
        thread,
        turn,
        preparation,
        tools: structuredClone(combined.definitions),
        signal,
        emit: (event) => this.ingest(turn.id, event),
        bindSession: async (id) => this.store.bindSession(thread.id, id),
        callTool: (name, input, nativeId) =>
          this.callTool(thread, turn, combined, name, input, signal, nativeId),
        interact: (kind, nativeId, request, deadline) =>
          this.interact(
            thread,
            turn,
            kind,
            nativeId,
            request,
            deadline,
            signal,
          ),
      });
      if (!isTerminal(this.store.turn(turn.id)!.state))
        this.store.transition(
          turn.id,
          signal.aborted ? "cancelled" : "interrupted",
          signal.aborted ? "cancelled" : "missing_completion",
        );
    } catch (error) {
      const current = this.store.turn(turn.id)!;
      if (!isTerminal(current.state)) {
        const code =
          error instanceof ControllerError ? error.code : "execution_failed";
        const state = signal.aborted
          ? "interrupted"
          : current.state === "dispatching"
            ? "submission-unknown"
            : ["running", "waiting"].includes(current.state)
              ? "interrupted"
              : "failed";
        this.store.transition(
          turn.id,
          state,
          signal.aborted ? "cancellation_unconfirmed" : code,
        );
      }
    } finally {
      for (const interaction of this.store.interactions(thread.id))
        if (interaction.turnId === turn.id && interaction.state === "pending") {
          this.store.putInteraction({
            ...interaction,
            state: interaction.kind === "tool" ? "unknown" : "cancelled",
          });
          this.#responses
            .get(interaction.id)
            ?.reject(new ControllerError("interaction_stale", "Turn ended"));
          this.#responses.delete(interaction.id);
        }
    }
  }
  private async ingest(turnId: string, event: RuntimeEvent): Promise<void> {
    const turn = this.store.turn(turnId)!;
    if (isTerminal(turn.state)) return;
    this.store.transaction(() => {
      if (event.type === "completed")
        this.store.transition(turnId, event.outcome ?? "completed");
      else if (event.type === "failed")
        this.store.transition(turnId, "failed", event.code);
      else {
        if (turn.state === "dispatching")
          this.store.transition(turnId, "running");
        if (event.type === "text")
          this.store.ingestText(turnId, event.text, event.sourceId);
        else if (event.type === "activity")
          this.store.append(
            turn.threadId,
            "output.activity",
            event.data,
            turnId,
            event.sourceId,
          );
      }
    });
  }
  private async interact(
    thread: Thread,
    turn: Turn,
    kind: "approval" | "input",
    nativeId: string,
    request: Json,
    deadline: number,
    signal: AbortSignal,
  ): Promise<Json> {
    const interaction: Interaction = {
      id: randomUUID(),
      threadId: thread.id,
      turnId: turn.id,
      nativeId,
      kind,
      request,
      state: "pending",
      deadline,
    };
    const response = new Promise<Json>((resolve, reject) => {
      this.#responses.set(interaction.id, { resolve, reject });
    });
    this.store.putInteraction(interaction);
    this.store.transition(turn.id, "waiting");
    try {
      const value = await bounded(
        response,
        Math.max(0, deadline - Date.now()),
        signal,
      );
      this.store.transition(turn.id, "running");
      return value;
    } finally {
      this.#responses.delete(interaction.id);
      if (this.store.interaction(interaction.id)?.state === "pending")
        this.store.putInteraction({
          ...interaction,
          state: signal.aborted ? "cancelled" : "expired",
        });
    }
  }
  private async callTool(
    thread: Thread,
    turn: Turn,
    endpoint: ToolEndpoint | undefined,
    name: string,
    input: Json,
    signal: AbortSignal,
    nativeId?: string,
  ): Promise<ToolResult> {
    const definition = endpoint?.definitions.find((tool) => tool.name === name);
    if (!endpoint || !definition)
      throw new ControllerError("tool_unavailable", "Tool is unavailable");
    if (!this.#ajv.validate(definition.inputSchema, input))
      throw new ControllerError(
        "invalid_tool_input",
        "Tool arguments do not match schema",
      );
    const id = nativeId ? `${turn.attemptId}:${nativeId}` : randomUUID();
    const prior = this.store.interaction(id);
    if (prior) {
      if (
        prior.nativeId !== name ||
        JSON.stringify(prior.request) !== JSON.stringify(input)
      )
        throw new ControllerError(
          "invocation_conflict",
          "Tool invocation identity has different input",
        );
      if (prior.state === "resolved")
        return prior.response as unknown as ToolResult;
      throw new ControllerError(
        "invocation_unknown",
        "Tool invocation must be reconciled before retry",
      );
    }
    const interaction: Interaction = {
      id,
      threadId: thread.id,
      turnId: turn.id,
      kind: "tool",
      nativeId: name,
      request: input,
      deadline: Date.now() + 120_000,
      state: "pending",
    };
    this.store.putInteraction(interaction);
    try {
      const result = await bounded(
        endpoint.execute(name, input, {
          invocationId: interaction.id,
          thread,
          turn,
          signal,
        }),
        120_000,
        signal,
      );
      if (signal.aborted || isTerminal(this.store.turn(turn.id)!.state))
        throw new ControllerError(
          "interaction_stale",
          "Tool result arrived after turn ended",
        );
      this.store.putInteraction({
        ...interaction,
        state: "resolved",
        response: result as unknown as Json,
      });
      return result;
    } catch (error) {
      this.store.putInteraction({
        ...interaction,
        state: definition.effect === "read" ? "cancelled" : "unknown",
      });
      throw error;
    }
  }
}
const memoryToolDefinitions: import("../contracts.js").ToolDefinition[] = [
  {
    name: "memory_search",
    description: "Search authorized memory with evidence references",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Read an authorized memory and verify its evidence",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
];
