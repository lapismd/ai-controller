import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerStore } from "../persistence/store.js";
import { Controller } from "./engine.js";
import type { ExecutionProvider } from "./ports.js";

const capabilities = {
  driver: "fake",
  content: ["text" as const],
  configuration: false,
  resume: "none" as const,
  approvals: true,
  input: true,
  tools: true,
};
describe("controller execution", () => {
  it("serializes workspace turns, prepares each once, and captures early output", async () => {
    const store = new ControllerStore(":memory:");
    let running = 0;
    let peak = 0;
    let prepared = 0;
    const provider: ExecutionProvider = {
      capabilities,
      close: async () => {},
      execute: async (c) => {
        peak = Math.max(peak, ++running);
        await c.emit({
          type: "text",
          text: c.preparation.text,
          sourceId: "chunk",
        });
        await c.emit({ type: "text", text: "duplicate", sourceId: "chunk" });
        running--;
        await c.emit({ type: "completed" });
      },
    };
    const controller = new Controller(store, new Map([["fake", provider]]));
    controller.registerContext("owner", "context", {
      required: true,
      resolve: async () => {
        prepared++;
        return [
          {
            id: "source",
            revision: "1",
            kind: "application",
            content: "context",
            trust: "reference",
          },
        ];
      },
      authorize: async () => true,
    });
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "root",
      contextSources: ["context"],
    });
    const a = controller.submit("owner", {
      threadId: thread.id,
      commandId: "a",
      text: "one",
    });
    controller.submit("owner", {
      threadId: thread.id,
      commandId: "a",
      text: "one",
    });
    controller.submit("owner", {
      threadId: thread.id,
      commandId: "b",
      text: "two",
    });
    await controller.drain();
    expect(peak).toBe(1);
    expect(prepared).toBe(2);
    expect(store.turns(thread.id).map((t) => t.state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(store.turn(a.turnId)?.output).toContain("one");
    expect(store.turn(a.turnId)?.output).not.toContain("duplicate");
    await controller.close();
    store.close();
  });
  it("persists a pending approval, validates identity, and rejects a late response", async () => {
    const store = new ControllerStore(":memory:");
    let notify!: () => void;
    const waiting = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const provider: ExecutionProvider = {
      capabilities,
      close: async () => {},
      execute: async (c) => {
        const response = c.interact(
          "approval",
          "native-1",
          { options: ["allow_once", "reject_once"] },
          Date.now() + 5000,
        );
        notify();
        await response;
        await c.emit({ type: "completed" });
      },
    };
    const controller = new Controller(store, new Map([["fake", provider]]));
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "root",
    });
    controller.submit("owner", {
      threadId: thread.id,
      commandId: "a",
      text: "one",
    });
    await waiting;
    await expect.poll(() => store.interactions(thread.id).length).toBe(1);
    const interaction = store.interactions(thread.id)[0]!;
    expect(() =>
      controller.respond("other", interaction.id, "allow_once"),
    ).toThrow();
    expect(() =>
      controller.respond("owner", interaction.id, "invented"),
    ).toThrow();
    controller.respond("owner", interaction.id, "allow_once");
    await controller.drain();
    expect(() =>
      controller.respond("owner", interaction.id, "allow_once"),
    ).toThrow();
    await controller.close();
    store.close();
  });
  it("records unknown non-idempotent effects without retrying them", async () => {
    const store = new ControllerStore(":memory:");
    let calls = 0;
    const provider: ExecutionProvider = {
      capabilities,
      close: async () => {},
      execute: async (c) => {
        await c.callTool("mutate", {});
        await c.emit({ type: "completed" });
      },
    };
    const controller = new Controller(store, new Map([["fake", provider]]));
    controller.registerTools("owner", "tools", {
      definitions: [
        {
          name: "mutate",
          description: "write",
          effect: "write",
          inputSchema: { type: "object" },
        },
      ],
      execute: async () => {
        calls++;
        throw new Error("ack lost with sensitive content");
      },
    });
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "root",
      toolEndpoint: "tools",
    });
    controller.submit("owner", {
      threadId: thread.id,
      commandId: "a",
      text: "one",
    });
    await controller.drain();
    expect(calls).toBe(1);
    expect(store.interactions(thread.id)[0]?.state).toBe("unknown");
    expect(JSON.stringify(store.durableRows())).not.toContain(
      "sensitive content",
    );
    await controller.close();
    store.close();
  });
  it("rechecks preparation authorization before dispatch and never runs revoked context", async () => {
    const store = new ControllerStore(":memory:");
    let calls = 0;
    const controller = new Controller(
      store,
      new Map([
        [
          "fake",
          {
            capabilities,
            close: async () => {},
            execute: async () => {
              calls++;
            },
          },
        ],
      ]),
    );
    controller.registerContext("owner", "context", {
      required: true,
      resolve: async () => [
        {
          id: "secret",
          revision: "1",
          kind: "application",
          content: "revoked",
          trust: "reference",
        },
      ],
      authorize: async () => false,
    });
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "root",
      contextSources: ["context"],
    });
    const receipt = controller.submit("owner", {
      threadId: thread.id,
      commandId: "a",
      text: "one",
    });
    await controller.drain();
    expect(calls).toBe(0);
    expect(store.turn(receipt.turnId)?.error).toBe("context_revoked");
    await controller.close();
    store.close();
  });
  it("shares the workspace lock across provider instances and reuses native tool outcomes", async () => {
    const store = new ControllerStore(":memory:");
    let active = 0;
    let peak = 0;
    let effects = 0;
    const provider: ExecutionProvider = {
      capabilities,
      close: async () => {},
      execute: async (c) => {
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        const result = await c.callTool("write", {}, "one-call");
        expect(await c.callTool("write", {}, "one-call")).toEqual(result);
        active--;
        await c.emit({ type: "completed" });
      },
    };
    const controller = new Controller(
      store,
      new Map([
        ["a", provider],
        ["b", provider],
      ]),
    );
    controller.registerTools("owner", "tools", {
      definitions: [
        {
          name: "write",
          description: "write",
          effect: "write",
          inputSchema: { type: "object" },
        },
      ],
      execute: async () => {
        effects++;
        return { content: "done" };
      },
    });
    for (const id of ["a", "b"]) {
      const thread = store.createThread("owner", {
        provider: id,
        workspace: "shared",
        toolEndpoint: "tools",
      });
      controller.submit("owner", {
        threadId: thread.id,
        commandId: id,
        text: id,
      });
    }
    await controller.drain();
    expect(peak).toBe(1);
    expect(effects).toBe(2);
    await controller.close();
    store.close();
  });
});

