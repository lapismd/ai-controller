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
  it.each(["read", "write"] as const)("executes %s tools with authenticated consumer capture", async (effect) => {
    const store = new ControllerStore(":memory:");
    const called: string[] = [];
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
        capture: true,
        tools: [
          {
            name: "read",
            description: "Read",
            inputSchema: { type: "object" },
            effect,
          },
        ],
        handle: async (request) => {
          called.push(request.operation);
          if (request.operation === "capture.begin") return { spanId: "captured" };
          if (request.operation.startsWith("capture.")) return null;
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
      expect(called).toEqual(effect === "write" ? ["capture.begin", "tool.execute", "capture.finish"] : ["capture.observe", "tool.execute"]);
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
it("cancels a remote tool handler and retains its unknown outcome without redispatch", async () => {
  const store = new ControllerStore(":memory:");
  let invoked = 0;
  let aborted = false;
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
            await c.emit({
              type: "activity",
              data: { type: "status", status: "working" },
            });
            await c.callTool("write", {}, "one-effect");
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
      id: "app",
      tools: [
        {
          name: "write",
          description: "Write",
          inputSchema: { type: "object" },
          effect: "write",
        },
      ],
      handle: async (_request, signal) => {
        invoked++;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { content: "late" };
      },
    });
    const thread = await client.createThread({
      provider: "fake",
      workspace: "root",
      toolEndpoint: "app",
    });
    const receipt = await client.submit({
      threadId: thread.id,
      commandId: "cancel",
      text: "write",
    });
    await expect.poll(() => invoked).toBe(1);
    await client.cancel(receipt.turnId);
    await expect.poll(() => aborted).toBe(true);
    await controller.drain();
    expect(store.interactions(thread.id)[0]?.state).toBe("unknown");
    await client.submit({
      threadId: thread.id,
      commandId: "cancel",
      text: "write",
    });
    expect(invoked).toBe(1);
  } finally {
    client.dispose();
    await server.close();
    await controller.close();
    store.close();
  }
});
it("rejects an unsupported handshake protocol before authenticating", async () => {
  const store = new ControllerStore(":memory:");
  const controller = new Controller(store, new Map());
  const server = await serveController(controller, {
    credentials: [
      {
        token,
        principal: { id: "owner", providers: ["fake"], workspaces: ["root"] },
      },
    ],
  });
  const { WebSocket } = await import("ws");
  const socket = new WebSocket(server.url);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const reply = new Promise<{ error?: { code: string } }>((resolve) => {
      socket.once("message", (raw) =>
        resolve(JSON.parse(String(raw)) as { error?: { code: string } }),
      );
    });
    socket.send(
      JSON.stringify({
        id: "hello",
        method: "hello",
        protocol: "lapis-ai-host/1",
        token,
      }),
    );
    await expect(reply).resolves.toMatchObject({
      error: { code: "protocol_unsupported" },
    });
  } finally {
    socket.close();
    await server.close();
    await controller.close();
    store.close();
  }
});
it("omits recall after a memory endpoint is disposed", async () => {
  const store = new ControllerStore(":memory:");
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
    const dispose = await client.registerEndpoint({
      id: "memories",
      memory: { profile: "lapis-v1" },
      handle: async () => [],
    });
    const thread = await client.createThread({
      provider: "fake",
      workspace: "root",
      memoryEndpoint: "memories",
    });
    await dispose();
    const receipt = await client.submit({
      threadId: thread.id,
      commandId: "after-dispose",
      text: "authored text",
    });
    await controller.drain();
    expect(store.turn(receipt.turnId)?.state).toBe("completed");
    expect(store.preparation(receipt.turnId)?.omitted).toContain(
      "__memory.memories:unavailable",
    );
    await expect(
      controller.readMemory("owner", thread.id, "get", { ref: "record" }),
    ).rejects.toMatchObject({ code: "memory_unavailable" });
  } finally {
    client.dispose();
    await server.close();
    await controller.close();
    store.close();
  }
});
it("replays journal pages before live output and retries a failed domain commit at the same event", async () => {
  const store = new ControllerStore(":memory:");
  const controller = new Controller(store, new Map());
  const server = await serveController(controller, { credentials: [{ token, principal: { id: "owner", providers: ["fake"], workspaces: ["root"] } }] });
  const client = new ControllerClient({ url: server.url, token });
  try {
    const thread = await client.createThread({ provider: "fake", workspace: "root" });
    for (let index = 0; index < 1010; index++) store.append(thread.id, "test", { index });
    const delivered: number[] = [];
    let fail = true;
    let failures = 0;
    const unsubscribe = await client.subscribeJournal(thread.id, { onError() { failures++; } }, event => {
      if (event.type !== "test") return;
      const index = (event.data as { index: number }).index;
      if (index === 500 && fail) { fail = false; throw new Error("Domain commit failed"); }
      delivered.push(index);
    });
    await expect.poll(() => delivered.length, { timeout: 4000 }).toBe(1010);
    expect(failures).toBe(1);
    expect(delivered).toEqual(Array.from({ length: 1010 }, (_, index) => index));
    store.append(thread.id, "test", { index: 1010 });
    await expect.poll(() => delivered.at(-1)).toBe(1010);
    unsubscribe();
  } finally { client.dispose(); await server.close(); await controller.close(); store.close(); }
});

const readToken = "test-read-only-token-at-least-32-chars";
const otherToken = "test-other-app-token-at-least-32-chars";

