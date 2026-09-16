import { describe, expect, it } from "vitest";
import { ControllerStore } from "../persistence/store.js";
import { Controller } from "../domain/engine.js";
import { ControllerClient } from "../client.js";
import { serveController } from "./server.js";
const token = "test-credential-with-at-least-32-characters";
describe("shared remote client", () => {
  it("authenticates objects, streams committed state, reconnects without executing twice", async () => {
    const store = new ControllerStore(":memory:");
    let executions = 0;
    const controller = new Controller(
      store,
      new Map([
        [
          "fake",
          {
            capabilities: {
              driver: "fake",
              content: ["text" as const],
              configuration: false,
              resume: "none" as const,
              approvals: false,
              input: false,
              tools: true,
            },
            close: async () => {},
            execute: async (c) => {
              executions++;
              await c.emit({ type: "text", text: "answer" });
              await c.emit({ type: "completed" });
            },
          },
        ],
      ]),
    );
    const server = await serveController(controller, {
      credentials: [
        {
          token,
          principal: { id: "owner", providers: ["fake"], workspaces: ["root"] },
        },
      ],
    });
    const client = new ControllerClient({ url: server.url, token });
    const bad = new ControllerClient({ url: server.url, token: "wrong" });
    try {
      await expect(bad.connect()).rejects.toThrow();
      await expect(
        client.createThread({ provider: "fake", workspace: "forbidden" }),
      ).rejects.toThrow();
      const thread = await client.createThread({
        provider: "fake",
        workspace: "root",
      });
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      await client.subscribe(thread.id, (snapshot) => {
        if (snapshot.turns[0]?.state === "completed") complete();
      });
      const receipt = await client.submit({
        threadId: thread.id,
        commandId: "once",
        text: "hello",
      });
      await completed;
      await controller.drain();
      server.disconnectClients();
      let reconnected!: () => void;
      const ready = new Promise<void>((resolve) => {
        reconnected = resolve;
      });
      client.options.onState = (state) => {
        if (state === "ready") reconnected();
      };
      await ready;
      expect((await client.getTurn(receipt.turnId)).output).toBe("answer");
      expect(executions).toBe(1);
      expect(
        await client.submit({
          threadId: thread.id,
          commandId: "once",
          text: "hello",
        }),
      ).toEqual(receipt);
    } finally {
      client.dispose();
      bad.dispose();
      await server.close();
      await controller.close();
      store.close();
    }
  });
  it("executes application tools over an authenticated endpoint", async () => {
    const store = new ControllerStore(":memory:");
    let called = "";
    const controller = new Controller(
      store,
      new Map([
        [
          "fake",
          {
            capabilities: {
              driver: "fake",
              content: ["text" as const],
              configuration: false,
              resume: "none" as const,
              approvals: false,
              input: false,
              tools: true,
            },
            close: async () => {},
            execute: async (c) => {
              const result = await c.callTool("read", {});
              await c.emit({ type: "text", text: String(result.content) });
              await c.emit({ type: "completed" });
            },
          },
        ],
      ]),
    );
    const server = await serveController(controller, {
      credentials: [
        {
          token,
          principal: { id: "owner", providers: ["fake"], workspaces: ["root"] },
        },
      ],
    });
    const client = new ControllerClient({ url: server.url, token });
    try {
      const unregister = await client.registerEndpoint({
        id: "app",
        tools: [
          {
            name: "read",
            description: "Read",
            inputSchema: { type: "object" },
            effect: "read",
          },
        ],
        handle: async (request) => {
          called = request.operation;
          return { content: "domain-data" };
        },
      });
      const thread = await client.createThread({
        provider: "fake",
        workspace: "root",
        toolEndpoint: "app",
      });
      const receipt = await client.submit({
        threadId: thread.id,
        commandId: "once",
        text: "hello",
      });
      await controller.drain();
      expect(called).toBe("tool.execute");
      expect((await client.getTurn(receipt.turnId)).output).toBe("domain-data");
      await unregister();
      const revoked = await client.submit({
        threadId: thread.id,
        commandId: "revoked",
        text: "hello",
      });
      await controller.drain();
      expect((await client.getTurn(revoked.turnId)).error).toBe(
        "tools_unavailable",
      );
    } finally {
      client.dispose();
      await server.close();
      await controller.close();
      store.close();
    }
  });
  it("prepares recall once through the remote adapter and exposes scoped memory tools", async () => {
    const store = new ControllerStore(":memory:");
    let recalls = 0;
    const controller = new Controller(
      store,
      new Map([
        [
          "fake",
          {
            capabilities: {
              driver: "fake",
              content: ["text" as const],
              configuration: false,
              resume: "none" as const,
              approvals: false,
              input: false,
              tools: true,
            },
            close: async () => {},
            execute: async (c) => {
              expect(c.preparation.blocks[0]?.kind).toBe("memory");
              expect(c.preparation.text).toBe("authored text");
              await c.callTool("memory_get", { ref: "record" }, "native-once");
              await c.emit({ type: "completed" });
            },
          },
        ],
      ]),
    );
    const server = await serveController(controller, {
      credentials: [
        {
          token,
          principal: { id: "owner", providers: ["fake"], workspaces: ["root"] },
        },
      ],
    });
    const client = new ControllerClient({ url: server.url, token });
    try {
      await client.registerEndpoint({
        id: "memories",
        memory: { profile: "lapis-v1" },
        handle: async (request) => {
          if (request.operation === "memory.candidates") {
            recalls++;
            return [
              {
                ref: "record",
                revision: "1",
                content: "compact headings",
                active: true,
                curated: true,
                origin: "owner",
                provenance: ["source/entry"],
              },
            ];
          }
          if (request.operation === "memory.authorize") return true;
          return { text: "compact headings", verified: true };
        },
      });
      const thread = await client.createThread({
        provider: "fake",
        workspace: "root",
        memoryEndpoint: "memories",
      });
      const receipt = await client.submit({
        threadId: thread.id,
        commandId: "once",
        text: "authored text",
      });
      await controller.drain();
      expect((await client.getTurn(receipt.turnId)).state).toBe("completed");
      expect(recalls).toBe(1);
      expect(store.preparation(receipt.turnId)?.blocks[0]?.content).toContain(
        "Provenance: source/entry",
      );
      expect(store.interactions(thread.id)).toHaveLength(1);
    } finally {
      client.dispose();
      await server.close();
      await controller.close();
      store.close();
    }
  });
});