it("classifies a provider setup failure before prompt dispatch as failed", async () => {
  const store = new ControllerStore(":memory:");
  const controller = new Controller(
    store,
    new Map([
      [
        "fake",
        {
          capabilities,
          close: async () => {},
          execute: async () => {
            throw new Error("Provider setup failed");
          },
        },
      ],
    ]),
  );
  try {
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "root",
    });
    const receipt = controller.submit("owner", {
      threadId: thread.id,
      commandId: "setup",
      text: "authored",
    });
    await controller.drain();
    expect(store.turn(receipt.turnId)?.state).toBe("failed");
  } finally {
    await controller.close();
    store.close();
  }
});

it("fences uncertain workspace execution until an explicit stopped-work resolution", async () => {
  const store = new ControllerStore(":memory:");
  let calls = 0;
  const controller = new Controller(
    store,
    new Map([
      [
        "fake",
        {
          capabilities,
          close: async () => {},
          execute: async (c) => {
            calls++;
            await c.emit({ type: "text", text: "started" });
            if (calls === 1) throw new Error("Native connection lost");
            await c.emit({ type: "completed" });
          },
        },
      ],
    ]),
  );
  try {
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "root",
    });
    const first = controller.submit("owner", {
      threadId: thread.id,
      commandId: "first",
      text: "one",
    });
    const second = controller.submit("owner", {
      threadId: thread.id,
      commandId: "second",
      text: "two",
    });
    await controller.drain();
    expect(store.turn(first.turnId)?.state).toBe("interrupted");
    expect(store.turn(second.turnId)?.state).toBe("queued");
    expect(calls).toBe(1);
    expect(() =>
      controller.resolve("owner", first.turnId, "failed", false),
    ).toThrow("stopped");
    controller.resolve("owner", first.turnId, "failed", true);
    await controller.drain();
    expect(store.turn(second.turnId)?.state).toBe("completed");
    expect(calls).toBe(2);
    expect(
      controller.submit("owner", {
        threadId: thread.id,
        commandId: "first",
        text: "one",
      }),
    ).toEqual(first);
    expect(
      store.events(
        "owner",
        thread.id,
        store.snapshot("owner", thread.id).cursor,
        100,
      ),
    ).toEqual([]);
  } finally {
    await controller.close();
    store.close();
  }
});

