import { describe, expect, it } from "vitest";
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
