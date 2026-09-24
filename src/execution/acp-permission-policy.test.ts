import { expect, it } from "vitest";
import { AcpProvider } from "./acp.js";
import { Controller } from "../domain/engine.js";
import { ControllerStore } from "../persistence/store.js";
import type { AgentHostSink, AgentRuntimeExecutor } from "@lapismd/ai-host";
import { mapAcpPermissionRequest, mapApprovalOptionToAcpDecision } from "./compat/acp-event-mapper.js";

it("retains offered option identities without turning unknown or reject kinds into allow", () => {
  const mapped = mapAcpPermissionRequest({ options: [
    { optionId: "custom-deny", kind: "reject_once" }, { optionId: "custom-allow", kind: "allow_once" },
    { optionId: "unknown", kind: "future-kind" },
  ] });
  expect(mapApprovalOptionToAcpDecision("custom-deny", mapped.options)).toEqual({ outcome: "reject_once" });
  expect(mapApprovalOptionToAcpDecision("custom-allow", mapped.options)).toEqual({ outcome: "allow_once" });
  expect(() => mapApprovalOptionToAcpDecision("unknown", mapped.options)).toThrow();
  expect(() => mapApprovalOptionToAcpDecision("invented", mapped.options)).toThrow();
  expect(mapAcpPermissionRequest({}).options).toEqual([]);
});

it.each(["ask", "allow-all"] as const)("preserves the host permission deadline under %s", async (approvalPolicy) => {
  let host!: AgentHostSink;
  let session = "";
  let expiresAt = 0;
  const decisions: unknown[] = [];
  const executor = {
    startAcpSession: async (sink: AgentHostSink, input: { sessionId: string }) => { host = sink; session = input.sessionId; return { sessionId: session }; },
    promptAcpSession: async () => {
      expiresAt = Date.now() + (approvalPolicy === "allow-all" ? 5000 : 200);
      host.sendRuntimeEvent({ sessionId: session, runId: "run", sequence: 1, event: { type: "permission", request: {
        requestId: "permission", expiresAt, options: [{ optionId: "offered-id", kind: "allow_once" }],
      } } });
      return { runId: "run" };
    },
    respondAcpSession: async (_session: string, _request: string, decision: unknown) => {
      decisions.push(decision);
      host.sendRuntimeEvent({ sessionId: session, runId: "run", sequence: 2, event: { type: "event", event: { type: "done" } } });
    },
    close: async () => {},
  } as unknown as AgentRuntimeExecutor;
  const provider = new AcpProvider({ id: "fixture", agent: "codex", workspaces: { repo: "/tmp/fixture" }, executor });
  const store = new ControllerStore(":memory:");
  const controller = new Controller(store, new Map([["fixture", provider]]));
  try {
    const thread = store.createThread("owner", { provider: "fixture", workspace: "repo", configuration: { approvalPolicy } });
    controller.submit("owner", { threadId: thread.id, commandId: "request", text: "work" });
    await controller.drain();
    expect(store.interactions(thread.id)[0]?.deadline).toBe(expiresAt);
    expect(decisions).toEqual([approvalPolicy === "ask" ? "cancel" : { outcome: "allow_once" }]);
    expect(store.interactions(thread.id)[0]?.state).toBe(approvalPolicy === "ask" ? "expired" : "resolved");
  } finally { await controller.close(); store.close(); }
});
