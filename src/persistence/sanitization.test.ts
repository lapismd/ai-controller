import { afterEach, expect, it, vi } from "vitest";
const observed = vi.hoisted(() => ({ writes: [] as unknown[][] }));
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>();
  return { ...actual, DatabaseSync: class extends actual.DatabaseSync {
    override prepare(sql: string) {
      const statement = super.prepare(sql);
      return new Proxy(statement, { get(target, property) {
        if (property === "run") return (...args: unknown[]) => { observed.writes.push(args); return Reflect.apply(target.run, target, args); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
  } };
});
import { ControllerStore } from "./store.js";
import { CaptureBoundary } from "../capture/boundary.js";
import { Controller } from "../domain/engine.js";
import type { ExecutionProvider } from "../domain/ports.js";
const stores: ControllerStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); observed.writes = []; });
const canary = "synthetic-first-write-canary-802";
function fixture() {
  const store = new ControllerStore(":memory:", new CaptureBoundary({ secrets: [canary], roots: [{ kind: "workspace", id: "probe", path: "/private/harness/workspace" }] }));
  stores.push(store);
  const thread = store.createThread("owner", { provider: "fake", workspace: "probe" });
  return { store, thread };
}
it("protects every SQL binding, including command acceptance, preparation and interactions", () => {
  const { store, thread } = fixture();
  const receipt = store.accept("owner", { threadId: thread.id, commandId: "command", text: `${canary} /private/harness/workspace/README` });
  store.prepare(receipt.turnId, { version: 1, text: canary, blocks: [{ id: "context", revision: "1", kind: "application", trust: "reference", content: canary }], configuration: {}, omitted: [] });
  store.putInteraction({ id: "interaction", nativeId: "tool", threadId: thread.id, turnId: receipt.turnId, kind: "tool", state: "resolved", deadline: Date.now(), request: { apiKey: canary }, response: { text: canary, path: "/private/harness/workspace/README" } });
  expect(observed.writes.length).toBeGreaterThan(5);
  const allWrites = JSON.stringify(observed.writes);
  expect(allWrites.includes(canary)).toBe(false);
  expect(allWrites.includes("/private/harness")).toBe(false);
  expect(allWrites.includes("$WORKSPACE[probe]/README")).toBe(true);
  const replay = JSON.stringify(store.snapshot("owner", thread.id));
  expect(replay.includes(canary)).toBe(false);
});
it("keeps raw authorized tool execution separate from sanitized capture and model results", async () => {
  const { store, thread } = fixture();
  const calls: unknown[] = [], models: unknown[] = [];
  const provider: ExecutionProvider = {
    capabilities: { driver: "fake", content: ["text"], configuration: false, resume: "none", approvals: false, input: false, tools: true },
    async execute(context) {
      await context.dispatch();
      models.push(context.preparation);
      models.push(await context.callTool("edit", { value: canary, path: "/private/harness/workspace/README" }, "one"));
      await context.emit({ type: "text", text: canary.slice(0, 15), sourceId: "chunk-1" });
      expect(JSON.stringify(observed.writes).includes(canary.slice(0, 15))).toBe(false);
      await context.emit({ type: "text", text: canary.slice(15), sourceId: "chunk-2" });
      await context.emit({ type: "completed" });
    }, async close() {},
  };
  const controller = new Controller(store, new Map([["fake", provider]]));
  controller.registerTools("owner", "tools", { definitions: [{ name: "edit", description: "Edit", inputSchema: { type: "object" }, effect: "write" }], async execute(_name, input) { calls.push(input); return { content: { text: canary, path: "/private/harness/workspace/README" } }; } });
  const bound = store.createThread("owner", { provider: "fake", workspace: "probe", toolEndpoint: "tools" });
  const receipt = controller.submit("owner", { threadId: bound.id, commandId: "tool-command", text: `inspect ${canary}` });
  await controller.drain();
  expect(store.turn(receipt.turnId)?.state).toBe("completed");
  expect(calls).toEqual([{ value: canary, path: "/private/harness/workspace/README" }]);
  expect(JSON.stringify(models).includes(canary)).toBe(false);
  expect(JSON.stringify(observed.writes).includes(canary)).toBe(false);
  expect(store.turn(receipt.turnId)?.output).toBe("[REDACTED]");
  await controller.close();
});