it("keeps an uncertain workspace fenced after a database restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "controller-fence-"));
  const path = join(root, "controller.sqlite");
  let store = new ControllerStore(path);
  let executions = 0;
  const thread = store.createThread("owner", {
    provider: "fake",
    workspace: "root",
  });
  const first = store.accept("owner", {
    threadId: thread.id,
    commandId: "first",
    text: "one",
  });
  const next = store.accept("owner", {
    threadId: thread.id,
    commandId: "next",
    text: "two",
  });
  store.transition(first.turnId, "dispatching");
  store.close();
  store = new ControllerStore(path);
  const controller = new Controller(
    store,
    new Map([
      [
        "fake",
        {
          capabilities,
          close: async () => {},
          execute: async (c) => {
            executions++;
            await c.dispatch();
            await c.emit({ type: "completed" });
          },
        },
      ],
    ]),
  );
  try {
    controller.start();
    await controller.drain();
    expect(store.turn(first.turnId)?.state).toBe("submission-unknown");
    expect(store.turn(next.turnId)?.state).toBe("queued");
    expect(executions).toBe(0);
    expect(() =>
      controller.resolve("outsider", first.turnId, "failed", true),
    ).toThrow("not found");
    controller.resolve("owner", first.turnId, "cancelled", true);
    await controller.drain();
    expect(executions).toBe(1);
    expect(store.turn(next.turnId)?.state).toBe("completed");
  } finally {
    await controller.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not invoke application tools for native observed activity", async () => {
  const store = new ControllerStore(":memory:");
  let executed = 0;
  const controller = new Controller(
    store,
    new Map([
      [
        "fake",
        {
          capabilities,
          close: async () => {},
          execute: async (c) => {
            await c.emit({
              type: "activity",
              data: { type: "tool.start", name: "mcp_search" },
            });
            await c.emit({ type: "completed" });
          },
        },
      ],
    ]),
  );
  controller.registerTools("owner", "tools", {
    definitions: [
      {
        name: "mcp_search",
        description: "search",
        effect: "read",
        inputSchema: { type: "object" },
      },
    ],
    execute: async () => {
      executed++;
      return { content: "should not run" };
    },
  });
  const thread = store.createThread("owner", {
    provider: "fake",
    workspace: "root",
    toolEndpoint: "tools",
  });
  controller.submit("owner", {
    threadId: thread.id,
    commandId: "observe",
    text: "look",
  });
  await controller.drain();
  expect(executed).toBe(0);
  expect(store.interactions(thread.id)).toEqual([]);
  expect(
    store
      .events("owner", thread.id, `${store.epoch}:0`)
      .some((event) => event.type === "output.activity"),
  ).toBe(true);
  await controller.close();
  store.close();
});

