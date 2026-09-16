import { expect, it } from "vitest";
import { ControllerRuntime, type AgentEvent } from "./runtime.js";
import { ControllerClient } from "./client.js";
import { ControllerError } from "./contracts.js";
import { ControllerStore } from "./persistence/store.js";
import { Controller } from "./domain/engine.js";
import type { ExecutionContext } from "./domain/ports.js";
import { serveController } from "./transport/server.js";

const token = "test-controller-runtime-token-at-least-32";
async function fixture(execute: (context: ExecutionContext) => Promise<void>) {
  const store = new ControllerStore(":memory:");
  const controller = new Controller(
    store,
    new Map([
      [
        "test",
        {
          capabilities: {
            driver: "test",
            content: ["text" as const],
            configuration: true,
            resume: "context" as const,
            approvals: true,
            input: true,
            tools: true,
          },
          execute,
          close: async () => {},
        },
      ],
    ]),
  );
  const server = await serveController(controller, {
    credentials: [
      {
        token,
        principal: {
          id: "owner",
          providers: ["test"],
          workspaces: ["workspace"],
        },
      },
    ],
  });
  const client = new ControllerClient({ url: server.url, token });
  const runtime = new ControllerRuntime({
    id: "test",
    client,
    provider: () => "test",
    workspace: () => "workspace",
  });
  return {
    store,
    controller,
    server,
    client,
    runtime,
    async close() {
      client.dispose();
      await server.close();
      await controller.close();
      store.close();
    },
  };
}

it("preserves transcript order and live approval identity across reconnect without submitting twice", async () => {
  let executions = 0;
  const f = await fixture(async (c) => {
    executions++;
    await c.emit({
      type: "activity",
      data: { type: "thinking", text: "reason" },
    });
    await c.emit({ type: "text", text: "before" });
    const response = await c.interact(
      "approval",
      "native",
      {
        id: "native",
        kind: "execute",
        title: "Run",
        options: [{ id: "once", label: "Allow once", kind: "allow-once" }],
      },
      Date.now() + 5000,
    );
    expect(response).toBe("once");
    await c.emit({
      type: "activity",
      data: { type: "tool.start", name: "tool", id: "call" },
    });
    await c.emit({ type: "text", text: "after" });
    await c.emit({ type: "completed" });
  });
  const session = await f.runtime.start({ prompt: "" });
  const events: AgentEvent[] = [];
  const pump = (async () => {
    for await (const e of session.events()) events.push(e);
  })();
  try {
    expect(f.runtime.capabilities().approvals.policyAmendments).toBe(false);
    await session.send("authored");
    await expect
      .poll(() => events.some((e) => e.type === "permission.request"))
      .toBe(true);
    const approval = events.find((e) => e.type === "permission.request")!;
    expect(
      approval.type === "permission.request" && approval.request.id,
    ).not.toBe("native");
    let ready = false;
    f.client.options.onState = (state) => {
      if (state === "ready") ready = true;
    };
    f.server.disconnectClients();
    await expect.poll(() => ready).toBe(true);
    await session.respondToApproval(
      (approval as Extract<AgentEvent, { type: "permission.request" }>).request
        .id,
      "once",
    );
    await expect.poll(() => events.at(-1)?.type).toBe("completed");
    expect(events.map((e) => e.type)).toEqual([
      "thinking",
      "text",
      "permission.request",
      "tool.start",
      "text",
      "completed",
    ]);
    expect(executions).toBe(1);
    const transcript = (await f.client.snapshot(session.id)).transcript;
    expect(transcript.map((e) => e.type)).toEqual([
      "output.activity",
      "output.text",
      "output.activity",
      "output.text",
    ]);
  } finally {
    await session.close();
    await pump;
    await f.close();
  }
});

