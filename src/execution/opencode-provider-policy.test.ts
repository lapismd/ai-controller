import { expect, it, vi } from "vitest";
import type { ExecutionContext } from "../domain/ports.js";
import { OpenCodeProvider } from "./opencode.js";
import type { OpenCodeServer } from "./opencode-server.js";

function context(approvalPolicy: "ask" | "allow-all"): ExecutionContext {
  return {
    thread: { id: "thread", workspace: "root" },
    turn: { id: `turn-${approvalPolicy}` },
    preparation: { text: "Work", blocks: [], configuration: { approvalPolicy } },
    tools: [],
    signal: new AbortController().signal,
    dispatch: async () => {},
    emit: async () => {},
    bindSession: async () => {},
    callTool: async () => ({ content: [] }),
    interact: async () => "allow_once",
  } as unknown as ExecutionContext;
}

it("creates OpenCode sessions with native policy and replaces a changed warm session", async () => {
  const created: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  let active = "";
  const server = {
    json: vi.fn(async (path: string, method: string, body: unknown) => {
      if (path === "/session" && method === "POST") {
        active = `ses_${created.length + 1}`;
        created.push(body as Record<string, unknown>);
        return { id: active };
      }
      if (method === "DELETE") deleted.push(path);
      return {};
    }),
    request: vi.fn(async (path: string) => path === "/event"
      ? new Response(`data: {"type":"session.idle","properties":{"sessionID":"${active}"}}\n\n`)
      : new Response(null, { status: 204 })),
    close: vi.fn(async () => {}),
  } as unknown as OpenCodeServer;
  const provider = new OpenCodeProvider({ root: "/tmp" }, async () => server);
  try {
    await provider.execute(context("allow-all"));
    await provider.execute(context("allow-all"));
    await provider.execute(context("ask"));
    expect(created).toHaveLength(2);
    expect(created[0]?.permission).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);
    expect(created[1]?.permission).toEqual(
      expect.arrayContaining([
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "read", pattern: "*", action: "allow" },
      ]),
    );
    expect(deleted).toEqual(["/session/ses_1"]);
  } finally {
    await provider.close();
  }
});