it("wraps mutating tools with cooperative capture and fails closed when capture is unavailable", async () => {
  const store = new ControllerStore(":memory:");
  let executed = 0;
  const begins: string[] = [];
  const finishes: string[] = [];
  const capture = {
    async begin(input: { toolName: string; captureMode: string }) {
      begins.push(`${input.captureMode}:${input.toolName}`);
      return { spanId: "span-1" };
    },
    async finish(input: { outcome: string }) {
      finishes.push(input.outcome);
    },
  };
  const provider: ExecutionProvider = {
    capabilities,
    close: async () => {},
    execute: async (c) => {
      await c.callTool("write", {});
      await c.emit({ type: "completed" });
    },
  };
  const controller = new Controller(
    store,
    new Map([["fake", provider]]),
    4,
    capture,
  );
  controller.registerTools("owner", "tools", {
    definitions: [
      {
        name: "write",
        description: "write",
        effect: "write",
        inputSchema: { type: "object" },
      },
    ],
    execute: async () => {
      executed++;
      return { content: "ok" };
    },
  });
  const thread = store.createThread("owner", {
    provider: "fake",
    workspace: "root",
    toolEndpoint: "tools",
  });
  controller.submit("owner", {
    threadId: thread.id,
    commandId: "a",
    text: "write",
  });
  await controller.drain();
  expect(begins).toEqual(["cooperative:write"]);
  expect(finishes).toEqual(["succeeded"]);
  expect(executed).toBe(1);
  await controller.close();
  store.close();

  const blocked = new ControllerStore(":memory:");
  let blockedExec = 0;
  const failing = new Controller(
    blocked,
    new Map([
      [
        "fake",
        {
          capabilities,
          close: async () => {},
          execute: async (c) => {
            await c.callTool("write", {});
            await c.emit({ type: "completed" });
          },
        },
      ],
    ]),
    4,
    {
      begin: async () => {
        throw new Error("capture down");
      },
      finish: async () => {},
    },
  );
  failing.registerTools("owner", "tools", {
    definitions: [
      {
        name: "write",
        description: "write",
        effect: "write",
        inputSchema: { type: "object" },
      },
    ],
    execute: async () => {
      blockedExec++;
      return { content: "should not run" };
    },
  });
  const blockedThread = blocked.createThread("owner", {
    provider: "fake",
    workspace: "root",
    toolEndpoint: "tools",
  });
  failing.submit("owner", {
    threadId: blockedThread.id,
    commandId: "b",
    text: "write",
  });
  await failing.drain();
  expect(blockedExec).toBe(0);
  expect(blocked.interactions(blockedThread.id)[0]?.state).toBe("unknown");
  await failing.close();
  blocked.close();
});

it("records observed activity without exclusive capture", async () => {
  const store = new ControllerStore(":memory:");
  const observed: unknown[] = [];
  const begins: string[] = [];
  const controller = new Controller(
    store,
    new Map([
      [
        "fake",
        {
          capabilities,
          close: async () => {},
          execute: async (c) => {
            await c.emit({
              type: "activity",
              data: { type: "tool.start", name: "mcp_search" },
            });
            await c.emit({ type: "completed" });
          },
        },
      ],
    ]),
    4,
    {
      begin: async (input) => {
        begins.push(input.captureMode);
        return { spanId: "should-not-run" };
      },
      finish: async () => {},
      observe: async (input) => {
        observed.push(input.payload);
      },
    },
  );
  const thread = store.createThread("owner", {
    provider: "fake",
    workspace: "root",
  });
  controller.submit("owner", {
    threadId: thread.id,
    commandId: "observe",
    text: "look",
  });
  await controller.drain();
  expect(begins).toEqual([]);
  expect(observed).toEqual([{ type: "status", status: "Tool running", pending: true }]);
  expect(store.snapshot("owner", thread.id).transcript.some(event => JSON.stringify(event.data).includes("mcp_search"))).toBe(false);
  await controller.close();
  store.close();
});
