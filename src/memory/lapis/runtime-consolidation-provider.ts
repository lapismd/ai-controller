import type {
  AgentEvent,
  AgentRequest,
  AgentRuntime,
  AgentSession,
} from "../../execution/compat/types.js";
import type {
  ConsolidationProposal,
  GroundedConsolidationInput,
  MemoryConsolidationProvider,
} from "./types.js";

const MAX_INPUT_CHARS = 32_000;
const MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_TIMEOUT_MS = 60_000;

export type RuntimeConsolidationConfiguration = {
  runtimeId: "acp" | "codex-native";
  agent: "codex" | "cursor";
  model: string;
};

export type RuntimeMemoryConsolidationProviderOptions = {
  configuration: () => RuntimeConsolidationConfiguration;
  resolveRuntime: (request: AgentRequest) => Promise<AgentRuntime>;
  timeoutMs?: number;
};

export class RuntimeMemoryConsolidationProvider implements MemoryConsolidationProvider {
  readonly #timeoutMs: number;

  constructor(
    private readonly options: RuntimeMemoryConsolidationProviderOptions,
  ) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async propose(
    input: GroundedConsolidationInput,
    signal?: AbortSignal,
  ): Promise<ConsolidationProposal> {
    const configuration = this.options.configuration();
    if (!configuration.model.trim()) {
      throw new Error("Memory consolidation requires a pinned model.");
    }
    const prompt = consolidationPrompt(input);
    const request: AgentRequest = {
      prompt: "",
      agent: configuration.agent,
      model: {
        provider: configuration.agent,
        model: configuration.model.trim(),
      },
      thinking: "low",
      metadata: {
        runtime: configuration.runtimeId,
        purpose: "memory-consolidation",
      },
      mcpServers: [],
      restricted: true,
      requireApprovals: false,
      requirePolicyAmendments: false,
    };
    const runtime = await this.options.resolveRuntime(request);
    const session = await runtime.start(request);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("Memory consolidation timed out.")),
      this.#timeoutMs,
    );
    const abort = () => deadline.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await collectProposal(session, prompt, deadline.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await session.close().catch(() => undefined);
    }
  }
}

async function collectProposal(
  session: AgentSession,
  prompt: string,
  signal: AbortSignal,
): Promise<ConsolidationProposal> {
  let output = "";
  let completed = false;
  const cancelOnAbort = () => void session.cancel?.().catch(() => undefined);
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const send = session.send(prompt);
  const events = session.events()[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextEvent(events, signal);
      if (next.done) break;
      const event = next.value;
      assertReadOnlyEvent(event);
      if (event.type === "text") {
        output += event.text;
        if (output.length > MAX_OUTPUT_CHARS) {
          await session.cancel?.().catch(() => undefined);
          throw new Error("Memory consolidation output exceeded its limit.");
        }
      }
      if (event.type === "error") throw event.error;
      if (event.type === "completed") {
        completed = true;
        break;
      }
    }
    await send;
    if (!completed)
      throw new Error("Memory consolidation ended without completion.");
    return parseProposal(output);
  } catch (error) {
    await session.cancel?.().catch(() => undefined);
    await send.catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    await events.return?.().catch(() => undefined);
  }
}

function nextEvent(
  events: AsyncIterator<AgentEvent>,
  signal: AbortSignal,
): Promise<IteratorResult<AgentEvent>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void events.next().then(
      (next) => {
        signal.removeEventListener("abort", onAbort);
        resolve(next);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function assertReadOnlyEvent(event: AgentEvent): void {
  if (
    event.type === "tool.start" ||
    event.type === "tool.end" ||
    event.type === "command.start" ||
    event.type === "command.end" ||
    event.type === "file.changed" ||
    event.type === "permission.request" ||
    event.type === "question.request"
  ) {
    throw new Error(
      `Memory consolidation aborted on forbidden runtime event: ${event.type}`,
    );
  }
}

function consolidationPrompt(input: GroundedConsolidationInput): string {
  const payload = JSON.stringify({
    scope: input.scope,
    candidates: input.candidates.slice(0, 10).map((candidate) => ({
      id: candidate.id,
      claim: candidate.claim.slice(0, 2_000),
      evidence: candidate.evidence.slice(0, 20).map((evidence) => ({
        conversationId: evidence.conversationId,
        entryId: evidence.entryId,
        entryHash: evidence.entryHash,
        observedAt: evidence.observedAt,
      })),
    })),
  });
  if (payload.length > MAX_INPUT_CHARS) {
    throw new Error("Memory consolidation input exceeded its limit.");
  }
  return [
    "You are a restricted memory consolidation processor.",
    "Return exactly one JSON object and no markdown or commentary.",
    "Use only the supplied candidates. Do not invent candidate IDs or evidence.",
    'The object must be {"memories":[{"candidateIds":[string],"kind":"preference"|"fact"|"decision"|"procedure"|"constraint","scope":MemoryScope,"importance":1|2|3|4|5,"triggers":[string],"summary":string,"supersessionKey"?:string}]}.',
    "Input:",
    payload,
  ].join("\n");
}

function parseProposal(output: string): ConsolidationProposal {
  const parsed: unknown = JSON.parse(output.trim());
  if (!isObject(parsed) || !Array.isArray(parsed.memories)) {
    throw new Error("Memory consolidation returned an invalid JSON shape.");
  }
  return parsed as ConsolidationProposal;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
