import { InteractionLifecycle } from "./interaction-lifecycle.js";
import { automaticApproval } from "./approval-policy.js";
import { assertTranscript } from "../capture/validation.js";
import { CaptureSession, type Captured } from "../capture/session.js";
import type { TranscriptEndpoint } from "./ports.js";
import { validateMcpServers } from "./mcp.js";
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
  ToolCapture,
  ToolEndpoint,
  MemoryEndpoint,
  McpEndpoint,
} from "./ports.js";
import { recallMemory } from "../memory/recall.js";
import {
  applicationOf,
  authorizeMemoryInput,
  endpointKey,
  threadEndpointKey,
} from "../auth/authorize.js";

export class Controller {
  inspectTools(owner: string, threadId: string) {
    const thread = this.store.authorizeThread(owner, threadId);
    const endpoint = thread.toolEndpoint
      ? this.#tools.get(threadEndpointKey(thread, thread.toolEndpoint))
      : undefined;
    return {
      available: !thread.toolEndpoint || !!endpoint,
      memoryAvailable:
        !thread.memoryEndpoint ||
        this.#memory.has(threadEndpointKey(thread, thread.memoryEndpoint)),
      definitions: structuredClone([
        ...(endpoint?.definitions ?? []),
        ...(thread.memoryEndpoint ? memoryToolDefinitions : []),
      ]),
    };
  }
  readonly #transcripts = new Map<string, TranscriptEndpoint>();
  readonly #captures = new Map<string, CaptureSession>();
  readonly #mcp = new Map<string, McpEndpoint>();
  readonly #sources = new Map<string, ContextSource>();
  readonly #tools = new Map<string, ToolEndpoint>();
  readonly #memory = new Map<string, MemoryEndpoint>();
  readonly #active = new Map<
    string,
    { promise: Promise<void>; abort: AbortController; workspace: string }
  >();
  readonly #interactionLifecycle = new InteractionLifecycle();
  readonly #responses = new Map<
    string,
    { resolve(value: Json): void; reject(error: Error): void }
  >();
  readonly #ajv = new Ajv({ strict: false, allErrors: true });
  readonly #capture?: ToolCapture;
  #closing = false;
  #scheduled = false;
  constructor(
    readonly store: ControllerStore,
    readonly providers: Map<string, ExecutionProvider>,
    readonly concurrency = 4,
    capture?: ToolCapture,
  ) {
    this.#capture = capture;
  }
  start(): void {
    this.store.recover();
    this.schedule();
  }
  registerTranscript(owner: string, id: string, endpoint: TranscriptEndpoint, applicationId = owner): () => void {
    const key = endpointKey(owner, applicationId, id);
    this.#transcripts.set(key, endpoint);
    return () => { if (this.#transcripts.get(key) === endpoint) this.#transcripts.delete(key); };
  }
  async replayTranscript(owner: string, threadId: string, afterSequence = 0, turnId?: string) {
    const thread = this.store.authorizeThread(owner, threadId);
    const endpoint = thread.transcriptEndpoint ? this.#transcripts.get(threadEndpointKey(thread, thread.transcriptEndpoint)) : undefined;
    if (thread.transcriptEndpoint && !endpoint) throw new ControllerError("transcript_unavailable", "Transcript endpoint unavailable");
    if (endpoint) return this.store.capture.clean(await endpoint.replay(thread, afterSequence, turnId));
    return this.store.replayTranscript(owner, threadId, afterSequence, turnId);
  }
  private captureFor(turn: Turn): CaptureSession {
    let capture = this.#captures.get(turn.id);
    if (!capture) {
      capture = new CaptureSession(this.store.thread(turn.threadId)!, turn, this.store.capture, () => this.store.nextTranscriptSequence(turn.threadId));
      this.#captures.set(turn.id, capture);
    }
    return capture;
  }
  private async persistCapture(turn: Turn, records: Captured[]): Promise<void> {
    if (!records.length) return;
    const thread = this.store.thread(turn.threadId)!;
    const endpoint = thread.transcriptEndpoint ? this.#transcripts.get(threadEndpointKey(thread, thread.transcriptEndpoint)) : undefined;
    if (thread.transcriptEndpoint && !endpoint) throw new ControllerError("transcript_unavailable", "Transcript endpoint unavailable");
    for (const { event, projection } of records) {
      if (event) {
        assertTranscript(event);
        if (endpoint) {
          const ack = await endpoint.append(thread, event);
          if (ack.durable !== true || ack.eventId !== event.id || ack.sequence !== event.sequence) throw new ControllerError("transcript_unacknowledged", "Transcript was not durably acknowledged");
        }
      }
      this.store.transaction(() => {
        if (event) this.store.append(thread.id, "transcript.event", event as unknown as Json, turn.id, event.id);
        if (projection?.type === "text" && event) this.store.ingestText(turn.id, projection.text, `${event.id}:projection`, projection);
        else if (projection?.type === "activity") {
          const data = projection.data && typeof projection.data === "object" && !Array.isArray(projection.data) ? projection.data : {};
          const status = String(data.status ?? data.type ?? "activity");
          this.store.append(thread.id, "output.activity", projection.data, turn.id, `${event?.id ?? `${turn.attemptId}:${status}`}:projection`);
        }
      });
      if (projection?.type === "activity" && this.#capture?.observe) {
        try { await this.#capture.observe({ caller: "controller", requestKey: event?.id ?? `${turn.attemptId}:status`, workspaceId: thread.workspace, payload: projection.data }); }
        catch { /* Advisory native observations never repeat tool effects. */ }
      }
    }
  }
  registerMcp(
    owner: string,
    id: string,
    endpoint: McpEndpoint,
    applicationId = owner,
  ): () => void {
    const key = endpointKey(owner, applicationId, id);
    this.#mcp.set(key, endpoint);
    return () => {
      if (this.#mcp.get(key) === endpoint) this.#mcp.delete(key);
    };
  }
  registerMemory(
    owner: string,
    id: string,
    endpoint: MemoryEndpoint,
    applicationId = owner,
  ): () => void {
    const key = endpointKey(owner, applicationId, id);
    this.#memory.set(key, endpoint);
    const dispose = this.registerContext(
      owner,
      `__memory.${id}`,
      {
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
      },
      applicationId,
    );
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
      this.#memory.get(threadEndpointKey(thread, thread.memoryEndpoint));
    if (!endpoint)
      throw new ControllerError(
        "memory_unavailable",
        "Memory endpoint is unavailable",
      );
    const access = {
      principalId: thread.owner,
      applicationId: applicationOf(thread),
      workspaceId: thread.workspace,
      threadId: thread.id,
    };
    return this.store.capture.clean(await bounded(
      endpoint.read(
        thread,
        operation,
        authorizeMemoryInput(this.store.capture.clean(input), access),
        signal,
      ),
      30_000,
      signal,
    ));
  }
  registerContext(
    owner: string,
    id: string,
    source: ContextSource,
    applicationId = owner,
  ): () => void {
    const key = endpointKey(owner, applicationId, id);
    this.#sources.set(key, source);
    return () => {
      if (this.#sources.get(key) === source) this.#sources.delete(key);
    };
  }
  registerTools(
    owner: string,
    id: string,
    endpoint: ToolEndpoint,
    applicationId = owner,
  ): () => void {
    const names = new Set<string>();
    for (const definition of endpoint.definitions) {
      if (names.has(definition.name))
        throw new ControllerError("invalid_tools", "Duplicate tool name");
      names.add(definition.name);
      this.#ajv.compile(definition.inputSchema);
    }
    const key = endpointKey(owner, applicationId, id);
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
  resolve(
    owner: string,
    turnId: string,
    outcome: "failed" | "cancelled",
    externalStopped: boolean,
  ): void {
    const turn = this.requireTurn(owner, turnId);
    if (!externalStopped)
      throw new ControllerError(
        "resolution_required",
        "Verify external work has stopped before resolving this turn",
      );
    if (!["failed", "cancelled"].includes(outcome))
      throw new ControllerError(
        "invalid_input",
        "Resolution outcome must be failed or cancelled",
      );
    if (
      !["submission-unknown", "interrupted"].includes(turn.state) ||
      this.#active.has(turn.id)
    )
      throw new ControllerError(
        "resolution_invalid",
        "Only inactive uncertain turns can be resolved",
      );
    this.store.transaction(() => {
      this.store.append(
        turn.threadId,
        "turn.resolved",
        { outcome, externalStopped: true },
        turn.id,
        undefined,
        true,
      );
      this.store.resolveUncertain(turn.id, outcome);
    });
    this.schedule();
  }
  respond(owner: string, id: string, response: Json, resolution: "owner" | "automatic" = "owner"): void {
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
    response = this.store.capture.clean(response);
    this.store.putInteraction({ ...interaction, state: "resolved", response, resolution });
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
        this.store
          .turns()
          .some(
            (candidate) =>
              ["submission-unknown", "interrupted"].includes(candidate.state) &&
              this.store.thread(candidate.threadId)?.workspace === workspace,
          )
      )
        continue;
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
      if (thread.nativeSessionId && thread.capturePolicy !== this.store.capture.policyId) throw new ControllerError("legacy_context_handoff_required", "Create a fresh thread with sanitized context before resuming this legacy session");
      await this.persistCapture(turn, [this.captureFor(turn).record({ kind: "message", role: "user", text: turn.text ?? "", messageId: `${turn.attemptId}:request` })]);
      let preparation = this.store.preparation(turn.id);
      if (!preparation) {
        this.store.transition(turn.id, "preparing");
        preparation = this.store.capture.clean(await prepareTurn(thread, turn, this.#sources, signal));
        this.store.prepare(turn.id, preparation);
      }
      const mcpEndpoint = thread.mcpEndpoint
        ? this.#mcp.get(threadEndpointKey(thread, thread.mcpEndpoint))
        : undefined;
      if (thread.mcpEndpoint && !mcpEndpoint)
        throw new ControllerError(
          "mcp_unavailable",
          "External MCP endpoint is unavailable",
        );
      const mcpServers = mcpEndpoint
        ? await bounded(mcpEndpoint.resolve(thread, signal), 5000, signal)
        : [];
      validateMcpServers(mcpServers);
      if (
        mcpServers.length &&
        (!provider.capabilities.externalMcp ||
          preparation.configuration.restricted)
      )
        throw new ControllerError(
          "mcp_unsupported",
          "External MCP servers are unsupported for this execution",
        );
      const endpoint = thread.toolEndpoint
        ? this.#tools.get(threadEndpointKey(thread, thread.toolEndpoint))
        : undefined;
      if (thread.toolEndpoint && !endpoint)
        throw new ControllerError(
          "tools_unavailable",
          "Tool endpoint is unavailable",
        );
      const memoryTools = thread.memoryEndpoint ? memoryToolDefinitions : [];
      if (
        preparation.configuration.restricted &&
        ((endpoint?.definitions.length ?? 0) || memoryTools.length)
      )
        throw new ControllerError(
          "restricted_tools",
          "Restricted execution cannot receive application or memory tools",
        );
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
        ...(endpoint?.capture ? { capture: endpoint.capture } : {}),
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
      await authorizePreparation(thread, preparation, this.#sources, signal);
      signal.throwIfAborted();
      await provider.execute({
        thread,
        turn,
        preparation,
        tools: this.store.capture.clean(combined.definitions),
        mcpServers,
        signal,
        dispatch: async () => {
          signal.throwIfAborted();
          await authorizePreparation(
            thread,
            preparation,
            this.#sources,
            signal,
          );
          signal.throwIfAborted();
          this.store.transition(turn.id, "dispatching");
        },
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
          "interrupted",
          signal.aborted ? "cancellation_unconfirmed" : "missing_completion",
        );
    } catch (error) {
      const current = this.store.turn(turn.id)!;
      if (!isTerminal(current.state)) {
        const code =
          error instanceof ControllerError ? error.code : "execution_failed";
        const state = signal.aborted
          ? ["queued", "preparing", "prepared"].includes(current.state)
            ? "cancelled"
            : "interrupted"
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
      try { await this.persistCapture(turn, this.captureFor(turn).finish("interrupted")); }
      catch { this.store.append(thread.id, "capture.gap", { reason: "capture_acknowledgment_unavailable" }, turn.id, `${turn.attemptId}:gap`, true); }
      finally { this.#captures.delete(turn.id); this.#interactionLifecycle.clear(turn.id); }
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
    if (event.type === "interaction-settled") {
      this.#interactionLifecycle.settle(this.store, turn, event.nativeId, event.state,
        (id, error) => this.#responses.get(id)?.reject(error));
      return;
    }
    if (isTerminal(turn.state)) return;
    if (["prepared", "dispatching"].includes(turn.state)) this.store.transition(turnId, "running");
    await this.persistCapture(turn, this.captureFor(turn).accept(event));
    if (event.type === "completed") this.store.transition(turnId, event.outcome ?? "completed");
    else if (event.type === "failed") this.store.transition(turnId, "failed", this.store.capture.clean(event.code));
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
    await this.persistCapture(turn, this.captureFor(turn).completeBlock());
    request = this.store.capture.clean(request);
    const automatic = automaticApproval(this.store.preparation(turn.id)?.configuration ?? {}, kind, request);
    const interaction: Interaction = {
      id: randomUUID(),
      threadId: thread.id,
      turnId: turn.id,
      nativeId,
      kind,
      ...(automatic !== undefined ? { resolution: "automatic" as const } : {}),
      request,
      state: "pending",
      deadline,
    };
    const response = new Promise<Json>((resolve, reject) => {
      this.#responses.set(interaction.id, { resolve, reject });
    });
    void response.catch(() => {});
    await this.persistCapture(turn, [this.captureFor(turn).record({ kind: kind === "approval" ? "permission" : "input", interactionId: interaction.id, request, state: "pending" })]);
    const settled = this.#interactionLifecycle.state(turn.id, nativeId);
    if (settled || isTerminal(this.store.turn(turn.id)!.state) || signal.aborted) {
      this.#responses.delete(interaction.id);
      this.store.putInteraction({ ...interaction, state: settled ?? "cancelled" });
      throw this.#interactionLifecycle.error();
    }
    this.store.putInteraction(interaction);
    this.store.transition(turn.id, "waiting");
    try {
      if (automatic !== undefined && !signal.aborted && deadline > Date.now()) {
        this.respond(thread.owner, interaction.id, automatic, "automatic");
      }
      const value = await bounded(
        response,
        Math.max(0, deadline - Date.now()),
        signal,
      );
      await this.persistCapture(turn, [this.captureFor(turn).record({ kind: kind === "approval" ? "permission" : "input", interactionId: interaction.id, request, response: value, state: "resolved" })]);
      const current = this.store.turn(turn.id)!;
      if (!isTerminal(current.state) && !current.cancelRequested &&
          !this.store.interactions(thread.id).some(item => item.turnId === turn.id && item.state === "pending"))
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
    const capturedInput = this.store.capture.clean(input);
    const id = nativeId ? `${turn.attemptId}:${nativeId}` : randomUUID();
    const prior = this.store.interaction(id);
    if (prior) {
      if (
        prior.nativeId !== name ||
        JSON.stringify(prior.request) !== JSON.stringify(capturedInput)
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
      request: capturedInput,
      deadline: Date.now() + 120_000,
      state: "pending",
    };
    await this.persistCapture(turn, [this.captureFor(turn).record({ kind: "tool-invocation", invocationId: id, name, input: capturedInput, execution: "controller" })]);
    this.store.putInteraction(interaction);
    const mutating = definition.effect !== "read";
    const capture = endpoint.capture?.({ thread, turn, signal }) ?? this.#capture;
    let spanId: string | undefined;
    if (capture) {
      if (mutating) {
        try {
          const span = await capture.begin({
            caller: "controller",
            requestKey: interaction.id,
            workspaceId: thread.workspace,
            captureMode: "cooperative",
            intent: "tool",
            toolName: name,
          });
          spanId = span.spanId;
        } catch (error) {
          this.store.putInteraction({
            ...interaction,
            state: "unknown",
          });
          throw error instanceof ControllerError
            ? error
            : new ControllerError(
                "capture_unavailable",
                "Checkpoint capture is unavailable",
              );
        }
      } else if (capture.observe) {
        try {
          await capture.observe({
            caller: "controller",
            requestKey: `${interaction.id}:observe`,
            workspaceId: thread.workspace,
            payload: this.store.capture.clean({ name, input: capturedInput }),
          });
        } catch {
          // Read-effect observations stay non-blocking.
        }
      }
    }
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
      let capturedResult: ToolResult;
      try { capturedResult = this.store.capture.clean(result); }
      catch { capturedResult = { content: "Tool completed; result capture omitted", isError: true }; }
      await this.persistCapture(turn, [this.captureFor(turn).record({ kind: "tool-result", invocationId: id, output: capturedResult.content, outcome: result.isError ? "failed" : "succeeded" })]);
      this.store.putInteraction({
        ...interaction,
        state: "resolved",
        response: capturedResult as unknown as Json,
      });
      if (spanId && capture) {
        await capture.finish({
          caller: "controller",
          requestKey: `${interaction.id}:finish`,
          workspaceId: thread.workspace,
          spanId,
          outcome: "succeeded",
        });
      }
      return capturedResult;
    } catch (error) {
      this.store.putInteraction({
        ...interaction,
        state: definition.effect === "read" ? "cancelled" : "unknown",
      });
      if (spanId && capture) {
        try {
          await capture.finish({
            caller: "controller",
            requestKey: `${interaction.id}:failed`,
            workspaceId: thread.workspace,
            spanId,
            outcome: "failed",
          });
        } catch {
          // Preserve the original tool or capture error.
        }
      }
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
