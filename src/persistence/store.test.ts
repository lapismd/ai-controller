import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerStore } from "./store.js";

const roots: string[] = [];
const open = () => {
  const root = mkdtempSync(join(tmpdir(), "ai-controller-"));
  roots.push(root);
  return { root, store: new ControllerStore(join(root, "controller.sqlite")) };
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("durable intent", () => {
  it("returns the same receipt after restart and rejects conflicting command input", () => {
    let { root, store } = open();
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "workspace",
    });
    const input = { threadId: thread.id, commandId: "command", text: "hello" };
    const receipt = store.accept("owner", input);
    store.close();
    store = new ControllerStore(join(root, "controller.sqlite"));
    expect(store.accept("owner", input)).toEqual(receipt);
    expect(() =>
      store.accept("owner", { ...input, text: "different" }),
    ).toThrow(/different/);
    expect(store.turns(thread.id)).toHaveLength(1);
    store.close();
  });
  it("does not disclose a different owner's objects or allow a second database writer", () => {
    const { root, store } = open();
    const thread = store.createThread("a", {
      provider: "fake",
      workspace: "workspace",
    });
    expect(() => store.authorizeThread("b", thread.id)).toThrow(/not found/);
    expect(() => new ControllerStore(join(root, "controller.sqlite"))).toThrow(
      /writer/,
    );
    store.close();
  });
  it("keeps private payloads out of durable state and reports lost volatile work", () => {
    let { root, store } = open();
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "workspace",
      payloadPolicy: "metadata-only",
    });
    const receipt = store.accept("owner", {
      threadId: thread.id,
      commandId: "private",
      text: "private secret text",
    });
    store.prepare(receipt.turnId, {
      version: 1,
      text: "private secret text",
      blocks: [
        {
          id: "memory",
          revision: "1",
          kind: "memory",
          trust: "reference",
          content: "private context",
        },
      ],
      omitted: [],
      configuration: {},
    });
    store.ingestText(receipt.turnId, "private output");
    store.putInteraction({
      id: "call",
      threadId: thread.id,
      turnId: receipt.turnId,
      kind: "tool",
      nativeId: "read",
      deadline: Date.now() + 1000,
      state: "resolved",
      request: "private arguments",
      response: "private result",
    });
    expect(store.turn(receipt.turnId)?.text).toBe("private secret text");
    expect(JSON.stringify(store.durableRows())).not.toContain(
      "private secret text",
    );
    for (const text of [
      "private context",
      "private output",
      "private arguments",
      "private result",
    ])
      expect(JSON.stringify(store.durableRows())).not.toContain(text);
    store.close();
    store = new ControllerStore(join(root, "controller.sqlite"));
    store.recover();
    expect(store.turn(receipt.turnId)?.state).toBe("interrupted");
    expect(JSON.stringify(store.durableRows())).not.toContain(
      "private secret text",
    );
    store.close();
  });
  it("does not convert ambiguous dispatch into queued work and never publishes rolled-back events", () => {
    const { store } = open();
    const thread = store.createThread("owner", {
      provider: "fake",
      workspace: "workspace",
    });
    const { turnId } = store.accept("owner", {
      threadId: thread.id,
      commandId: "command",
      text: "hello",
    });
    store.transition(turnId, "dispatching");
    store.recover();
    expect(store.turn(turnId)?.state).toBe("submission-unknown");
    const before = store.snapshot("owner", thread.id);
    expect(() =>
      store.transaction(() => {
        store.append(thread.id, "rolled.back", {});
        throw new Error("commit failure");
      }),
    ).toThrow();
    expect(store.snapshot("owner", thread.id).cursor).toBe(before.cursor);
    expect(store.events("owner", thread.id, before.cursor)).toEqual([]);
    store.close();
  });
});
