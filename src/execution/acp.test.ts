import { describe, expect, it } from "vitest";
import type { AgentHostSink, AgentRuntimeExecutor } from "@lapismd/ai-host";
import { AcpProvider } from "./acp.js";
import { Controller } from "../domain/engine.js";
import { ControllerStore } from "../persistence/store.js";

describe("ACP library execution", () => {
  it("records events emitted before prompt acknowledgement and reuses a thread session", async () => {
    let starts = 0;
    let sequence = 0;
    const executor = {
      startAcpSession: async (
        _sink: AgentHostSink,
        payload: { sessionId: string },
      ) => {
        starts++;
        return { sessionId: payload.sessionId };
      },
      promptAcpSession: async (
        sink: AgentHostSink,
        sessionId: string,
        text: string,
      ) => {
        for (const event of [{ type: "text_delta", text }, { type: "done" }])
          sink.sendRuntimeEvent({
            sessionId,
            runId: "run",
            sequence: ++sequence,
            event: { type: "event", event },
          });
        return { runId: "run" };
      },
      close: async () => {},
    } as unknown as AgentRuntimeExecutor;
    const provider = new AcpProvider({
      id: "codex",
      agent: "codex",
      workspaces: { vault: "/tmp/fixture" },
      executor,
    });
    const store = new ControllerStore(":memory:");
    const controller = new Controller(store, new Map([["codex", provider]]));
    const thread = store.createThread("owner", {
      provider: "codex",
      workspace: "vault",
    });
    controller.submit("owner", {
      threadId: thread.id,
      commandId: "one",
      text: "first",
    });
    controller.submit("owner", {
      threadId: thread.id,
      commandId: "two",
      text: "second",
    });
    await controller.drain();
    expect(starts).toBe(1);
    expect(store.turns().map((turn) => [turn.state, turn.output])).toEqual([
      ["completed", "first"],
      ["completed", "second"],
    ]);
    await controller.close();
    store.close();
  });
});