function fakeController() {
  const store = new ControllerStore(":memory:");
  const controller = new Controller(
    store,
    new Map([
      [
        "fake",
        {
          capabilities: {
            driver: "fake",
            content: ["text" as const],
            configuration: true,
            resume: "none" as const,
            approvals: false,
            input: false,
            tools: true,
          },
          close: async () => {},
          execute: async (c) => {
            if (c.thread.toolEndpoint) {
              try {
                const result = await c.callTool("read", {});
                await c.emit({ type: "text", text: String(result.content) });
              } catch (error) {
                await c.emit({
                  type: "failed",
                  error:
                    error instanceof Error && "code" in error
                      ? String((error as { code: string }).code)
                      : "execution_failed",
                });
                return;
              }
            }
            await c.emit({ type: "completed" });
          },
        },
      ],
    ]),
  );
  return { store, controller };
}

describe("session authorization", () => {
  it("rejects missing scopes, other applications, and memory identity overrides", async () => {
    const { store, controller } = fakeController();
    const seen: unknown[] = [];
    const server = await serveController(controller, {
      credentials: [
        {
          token,
          principal: {
            id: "owner",
            applicationId: "lapis",
            providers: ["fake"],
            workspaces: ["root"],
          },
        },
        {
          token: readToken,
          principal: {
            id: "owner",
            applicationId: "lapis",
            providers: ["fake"],
            workspaces: ["root"],
            scopes: ["threads:read", "providers:read"],
          },
        },
        {
          token: otherToken,
          principal: {
            id: "owner",
            applicationId: "nostr",
            providers: ["fake"],
            workspaces: ["root"],
          },
        },
      ],
    });
    const owner = new ControllerClient({ url: server.url, token });
    const reader = new ControllerClient({ url: server.url, token: readToken });
    const other = new ControllerClient({ url: server.url, token: otherToken });
    try {
      await expect(
        reader.createThread({ provider: "fake", workspace: "root" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const thread = await owner.createThread({
        provider: "fake",
        workspace: "root",
        memoryEndpoint: "memories",
        toolEndpoint: "app",
      });
      expect(thread.application).toBe("lapis");
      const sessionId = owner.sessionId;
      expect(sessionId).toBeTruthy();
      await expect(other.snapshot(thread.id)).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        other.request("events.read", { threadId: thread.id, after: "0:0" }),
      ).rejects.toMatchObject({ code: "not_found" });
      await owner.registerEndpoint({
        id: "memories",
        memory: { profile: "lapis-v1" },
        handle: async (request) => {
          if (request.operation === "memory.search") {
            seen.push(request.payload);
            return [];
          }
          if (request.operation === "memory.authorize") return true;
          return [];
        },
      });
      await owner.request("memory.search", {
        threadId: thread.id,
        input: {
          query: "auth",
          principalId: "intruder",
          workspaceId: "other",
          access: { threadId: "stolen" },
        },
      });
      expect(seen[0]).toMatchObject({
        input: {
          query: "auth",
          access: {
            principalId: "owner",
            applicationId: "lapis",
            workspaceId: "root",
            threadId: thread.id,
          },
        },
      });
      await other.registerEndpoint({
        id: "app",
        tools: [
          {
            name: "read",
            description: "Read",
            inputSchema: { type: "object" },
            effect: "read",
          },
        ],
        handle: async () => ({ content: "leaked" }),
      });
      const receipt = await owner.submit({
        threadId: thread.id,
        commandId: "tools",
        text: "use tools",
      });
      await controller.drain();
      expect((await owner.getTurn(receipt.turnId)).error).toBe(
        "tools_unavailable",
      );
      server.disconnectClients();
      const ready = new Promise<void>((resolve) => {
        owner.options.onState = (state) => {
          if (state === "ready") resolve();
        };
      });
      await ready;
      expect(owner.sessionId).toBe(sessionId);
      expect(
        await owner.submit({
          threadId: thread.id,
          commandId: "tools",
          text: "use tools",
        }),
      ).toMatchObject({ commandId: "tools" });
    } finally {
      owner.dispose();
      reader.dispose();
      other.dispose();
      await server.close();
      await controller.close();
      store.close();
    }
  });

  it("forwards optional providers.models sessionId to the provider", async () => {
    const seen: Array<{ workspace: string; options?: { sessionId?: string } }> =
      [];
    const store = new ControllerStore(":memory:");
    const controller = new Controller(
      store,
      new Map([
        [
          "codex",
          {
            capabilities: {
              driver: "acp",
              content: ["text" as const],
              configuration: false,
              resume: "none" as const,
              approvals: false,
              input: false,
              tools: false,
            },
            models: async (
              workspace: string,
              options?: { sessionId?: string },
            ) => {
              seen.push({ workspace, options });
              return { agent: "codex", models: ["gpt-6"] };
            },
            close: async () => {},
            execute: async () => {},
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
            providers: ["codex"],
            workspaces: ["root"],
          },
        },
      ],
    });
    const client = new ControllerClient({ url: server.url, token });
    try {
      await expect(
        client.request("providers.models", {
          provider: "codex",
          workspace: "root",
        }),
      ).resolves.toEqual({ agent: "codex", models: ["gpt-6"] });
      await expect(
        client.request("providers.models", {
          provider: "codex",
          workspace: "root",
          sessionId: "persisted-session",
        }),
      ).resolves.toEqual({ agent: "codex", models: ["gpt-6"] });
      expect(seen).toEqual([
        { workspace: "root", options: undefined },
        { workspace: "root", options: { sessionId: "persisted-session" } },
      ]);
    } finally {
      client.dispose();
      await server.close();
      await controller.close();
      store.close();
    }
  });
});