it("rejects concurrent sends before acknowledgement and resolves a lost acknowledgement by command identity", async () => {
  let executions = 0;
  const f = await fixture(async (c) => {
    executions++;
    await c.emit({ type: "completed" });
  });
  const submit = f.client.submit.bind(f.client);
  f.client.submit = async (input) => {
    await submit(input);
    throw new ControllerError("disconnected", "Lost ACK");
  };
  const session = await f.runtime.start({ prompt: "" });
  try {
    const first = session.send("first");
    await expect(session.send("second")).rejects.toMatchObject({
      code: "session_busy",
    });
    await first;
    await f.controller.drain();
    // A server drain is not a client-delivery barrier; observe the committed snapshot.
    await f.client.snapshot(session.id);
    expect(executions).toBe(1);
    expect(f.store.turns(session.id)).toHaveLength(1);
    await expect(
      session.send("new", {
        contextBlocks: [
          {
            kind: "memory-recall",
            id: "duplicate",
            content: "x",
            metadata: { memoryId: "x", revision: 1, scope: "user" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "preparation_owned" });
  } finally {
    await session.close();
    await f.close();
  }
});

it("requires a current configuration version and rejects configuration during accepted work", async () => {
  const f = await fixture(async (c) => {
    await c.emit({
      type: "activity",
      data: { type: "status", status: "running" },
    });
    await new Promise<void>((resolve) =>
      c.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await c.emit({ type: "completed", outcome: "cancelled" });
  });
  const session = await f.runtime.start({ prompt: "" });
  try {
    const initial = (await f.client.snapshot(session.id)).thread;
    expect(
      (await session.configure!({ thinking: "high" })).thinking?.status,
    ).toBe("applied");
    await expect(
      f.client.request("threads.configure", {
        threadId: session.id,
        version: initial.version,
        configuration: {},
      }),
    ).rejects.toThrow();
    await session.send("run");
    await expect(session.configure!({ thinking: "low" })).rejects.toThrow();
    await expect
      .poll(() => f.store.turns(session.id)[0]?.state)
      .toBe("running");
    await session.cancel!();
    await f.controller.drain();
  } finally {
    await session.close();
    await f.close();
  }
});

it("renders the stored private-payload marker as an explicit transcript gap", async () => {
  const f = await fixture(async (c) => {
    // This is the wire payload emitted by ControllerStore after volatile data is lost.
    await c.emit({ type: "activity", data: { payloadUnavailable: true } });
    await c.emit({ type: "completed" });
  });
  const session = await f.runtime.start({ prompt: "" });
  const events: AgentEvent[] = [];
  const pump = (async () => {
    for await (const event of session.events()) events.push(event);
  })();
  try {
    await session.send("request");
    await expect
      .poll(() => events.some((event) => event.type === "completed"))
      .toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "status" &&
          event.status === "Private transcript payload is unavailable",
      ),
    ).toBe(true);
  } finally {
    await session.close();
    await pump;
    await f.close();
  }
});

it("defers application context until workspace admission and authorizes the prepared revision", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: ExecutionContext[] = [];
  const f = await fixture(async (context) => {
    seen.push(context);
    if (context.preparation.text === "first") await gate;
    await context.emit({ type: "completed" });
  });
  const first = await f.runtime.start({ prompt: "" });
  const second = await f.runtime.start({ prompt: "" });
  let revision = 1;
  let prepared = 0;
  let authorized = 0;
  try {
    await first.send("first");
    await expect.poll(() => seen.length).toBe(1);
    await second.send("second", {
      prepareContext: async () => {
        prepared++;
        return [
          {
            kind: "memory-recall",
            id: "record",
            content: `revision ${revision}`,
            metadata: { memoryId: "record", revision, scope: "workspace" },
          },
        ];
      },
      authorizeContext: async () => {
        authorized++;
        return revision === 2;
      },
    });
    expect(prepared).toBe(0);
    revision = 2;
    release();
    await f.controller.drain();
    expect(prepared).toBe(1);
    expect(authorized).toBe(1);
    expect(seen[1]?.preparation.text).toBe("second");
    expect(seen[1]?.preparation.blocks[0]).toMatchObject({
      content: "revision 2",
      revision: "2",
      kind: "memory",
      trust: "reference",
    });
  } finally {
    release();
    await first.close();
    await second.close();
    await f.close();
  }
});

it("supplies external MCP configuration without persisting its environment", async () => {
  let observed = false;
  const f = await fixture(async (context) => {
    expect(context.mcpServers).toEqual([
      {
        name: "external",
        command: "external-mcp",
        env: { FIXTURE_SECRET: "mcp-private-test-value" },
      },
    ]);
    observed = true;
    await context.emit({ type: "completed" });
  });
  f.controller.providers.get("test")!.capabilities.externalMcp = true;
  const session = await f.runtime.start({
    prompt: "",
    mcpServers: [
      {
        name: "external",
        command: "external-mcp",
        env: { FIXTURE_SECRET: "mcp-private-test-value" },
      },
    ],
  });
  try {
    await session.send("request");
    await f.controller.drain();
    expect(observed).toBe(true);
    const snapshot = f.store.snapshot("owner", session.id);
    expect(JSON.stringify(snapshot)).not.toContain("mcp-private-test-value");
    expect(
      JSON.stringify(f.store.preparation(snapshot.turns[0]!.id)),
    ).not.toContain("mcp-private-test-value");
    expect(
      JSON.stringify(
        f.store.events("owner", session.id, `${f.store.epoch}:0`, 1000),
      ),
    ).not.toContain("mcp-private-test-value");
  } finally {
    await session.close();
    await f.close();
  }
});

it("fails restricted and malformed MCP configuration before executing a provider", async () => {
  let executions = 0;
  const f = await fixture(async () => {
    executions++;
  });
  f.controller.providers.get("test")!.capabilities.externalMcp = true;
  const unregister = await f.client.registerEndpoint({
    id: "external",
    mcp: true,
    handle: async () => [{ name: "mcp", command: "external-mcp" }],
  });
  try {
    const thread = await f.client.createThread({
      provider: "test",
      workspace: "workspace",
      mcpEndpoint: "external",
      configuration: { restricted: true },
    });
    const receipt = await f.client.submit({
      threadId: thread.id,
      commandId: "restricted",
      text: "request",
    });
    await f.controller.drain();
    expect(f.store.turn(receipt.turnId)).toMatchObject({
      state: "failed",
      error: "mcp_unsupported",
    });
    await unregister();
    await f.client.registerEndpoint({
      id: "external",
      mcp: true,
      handle: async () => [{ name: "mcp", command: 42 }],
    });
    const second = await f.client.createThread({
      provider: "test",
      workspace: "workspace",
      mcpEndpoint: "external",
    });
    const invalid = await f.client.submit({
      threadId: second.id,
      commandId: "invalid",
      text: "request",
    });
    await f.controller.drain();
    expect(f.store.turn(invalid.turnId)).toMatchObject({
      state: "failed",
      error: "invalid_mcp",
    });
    expect(executions).toBe(0);
  } finally {
    await f.close();
  }
});

it("rejects resumed threads when application scope bindings change", async () => {
  const f = await fixture(async (c) => {
    await c.emit({ type: "completed" });
  });
  const original = {
    externalRef: "conversation-a",
    toolEndpoint: "tools-a",
    memoryEndpoint: "memory-a",
    contextSources: ["scope-a"],
    payloadPolicy: "metadata-only" as const,
  };
  let binding: NonNullable<
    Awaited<
      ReturnType<
        NonNullable<import("./runtime.js").ControllerRuntimeOptions["prepare"]>
      >
    >["thread"]
  > = original;
  const runtime = new ControllerRuntime({
    id: "test",
    client: f.client,
    provider: () => "test",
    workspace: () => "workspace",
    prepare: async () => ({ thread: binding }),
  });
  try {
    const first = await runtime.start({ prompt: "" });
    const id = first.id;
    await first.close();
    for (const change of [
      { externalRef: "conversation-b" },
      { toolEndpoint: "tools-b" },
      { memoryEndpoint: "memory-b" },
      { contextSources: ["scope-b"] },
      { payloadPolicy: "durable" as const },
    ]) {
      binding = { ...original, ...change };
      const attempt = runtime.resume(id);
      // Clean up an incorrectly accepted resume so this regression does not leak a subscription.
      void attempt.then(
        (session) => session.close(),
        () => {},
      );
      await expect(attempt).rejects.toMatchObject({ code: "binding_mismatch" });
    }
    binding = original;
    const resumed = await runtime.resume(id);
    await resumed.close();
  } finally {
    await f.close();
  }
});
