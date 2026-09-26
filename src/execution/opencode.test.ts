import { describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "../domain/ports.js";
import { consumeOpenCodeEvents, type OpenCodeEvent } from "./opencode-events.js";
import { OpenCodeProvider } from "./opencode.js";
import type { OpenCodeServer } from "./opencode-server.js";
import { AcpWorkerPool } from "./acp-worker-pool.js";

function context(overrides: Partial<ExecutionContext> = {}) {
  const emitted: unknown[] = [];
  const result = {
    thread: { id: "thread", workspace: "root" },
    preparation: { text: "Hello", blocks: [], configuration: {} },
    tools: [],
    mcpServers: [],
    signal: new AbortController().signal,
    dispatch: vi.fn(async () => {}),
    emit: vi.fn(async (event: unknown) => { emitted.push(event); }),
    interact: vi.fn(async () => "allow_once"),
    ...overrides,
  } as unknown as ExecutionContext;
  return { result, emitted };
}

describe("OpenCode Native", () => {
  it("creates a session, sends a prompt and projects only that session's text", async () => {
    const requests: string[] = [];
    const server = {
      json: vi.fn(async (path: string) => {
        if (path === "/session") return { id: "ses_one" };
        return { all: [] };
      }),
      request: vi.fn(async (path: string) => {
        requests.push(path);
        if (path === "/event") return new Response([
          'data: {"type":"session.next.text.delta","properties":{"sessionID":"ses_other","textID":"other","delta":"wrong"}}',
          'data: {"type":"session.next.text.delta","properties":{"sessionID":"ses_one","textID":"text","assistantMessageID":"msg_one","delta":"Hello back"}}',
          'data: {"type":"session.idle","properties":{"sessionID":"ses_one"}}',
          "",
        ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } });
        return new Response(null, { status: 204 });
      }),
      close: vi.fn(async () => {}),
    } as unknown as OpenCodeServer;
    const provider = new OpenCodeProvider({ root: "/tmp/opencode-probe" }, async () => server);
    const { result, emitted } = context();
    await provider.execute(result);
    expect(requests).toContain("/session/ses_one/prompt_async");
    expect(emitted).toContainEqual({ type: "text", text: "Hello back", messageId: "msg_one" });
    expect(emitted).toContainEqual({ type: "completed" });
    expect(JSON.stringify(emitted)).not.toContain("wrong");
    await provider.close();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("routes a session permission through the controller and replies once", async () => {
    const replies: unknown[] = [];
    const server = {
      json: vi.fn(async (_path: string, _method: string, body: unknown) => { replies.push(body); }),
    } as unknown as OpenCodeServer;
    const { result, emitted } = context();
    async function* events(): AsyncGenerator<OpenCodeEvent> {
      yield { type: "permission.asked", properties: { id: "per_one", sessionID: "ses_one", permission: "edit", patterns: ["file"], metadata: {}, always: [] } };
      yield { type: "permission.asked", properties: { id: "per_one", sessionID: "ses_one", permission: "edit", patterns: ["file"], metadata: {}, always: [] } };
      yield { type: "session.idle", properties: { sessionID: "ses_one" } };
    }
    await consumeOpenCodeEvents(events(), server, "ses_one", result);
    expect(result.interact).toHaveBeenCalledWith("approval", "per_one", expect.any(Object), expect.any(Number));
    expect(replies).toEqual([{ reply: "once" }]);
    expect(emitted).toContainEqual({ type: "completed" });
  });

  it("fails when the event stream closes before a terminal event", async () => {
    const { result } = context();
    async function* events(): AsyncGenerator<OpenCodeEvent> {
      yield { type: "message.part.updated", properties: { sessionID: "ses_one", part: { id: "part", type: "text", text: "partial" } } };
    }
    await expect(consumeOpenCodeEvents(events(), {} as OpenCodeServer, "ses_one", result))
      .rejects.toThrow("ended before");
  });

  it("evicts an idle server before opening another workspace", async () => {
    const closed: string[] = [];
    const started: string[] = [];
    const provider = new OpenCodeProvider(
      { one: "/tmp/open-one", two: "/tmp/open-two" },
      async (workspace) => {
        started.push(workspace);
        return {
          json: vi.fn(async (path: string) => path === "/session" ? { id: `ses_${started.length}` } : { all: [] }),
          request: vi.fn(async (path: string) => path === "/event"
            ? new Response(`data: {"type":"session.idle","properties":{"sessionID":"ses_${started.length}"}}\n\n`)
            : new Response(null, { status: 204 })),
          close: vi.fn(async () => { closed.push(workspace); }),
        } as unknown as OpenCodeServer;
      },
      { workerPool: new AcpWorkerPool(1) },
    );
    await provider.execute(context({ thread: { id: "first", workspace: "one" } as ExecutionContext["thread"] }).result);
    await provider.execute(context({ thread: { id: "second", workspace: "two" } as ExecutionContext["thread"] }).result);
    expect(started).toEqual(["/tmp/open-one", "/tmp/open-two"]);
    expect(closed).toEqual(["/tmp/open-one"]);
    await provider.close();
  });

  it("gives different threads separate application MCP credentials", async () => {
    const mcpConfigs: unknown[] = [];
    let count = 0;
    const provider = new OpenCodeProvider(
      { root: "/tmp/opencode-probe" },
      async () => {
        const id = `ses_${++count}`;
        return {
          json: vi.fn(async (path: string, _method: string, body: unknown) => {
            if (path === "/mcp") mcpConfigs.push(body);
            return path === "/session" ? { id } : {};
          }),
          request: vi.fn(async (path: string) => path === "/event"
            ? new Response(`data: {"type":"session.idle","properties":{"sessionID":"${id}"}}\n\n`)
            : new Response(null, { status: 204 })),
          close: vi.fn(async () => {}),
        } as unknown as OpenCodeServer;
      },
    );
    const tools = [{ name: "notes_read", description: "Read a note", inputSchema: { type: "object" }, effect: "read" }] as ExecutionContext["tools"];
    await provider.execute(context({ thread: { id: "first", workspace: "root" } as ExecutionContext["thread"], tools }).result);
    await provider.execute(context({ thread: { id: "second", workspace: "root" } as ExecutionContext["thread"], tools }).result);
    expect(count).toBe(2);
    const credentials = mcpConfigs.map((value) => (value as { config: { headers: Record<string, string> } }).config.headers);
    expect(credentials).toHaveLength(2);
    expect(credentials[0]).not.toEqual(credentials[1]);
    await provider.close();
  });
});
