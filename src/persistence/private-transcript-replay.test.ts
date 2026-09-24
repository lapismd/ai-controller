import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ControllerStore } from "./store.js";
import { Controller } from "../domain/engine.js";

it("replays volatile transcript content and reports its loss after restart without persisting it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "private-transcript-"));
  const path = join(directory, "controller.sqlite");
  const store = new ControllerStore(path);
  const controller = new Controller(store, new Map([["fixture", {
    capabilities: { driver: "fixture", content: ["text" as const], configuration: false, resume: "none" as const, approvals: false, input: false, tools: false },
    close: async () => {}, execute: async context => {
      await context.emit({ type: "text", text: "Private transcript canary" });
      await context.emit({ type: "completed" });
    },
  }]]));
  let closed = false;
  try {
    const thread = store.createThread("owner", { provider: "fixture", workspace: "repo", payloadPolicy: "metadata-only" });
    const turn = controller.submit("owner", { threadId: thread.id, commandId: "work", text: "Inspect" });
    await controller.drain();
    const replay = store.replayTranscript("owner", thread.id, 0, turn.turnId);
    expect(replay.events.some(event => event.payload.kind === "message" && event.payload.role === "assistant")).toBe(true);
    expect(JSON.stringify(store.durableRows())).not.toContain("Private transcript canary");
    await controller.close(); store.close(); closed = true;
    const reopened = new ControllerStore(path);
    try { expect(() => reopened.replayTranscript("owner", thread.id, 0, turn.turnId)).toThrow(/unavailable/); }
    finally { reopened.close(); }
  } finally { if (!closed) { await controller.close(); store.close(); } rmSync(directory, { recursive: true, force: true }); }
});
