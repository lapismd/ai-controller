import { expect, it } from "vitest";
import type { ExecutionContext } from "../domain/ports.js";
import { AsyncEventQueue } from "./compat/event-queue.js";
import type { AgentEvent, AgentRequest, AgentSession } from "./compat/types.js";
import { CodexProvider } from "./codex.js";

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

it("replaces a warm Codex session when approval policy changes", async () => {
  const requests: AgentRequest[] = [];
  const closed: string[] = [];
  let next = 0;
  const start = async (request: AgentRequest): Promise<AgentSession> => {
    requests.push(request);
    const id = `native-${++next}`;
    const events = new AsyncEventQueue<AgentEvent>();
    return {
      id,
      runtimeId: "codex-native",
      events: () => events,
      send: async () => { events.push({ type: "completed" }); },
      close: async () => { closed.push(id); events.close(); },
      respondToApproval: async () => {},
    };
  };
  const provider = new CodexProvider(
    { root: "/tmp" },
    { runtime: { start, resume: async (_id, request) => start({ ...request, prompt: "" }) } },
  );
  try {
    await provider.execute(context("allow-all"));
    await provider.execute(context("allow-all"));
    await provider.execute(context("ask"));
    expect(requests.map((request) => request.approvalPolicy)).toEqual([
      "allow-all",
      "ask",
    ]);
    expect(closed).toEqual(["native-1"]);
  } finally {
    await provider.close();
  }
});
