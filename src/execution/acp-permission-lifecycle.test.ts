import { expect, it, vi } from "vitest";
import type { AgentHostSink, AgentRuntimeExecutor } from "@lapismd/ai-host";
import { AcpProvider } from "./acp.js";
import { Controller } from "../domain/engine.js";
import { ControllerStore } from "../persistence/store.js";

it.each(["expired", "cancelled"] as const)("reconciles host %s without opening another approval or failing completed work", async state => {
  let sink!: AgentHostSink;
  let sessionId = "";
  const respond = vi.fn();
  const executor = {
    startAcpSession: async (host: AgentHostSink, input: { sessionId: string }) => { sink = host; sessionId = input.sessionId; return { sessionId }; },
    promptAcpSession: async () => {
      for (const [index, status] of ["pending", state].entries()) sink.sendRuntimeEvent({ sessionId, runId: "native-turn", sequence: index + 1,
        event: { type: "permission", request: { requestId: "native-approval", state: status, expiresAt: Date.now() + 10000, options: [{ optionId: "yes", kind: "allow_once" }] } } });
      sink.sendRuntimeEvent({ sessionId, runId: "native-turn", sequence: 3, event: { type: "event", event: { type: "done" } } });
      return { runId: "native-turn" };
    },
    respondAcpSession: respond,
    close: async () => {},
  } as unknown as AgentRuntimeExecutor;
  const provider = new AcpProvider({ id: "fixture", agent: "codex", workspaces: { repo: "/tmp/fixture" }, executor });
  const store = new ControllerStore(":memory:");
  const controller = new Controller(store, new Map([["fixture", provider]]));
  try {
    const thread = store.createThread("owner", { provider: "fixture", workspace: "repo" });
    controller.submit("owner", { threadId: thread.id, commandId: "work", text: "work" });
    await controller.drain();
    const interactions = store.interactions(thread.id);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.state).toBe(state);
    expect(store.turns(thread.id)[0]?.state).toBe("completed");
    expect(respond).not.toHaveBeenCalled();
  } finally { await controller.close(); store.close(); }
});
