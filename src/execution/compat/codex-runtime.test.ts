import { describe, expect, it, vi } from "vitest";
import { AsyncEventQueue } from "./event-queue.js";
import type {
  AgentProcessHandle,
  AgentProcessHost,
  AgentProcessMessage,
  AgentProcessSpawnOptions,
} from "./process-host.js";
import { UnavailableAgentProcessHost } from "./process-host.js";
import { CodexNativeRuntime } from "./codex-runtime.js";

class MemoryProcessHandle implements AgentProcessHandle {
  readonly id = "proc-1";
  readonly #messages = new AsyncEventQueue<AgentProcessMessage>();
  readonly writes: string[] = [];

  messages(): AsyncIterable<AgentProcessMessage> {
    return this.#messages;
  }

  async write(data: string): Promise<void> {
    this.writes.push(data);
    const message = JSON.parse(data) as { id?: number; method?: string };
    if (message.id === undefined || !message.method) return;
    const result =
      message.method === "thread/start" || message.method === "thread/resume"
        ? { thread: { id: "thread-1", sessionId: "session-1" } }
        : message.method === "turn/start"
          ? { turn: { id: "turn-1" } }
          : {};
    this.emit(`${JSON.stringify({ id: message.id, result })}\n`);
  }

  async kill(): Promise<void> {
    this.#messages.close();
  }

  emit(data: string): void {
    this.#messages.push({ type: "stdout", data });
  }
}

class MemoryProcessHost implements AgentProcessHost {
  readonly available = true;
  readonly handle = new MemoryProcessHandle();
  lastSpawnOptions: AgentProcessSpawnOptions | undefined;

  async spawn(options: AgentProcessSpawnOptions): Promise<AgentProcessHandle> {
    this.lastSpawnOptions = options;
    return this.handle;
  }
}

