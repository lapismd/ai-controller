import { expect, it } from "vitest";
import type { AgentHostSink, AgentRuntimeExecutor } from "@lapismd/ai-host";
import { AcpProvider } from "./acp.js";
import { Controller } from "../domain/engine.js";
import { ControllerStore } from "../persistence/store.js";

it.each(["applied", "unsupported", "rejected", "unreported"] as const)("retains requested and effective policy with native mode %s", async status => {
  let sequence = 0;
  const executor = {
    startAcpSession: async (_sink: AgentHostSink, input: { sessionId: string }) => ({ sessionId: input.sessionId }),
    getAcpSessionStatus: () => ({ permissionMode: status === "unreported" ? undefined : { requested: "native-full", status, ...(status === "applied" ? { effective: "native-full" } : {}) } }),
    promptAcpSession: async (sink: AgentHostSink, sessionId: string) => {
      sink.sendRuntimeEvent({ sessionId, runId: "native-turn", sequence: ++sequence, event: { type: "event", event: { type: "done" } } });
      return { runId: "native-turn" };
    }, close: async () => {},
  } as unknown as AgentRuntimeExecutor;
  const provider = new AcpProvider({ id: "fixture", agent: "fixture", workspaces: { repo: "/tmp" }, executor });
  const store = new ControllerStore(":memory:");
  const controller = new Controller(store, new Map([["fixture", provider]]));
  try {
    const thread = store.createThread("owner", { provider: "fixture", workspace: "repo", payloadPolicy: "metadata-only", configuration: { approvalPolicy: "allow-all", permissionMode: "native-full" } });
    const receipt = controller.submit("owner", { threadId: thread.id, commandId: "policy", text: "Check" });
    await controller.drain();
    expect(store.turn(receipt.turnId)).toMatchObject({ state: "completed", executionPolicy: {
      requested: "allow-all", effective: "allow-all", restricted: false,
      nativeMode: { requested: "native-full", status, ...(status === "applied" ? { effective: "native-full" } : {}) },
    } });
    expect(JSON.stringify(store.durableRows())).toContain('executionPolicy');
  } finally { await controller.close(); store.close(); }
});
