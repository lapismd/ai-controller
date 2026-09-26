import { describe, expect, it } from "vitest";
import type { AgentHostSink, AgentRuntimeExecutor } from "@lapismd/ai-host";
import { AcpProvider } from "./acp.js";
import { Controller } from "../domain/engine.js";
import { ControllerStore } from "../persistence/store.js";

describe("ACP library execution", () => {
  it("records events emitted before prompt acknowledgement and reuses a thread session", async () => {
    let starts = 0;
    let sequence = 0;
    const identities: unknown[] = [];
    const executor = {
      startAcpSession: async (
        _sink: AgentHostSink,
        payload: { sessionId: string; metadata?: { vcsIdentity?: unknown } },
      ) => {
        starts++;
        identities.push(payload.metadata?.vcsIdentity);
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
      configuration: { vcsIdentity: { name: "Nyra", email: "nyra@nostr.invalid" } },
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
    expect(identities).toEqual([{ name: "Nyra", email: "nyra@nostr.invalid" }]);
    expect(store.turns().map((turn) => [turn.state, turn.output])).toEqual([
      ["completed", "first"],
      ["completed", "second"],
    ]);
    await controller.close();
    store.close();
  });

  it("forwards sessionId from model discovery to listAcpModels", async () => {
    const listed: unknown[] = [];
    const executor = {
      listAcpModels: async (
        _sink: AgentHostSink,
        payload: { agent?: string; workspace?: string; sessionId?: string },
      ) => {
        listed.push(payload);
        return { agent: "codex", models: ["gpt-6"], entries: [], configOptions: [] };
      },
      close: async () => {},
    } as unknown as AgentRuntimeExecutor;
    const provider = new AcpProvider({
      id: "codex",
      agent: "codex",
      workspaces: { vault: "/tmp/fixture" },
      executor,
    });
    await expect(
      provider.models("vault", { sessionId: "persisted-session" }),
    ).resolves.toMatchObject({ models: ["gpt-6"] });
    expect(listed).toEqual([
      {
        agent: "codex",
        workspace: "/tmp/fixture",
        sessionId: "persisted-session",
      },
    ]);
    await provider.close();
  });

  it("reads an operational worker snapshot without opening a session", async () => {
    const snapshot = { status: "available", observedAt: 1, workers: { busy: 1, idle: 2, starting: 0, stopping: 0 }, sessions: 3, rssBytes: 8192 };
    const provider = new AcpProvider({
      id: "codex", agent: "codex", workspaces: { vault: "/tmp/fixture" },
      executor: { snapshotAcpResources: async () => snapshot, close: async () => {} } as unknown as AgentRuntimeExecutor,
    });
    await expect(provider.resources()).resolves.toEqual(snapshot);
    await provider.close();
  });
});