describe("CodexNativeRuntime", () => {
  it("supports only policy-amendment requests on an available host", async () => {
    const runtime = new CodexNativeRuntime(new MemoryProcessHost());
    expect(runtime.capabilities().approvals.policyAmendments).toBe(true);
    expect(await runtime.supports({ prompt: "hi" })).toBe(true);
    expect(
      await runtime.supports({ prompt: "hi", requirePolicyAmendments: true }),
    ).toBe(true);
    expect(
      await new CodexNativeRuntime(new UnavailableAgentProcessHost()).supports({
        prompt: "hi",
        requirePolicyAmendments: true,
      }),
    ).toBe(false);
  });

  it("projects the opaque app-tool bridge through process spawn", async () => {
    const host = new MemoryProcessHost();
    const runtime = new CodexNativeRuntime(host);
    const session = await runtime.start({
      prompt: "",
      appToolSession: {
        conversationId: "conversation-1",
        agentBindingId: "binding-1",
        scopeDir: "",
        tools: [],
        bridgeId: "bridge-1",
      },
    });

    expect(host.lastSpawnOptions).toMatchObject({
      command: "codex",
      appToolBridgeId: "bridge-1",
    });
    await session.close();
  });

  it("serializes typed memory context into the native turn only", async () => {
    const host = new MemoryProcessHost();
    const runtime = new CodexNativeRuntime(host);
    const session = await runtime.start({ prompt: "" });

    await session.send("Draft the note", {
      contextBlocks: [
        {
          kind: "memory-recall",
          id: "memory:headings:2",
          content: "Use compact headings.",
          metadata: {
            memoryId: "headings",
            revision: 2,
            scope: "project",
          },
        },
      ],
    });

    const turn = host.handle.writes
      .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
      .find((message) => message.method === "turn/start");
    expect(turn?.params).toMatchObject({
      input: [
        {
          type: "text",
          text: expect.stringContaining(
            '<lapis-context kind="memory-recall" id="memory:headings:2">',
          ),
        },
      ],
    });
    expect(JSON.stringify(turn?.params)).toContain("Draft the note");
    await session.close();
  });

  it("applies model and thinking changes to the next turn without replacing the thread", async () => {
    const host = new MemoryProcessHost();
    const runtime = new CodexNativeRuntime(host);
    const session = await runtime.start({
      prompt: "",
      model: { provider: "codex", model: "first" },
      thinking: "low",
    });

    await expect(
      session.configure?.({
        model: { provider: "codex", model: "second" },
        thinking: "high",
      }),
    ).resolves.toEqual({
      model: { status: "applied" },
      thinking: { status: "applied" },
    });
    await session.send("continue");

    const turns = host.handle.writes
      .map((line) => JSON.parse(line) as { method?: string; params?: unknown })
      .filter((message) => message.method === "turn/start");
    expect(session.id).toBe("thread-1");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.params).toMatchObject({
      threadId: "thread-1",
      model: "second",
      effort: "high",
    });
    await session.close();
  });

  it("maps requestApproval lines into ApprovalRequest and respondToApproval", async () => {
    const host = new MemoryProcessHost();
    const runtime = new CodexNativeRuntime(host);
    const session = await runtime.start({
      prompt: "",
      requirePolicyAmendments: true,
    });
    const events: Array<{ type: string }> = [];
    const consume = (async () => {
      for await (const event of session.events()) {
        events.push(event);
        if (event.type === "completed") break;
      }
    })();
    expect(session.id).toBe("thread-1");
    await session.send("hello");
    expect(
      host.handle.writes.some((line) => line.includes('"turn/start"')),
    ).toBe(true);
    host.handle.emit(
      `${JSON.stringify({
        id: "a1",
        method: "item/commandExecution/requestApproval",
        params: { itemId: "tool-1", reason: "Run ls", command: "ls" },
      })}\n`,
    );
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "permission.request")).toBe(
        true,
      );
    });
    await session.respondToApproval("a1", "allow-once");
    expect(
      host.handle.writes.some(
        (line) => line.includes('"id":"a1"') && line.includes('"accept"'),
      ),
    ).toBe(true);
    host.handle.emit(
      `${JSON.stringify({
        id: "q1",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "input-1",
          questions: [
            {
              id: "approach",
              header: "Approach",
              question: "How should I proceed?",
              isOther: false,
              isSecret: false,
              options: [{ label: "Minimal", description: "Small change" }],
            },
          ],
          autoResolutionMs: null,
        },
      })}\n`,
    );
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "question.request")).toBe(
        true,
      );
    });
    await session.respondToQuestion?.("q1", { approach: ["Minimal"] });
    expect(
      host.handle.writes.some(
        (line) =>
          line.includes('"id":"q1"') &&
          line.includes('"approach":{"answers":["Minimal"]}'),
      ),
    ).toBe(true);
    host.handle.emit(
      `${JSON.stringify({
        method: "item/reasoning/textDelta",
        params: { delta: "Checking" },
      })}\n`,
    );
    host.handle.emit(
      `${JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      })}\n`,
    );
    await consume;
    expect(events.some((event) => event.type === "thinking")).toBe(true);
    await session.close();
  });

  it("resumes the stored thread with its provider context", async () => {
    const host = new MemoryProcessHost();
    const runtime = new CodexNativeRuntime(host);
    const session = await runtime.resume?.("thread-stored", {
      workspace: "/vault",
      agent: "codex",
      model: { provider: "codex", model: "gpt-test" },
      thinking: "high",
    });
    expect(session?.id).toBe("thread-1");
    expect(
      host.handle.writes.some((line) => line.includes('"thread/resume"')),
    ).toBe(true);
    await session?.close();
  });
});

it("passes external MCP environment through the process without secrets in argv", async () => {
  const spawn = vi.fn(async (_options: AgentProcessSpawnOptions) => {
    throw new Error("capture only");
  });
  const runtime = new CodexNativeRuntime({ available: true, spawn });
  await expect(
    runtime.start({
      prompt: "",
      mcpServers: [
        {
          name: "example",
          command: "example-mcp",
          env: { EXAMPLE_TOKEN: "fixture-secret" },
        },
      ],
    }),
  ).rejects.toThrow("capture only");
  const options = spawn.mock.calls[0]?.[0]!;
  expect(options.env).toEqual({ EXAMPLE_TOKEN: "fixture-secret" });
  expect(options.args).toContain(
    'mcp_servers.example.env_vars=["EXAMPLE_TOKEN"]',
  );
  expect(options.args).toContain("mcp_servers.example.required=true");
  expect(options.args!.join(" ")).not.toContain("fixture-secret");
});

it("rejects conflicting native MCP environments before starting a process", async () => {
  const spawn = vi.fn(async (_options: AgentProcessSpawnOptions) => {
    throw new Error("must not launch");
  });
  const runtime = new CodexNativeRuntime({ available: true, spawn });
  await expect(
    runtime.start({
      prompt: "",
      mcpServers: [
        { name: "first", command: "first", env: { SHARED_TOKEN: "one" } },
        { name: "second", command: "second", env: { SHARED_TOKEN: "two" } },
      ],
    }),
  ).rejects.toThrow("Conflicting native MCP environment variable");
  expect(spawn).not.toHaveBeenCalled();
});
