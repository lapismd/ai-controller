import { ControllerClient, type EndpointRegistration } from "./client.js";
import {
  ControllerError,
  isTerminal,
  type Capabilities,
  type ControllerEvent,
  type Json,
  type Receipt,
  type Snapshot,
  type Thread,
  type ThreadInput,
  type Turn,
} from "./contracts.js";
import { AsyncEventQueue } from "./execution/compat/event-queue.js";
import type {
  AgentCapabilities,
  AgentEvent,
  AgentRequest,
  AgentRuntime,
  AgentSession,
  AgentSessionConfiguration,
  AgentSessionConfigurationResult,
  AgentTurnOptions,
  UserInputAnswers,
} from "./execution/compat/types.js";

export type {
  AgentEvent,
  AgentRuntime,
  AgentSession,
  AgentRequest,
} from "./execution/compat/types.js";
export interface ControllerRuntimeOptions {
  id: string;
  client: ControllerClient;
  provider(request: Omit<AgentRequest, "prompt">): string;
  workspace(request: Omit<AgentRequest, "prompt">): string;
  /** Supplies authorized domain endpoints and immutable scope bindings. */
  prepare?(request: Omit<AgentRequest, "prompt">): Promise<{
    thread?: Pick<
      ThreadInput,
      | "externalRef"
      | "payloadPolicy"
      | "toolEndpoint"
      | "memoryEndpoint"
      | "contextSources"
    >;
    endpoints?: EndpointRegistration[];
    dispose?(): Promise<void>;
  }>;
}
/** Shared session facade; execution and preparation remain owned by the service. */
export class ControllerRuntime implements AgentRuntime {
  readonly id: string;
  #capabilities?: Capabilities;
  constructor(readonly options: ControllerRuntimeOptions) {
    this.id = options.id;
  }
  capabilities(): AgentCapabilities & { preparesContext: true } {
    const value = this.#capabilities;
    return {
      sessions: true,
      resume: !!value && value.resume !== "none",
      cancel: true,
      steer: false,
      modelSelection: value?.configuration ?? false,
      nativeTools: true,
      mcpTools: value?.tools ?? false,
      preparesContext: true,
      approvals: {
        supported: value?.approvals ?? false,
        interactive: value?.approvals ?? false,
        persistentDecisions:
          value?.approvalFeatures?.persistentDecisions ?? false,
        granularPermissions:
          value?.approvalFeatures?.granularPermissions ?? false,
        policyAmendments: value?.approvalFeatures?.policyAmendments ?? false,
      },
    };
  }
  async supports(request: AgentRequest): Promise<boolean> {
    const providers =
      await this.options.client.request<
        Array<{ id: string; capabilities: Capabilities }>
      >("providers.list");
    const capabilities = providers.find(
      (item) => item.id === this.options.provider(request),
    )?.capabilities;
    this.#capabilities = capabilities;
    return (
      !!capabilities &&
      (!request.requireApprovals || capabilities.approvals) &&
      (!request.requirePolicyAmendments ||
        !!capabilities.approvalFeatures?.policyAmendments) &&
      !request.mcpServers?.length
    );
  }
  start(request: AgentRequest): Promise<AgentSession> {
    return this.open(request);
  }
  resume(
    id: string,
    request: Omit<AgentRequest, "prompt"> = {},
  ): Promise<AgentSession> {
    return this.open(request, id);
  }
  private async open(
    request: Omit<AgentRequest, "prompt">,
    id?: string,
  ): Promise<AgentSession> {
    if (!(await this.supports({ ...request, prompt: "" })))
      throw new ControllerError(
        "unsupported_request",
        "Provider does not support the requested execution contract",
      );
    const prepared = await this.options.prepare?.(request);
    const disposers: Array<() => Promise<void>> = [];
    if (prepared?.dispose) disposers.push(prepared.dispose);
    try {
      for (const endpoint of prepared?.endpoints ?? [])
        disposers.push(await this.options.client.registerEndpoint(endpoint));
      const thread = id
        ? (await this.options.client.snapshot(id)).thread
        : await this.options.client.createThread({
            ...prepared?.thread,
            provider: this.options.provider(request),
            workspace: this.options.workspace(request),
            configuration: {
              ...(request.restricted ? { restricted: true } : {}),
              ...(request.model ? { model: request.model.model } : {}),
              ...(request.thinking ? { thinking: request.thinking } : {}),
            },
          });
      if (
        thread.provider !== this.options.provider(request) ||
        thread.workspace !== this.options.workspace(request)
      )
        throw new ControllerError(
          "binding_mismatch",
          "Thread belongs to another provider or workspace",
        );
      const session = new ControllerSession(
        this.options.client,
        thread,
        disposers,
      );
      await session.attach();
      return session;
    } catch (error) {
      await Promise.allSettled(disposers.reverse().map((dispose) => dispose()));
      throw error;
    }
  }
}
class ControllerSession implements AgentSession {
  readonly id: string;
  readonly #events = new AsyncEventQueue<AgentEvent>();
  #cursor = 0;
  readonly #interactions = new Set<string>();
  readonly #terminal = new Set<string>();
  #thread: Thread;
  #activeCommand?: string;
  #activeTurn?: Turn;
  #submission?: Promise<Receipt>;
  #unsubscribe?: () => void;
  #closed = false;
  constructor(
    readonly client: ControllerClient,
    thread: Thread,
    readonly disposers: Array<() => Promise<void>>,
  ) {
    this.id = thread.id;
    this.#thread = thread;
  }
  async attach(): Promise<void> {
    this.#unsubscribe = await this.client.subscribe(this.id, (snapshot) =>
      this.observe(snapshot),
    );
  }
  events(): AsyncIterable<AgentEvent> {
    return this.#events;
  }
  async send(text: string, options?: AgentTurnOptions): Promise<void> {
    if (this.#closed)
      throw new ControllerError("session_closed", "Session is closed");
    if (
      this.#submission ||
      (this.#activeCommand &&
        (!this.#activeTurn || !isTerminal(this.#activeTurn.state)))
    )
      throw new ControllerError(
        "session_busy",
        "A turn is active or its acknowledgement is unresolved",
      );
    if (options?.contextBlocks?.length)
      throw new ControllerError(
        "preparation_owned",
        "Register context and memory endpoints for controller-owned preparation",
      );
    const commandId = crypto.randomUUID();
    this.#activeCommand = commandId;
    this.#activeTurn = undefined;
    this.#cursor = 0;
    this.#interactions.clear();
    this.#terminal.clear();
    this.#submission = (async () => {
      try {
        return await this.client.submit({ threadId: this.id, commandId, text });
      } catch (error) {
        // Resolve a lost ACK by identity, never by submitting a fresh prompt.
        const receipt = await this.client
          .request<Receipt | null>("commands.get", { commandId })
          .catch(() => null);
        if (receipt) return receipt;
        if (
          error instanceof ControllerError &&
          ![
            "disconnected",
            "request_timeout",
            "connection_failed",
            "connection_timeout",
          ].includes(error.code)
        )
          this.#activeCommand = undefined;
        throw new ControllerError(
          "submission_unconfirmed",
          `Submission acknowledgement is unresolved; inspect command ${commandId}`,
        );
      }
    })();
    try {
      await this.#submission;
    } finally {
      this.#submission = undefined;
    }
  }
  async configure(
    input: AgentSessionConfiguration,
  ): Promise<AgentSessionConfigurationResult> {
    this.#thread = await this.client.request<Thread>("threads.configure", {
      threadId: this.id,
      version: this.#thread.version,
      configuration: {
        ...this.#thread.configuration,
        ...(input.model ? { model: input.model.model } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
      },
    });
    const saved = {
      status: "applied" as const,
      reason:
        "Saved for the next turn; the provider validates the value before submission",
    };
    return {
      ...(input.model ? { model: saved } : {}),
      ...(input.thinking ? { thinking: saved } : {}),
    };
  }
  async respondToApproval(id: string, option: string): Promise<void> {
    await this.client.respond(id, option);
  }
  async respondToQuestion(
    id: string,
    answers: UserInputAnswers,
  ): Promise<void> {
    await this.client.respond(id, answers as Json);
  }
  async cancel(): Promise<void> {
    if (this.#submission) await this.#submission;
    if (this.#activeTurn) await this.client.cancel(this.#activeTurn.id);
    else if (this.#activeCommand) {
      const receipt = await this.client.request<Receipt | null>(
        "commands.get",
        { commandId: this.#activeCommand },
      );
      if (!receipt)
        throw new ControllerError(
          "submission_unconfirmed",
          "Resolve the command receipt before cancellation",
        );
      await this.client.cancel(receipt.turnId);
    }
  }
  async detach(): Promise<void> {
    await this.close();
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe?.();
    await Promise.allSettled(
      this.disposers.reverse().map((dispose) => dispose()),
    );
    this.#events.close();
  }
  private observe(snapshot: Snapshot): void {
    if (this.#closed) return;
    this.#thread = snapshot.thread;
    const active = this.#activeCommand
      ? snapshot.turns.find((turn) => turn.commandId === this.#activeCommand)
      : snapshot.turns.find((turn) => !isTerminal(turn.state));
    if (!active) return;
    this.#activeTurn = active;
    this.#activeCommand = active.commandId;
    const transcript = snapshot.transcript.filter(
      (event) => event.turnId === active.id,
    );
    if (snapshot.transcriptTruncated && transcript.length && !this.#cursor)
      this.#events.push({
        type: "status",
        status:
          "Transcript snapshot is truncated; use events.read to inspect retained history",
      });
    for (const event of transcript) this.observeEvent(event);
    for (const interaction of snapshot.interactions)
      if (
        interaction.turnId === active.id &&
        interaction.state === "pending" &&
        interaction.kind !== "tool" &&
        !this.#interactions.has(interaction.id)
      ) {
        this.#interactions.add(interaction.id);
        if (
          !interaction.request ||
          typeof interaction.request !== "object" ||
          "unavailable" in interaction.request
        ) {
          this.#events.push({
            type: "status",
            status: "Private interaction payload is unavailable",
          });
          continue;
        }
        const request = { ...interaction.request, id: interaction.id };
        this.#events.push(
          interaction.kind === "approval"
            ? {
                type: "permission.request",
                request: request as Extract<
                  AgentEvent,
                  { type: "permission.request" }
                >["request"],
              }
            : {
                type: "question.request",
                request: request as Extract<
                  AgentEvent,
                  { type: "question.request" }
                >["request"],
              },
        );
      }
    if (isTerminal(active.state) && !this.#terminal.has(active.id)) {
      this.#terminal.add(active.id);
      this.#events.push(
        active.state === "completed"
          ? { type: "completed" }
          : active.state === "cancelled"
            ? { type: "status", status: "cancelled" }
            : {
                type: "error",
                error: new ControllerError(
                  active.error ?? active.state,
                  `Turn ${active.state}; inspect its durable receipt`,
                ),
              },
      );
    }
  }
  private observeEvent(event: ControllerEvent): void {
    const sequence = Number(event.cursor.split(":")[1]);
    if (sequence <= this.#cursor) return;
    this.#cursor = sequence;
    // Tail snapshots and live delivery use the same committed identity and ordering.
    const source = { sessionId: this.id, runId: event.turnId!, sequence };
    const data = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      "payloadUnavailable" in data
    ) {
      this.#events.push({
        type: "status",
        status: "Private transcript payload is unavailable",
        source,
      });
      return;
    }
    if (event.type === "output.text" && typeof data.text === "string")
      this.#events.push({ type: "text", text: data.text, source });
    else if (event.type === "output.activity" && typeof data.type === "string")
      this.#events.push({ ...data, source } as AgentEvent);
  }
}
