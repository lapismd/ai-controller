import { expect, it, vi } from "vitest";
import type { AgentHostSink, AgentRuntimeExecutor } from "@lapismd/ai-host";
import type { ExecutionContext } from "../domain/ports.js";
import { AcpProvider } from "./acp.js";

function context(
  approvalPolicy: "ask" | "allow-all",
  emitted: unknown[],
): ExecutionContext {
  return {
    thread: { id: "thread", workspace: "root" },
    turn: { id: `turn-${approvalPolicy}` },
    preparation: {
      text: "Work",
      blocks: [],
      configuration: { approvalPolicy, permissionMode: "legacy-full" },
    },
    tools: [],
    signal: new AbortController().signal,
    dispatch: async () => {},
    emit: async (event) => { emitted.push(event); },
    bindSession: async () => {},
    callTool: async () => ({ content: [] }),
    interact: async () => "allow_once",
  } as unknown as ExecutionContext;
}

it("forwards ACP approval policy, reports native application and replaces an incompatible warm session", async () => {
  const starts: Array<Record<string, unknown>> = [];
  const closed: string[] = [];
  const emitted: unknown[] = [];
  let sink: AgentHostSink;
  let sequence = 0;
  let activePolicy: string | undefined;
  const executor = {
    startAcpSession: async (nextSink: AgentHostSink, input: Record<string, unknown>) => {
      sink = nextSink;
      starts.push(input);
      activePolicy = input.approvalPolicy as string | undefined;
      return { sessionId: String(input.sessionId) };
    },
    getAcpSessionStatus: () => ({
      permissionMode: activePolicy === "allow-all"
        ? { requested: "full-access", status: "applied", effective: "--force" }
        : undefined,
    }),
    promptAcpSession: async (_sink: AgentHostSink, sessionId: string) => {
      sink.sendRuntimeEvent({
        sessionId,
        runId: `run-${sequence + 1}`,
        sequence: ++sequence,
        event: { type: "event", event: { type: "done" } },
      });
      return { runId: `run-${sequence}` };
    },
    closeAcpSession: vi.fn(async (sessionId: string) => { closed.push(sessionId); }),
    close: async () => {},
  } as unknown as AgentRuntimeExecutor;
  const provider = new AcpProvider({
    id: "cursor",
    agent: "cursor",
    workspaces: { root: "/tmp" },
    executor,
  });
  try {
    await provider.execute(context("allow-all", emitted));
    await provider.execute(context("allow-all", emitted));
    await provider.execute(context("ask", emitted));
    expect(starts.map((start) => start.approvalPolicy)).toEqual([
      "allow-all",
      "ask",
    ]);
    expect(closed).toHaveLength(1);
    expect(emitted).toContainEqual({
      type: "execution-policy",
      nativeMode: {
        requested: "full-access",
        status: "applied",
        effective: "--force",
      },
    });
  } finally {
    await provider.close();
  }
});
