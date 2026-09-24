import { expect, it } from "vitest";
import { Controller } from "./engine.js";
import { ControllerStore } from "../persistence/store.js";
import type { ExecutionContext } from "./ports.js";
import { serveController } from "../transport/server.js";
import { ControllerClient } from "../client.js";

function setup() {
  const store = new ControllerStore(":memory:");
  const executions: ExecutionContext[] = [];
  const controller = new Controller(store, new Map([["fixture", {
    capabilities: { driver: "fixture", content: ["text" as const], configuration: false, resume: "none" as const, approvals: true, input: false, tools: false },
    close: async () => {}, execute: async (context: ExecutionContext) => {
      executions.push(context);
      await context.emit({ type: "text", text: "Verified README exists." });
      await context.emit({ type: "completed" });
    },
  }]]));
  const thread = store.createThread("owner", { provider: "fixture", workspace: "repo" });
  return { controller, store, thread, executions };
}

it("starts one linked follow-up with verified context and never repeats the original prompt", async () => {
  const h = setup();
  try {
    const parent = h.controller.submit("owner", { threadId: h.thread.id, commandId: "first", text: "Original write request" });
    await h.controller.drain();
    const command = { turnId: parent.turnId, commandId: "continue", text: "Continue the remaining work" };
    const next = h.controller.continueTurn("owner", command);
    expect(h.controller.continueTurn("owner", command)).toEqual(next);
    await h.controller.drain();
    expect(h.executions).toHaveLength(2);
    expect(h.store.turn(next.turnId)).toMatchObject({ continuedFrom: parent.turnId, threadId: h.thread.id, state: "completed" });
    expect(h.executions[1]?.preparation.text).toBe(command.text);
    expect(h.executions[1]?.preparation.blocks).toContainEqual(expect.objectContaining({ id: `continuation:${parent.turnId}`, trust: "reference", content: expect.stringContaining("Verified README exists.") }));
  } finally { await h.controller.close(); h.store.close(); }
});

it.each(["interrupted", "submission-unknown", "running"] as const)("refuses continuation of %s work", async state => {
  const h = setup();
  try {
    const parent = h.store.accept("owner", { threadId: h.thread.id, commandId: "first", text: "work" });
    h.store.saveTurn({ ...h.store.turn(parent.turnId)!, state });
    expect(() => h.controller.continueTurn("owner", { turnId: parent.turnId, commandId: "continue", text: "Continue" })).toThrow(/stopped|uncertain/i);
    expect(h.store.turns(h.thread.id)).toHaveLength(1);
  } finally { await h.controller.close(); h.store.close(); }
});

it("refuses unresolved tool effects and another owner's target", async () => {
  const h = setup();
  try {
    const parent = h.store.accept("owner", { threadId: h.thread.id, commandId: "first", text: "work" });
    h.store.saveTurn({ ...h.store.turn(parent.turnId)!, state: "failed" });
    h.store.putInteraction({ id: "tool", threadId: h.thread.id, turnId: parent.turnId, nativeId: "write", kind: "tool", state: "unknown", request: {}, deadline: 0 });
    const input = { turnId: parent.turnId, commandId: "continue", text: "Continue" };
    expect(() => h.controller.continueTurn("owner", input)).toThrow(/effects/i);
    expect(() => h.controller.continueTurn("another-owner", input)).toThrow();
    expect(h.store.turns(h.thread.id)).toHaveLength(1);
  } finally { await h.controller.close(); h.store.close(); }
});

it("acknowledges the same continuation over the SDK and rejects conflicting reuse", async () => {
  const h = setup();
  const token = "fixture-continuation-token-32-characters";
  const server = await serveController(h.controller, { credentials: [{ token, principal: { id: "owner", providers: ["fixture"], workspaces: ["repo"] } }] });
  const client = new ControllerClient({ url: server.url, token });
  try {
    const parent = await client.submit({ threadId: h.thread.id, commandId: "original", text: "Check progress" });
    await h.controller.drain();
    const input = { turnId: parent.turnId, commandId: "continuation", text: "Continue from progress" };
    const first = await client.continueTurn(input);
    expect(await client.continueTurn(input)).toEqual(first);
    await expect(client.continueTurn({ ...input, text: "Changed request" })).rejects.toThrow(/different input/);
    await h.controller.drain();
    expect((await client.getTurn(first.turnId)).continuedFrom).toBe(parent.turnId);
    expect(h.executions).toHaveLength(2);
  } finally { client.dispose(); await server.close(); await h.controller.close(); h.store.close(); }
});
