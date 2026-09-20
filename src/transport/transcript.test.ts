import { expect, it } from "vitest";
import { ControllerStore } from "../persistence/store.js";
import { CaptureBoundary } from "../capture/boundary.js";
import { Controller } from "../domain/engine.js";
import { ControllerClient } from "../client.js";
import { serveController } from "./server.js";
import type { Json } from "../contracts.js";
import type { TranscriptEvent } from "../transcript-contracts.js";

it("requires an authorized durable acknowledgment before dispatch and supports owner replay", async () => {
  const secret = "synthetic-external-journal-canary-537";
  const store = new ControllerStore(":memory:", new CaptureBoundary({ secrets: [secret] }));
  let effects = 0, pending = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new Controller(store, new Map([["fake", {
    capabilities: { driver: "fake", content: ["text" as const], configuration: false, resume: "none" as const, approvals: false, input: false, tools: false },
    close: async () => {}, execute: async c => { effects++; await c.emit({ type: "text", text: secret }); await c.emit({ type: "completed" }); },
  }]]));
  const token = "synthetic-transcript-owner-credential-1", other = "synthetic-transcript-other-credential-2";
  const server = await serveController(controller, { credentials: [{ token, principal: { id: "owner", providers: ["fake"], workspaces: ["root"] } }, { token: other, principal: { id: "other", providers: ["fake"], workspaces: ["root"] } }] });
  const client = new ControllerClient({ url: server.url, token }), intruder = new ControllerClient({ url: server.url, token: other });
  const journal = new Map<string, TranscriptEvent>();
  try {
    await client.registerEndpoint({ id: "encrypted-owner-journal", transcript: true, handle: async call => {
      const payload = call.payload as Record<string, Json>;
      if (call.operation === "transcript.append") {
        expect(call.deadline - Date.now()).toBeGreaterThan(100_000);
        const event = payload.event as unknown as TranscriptEvent;
        pending++;
        await gate;
        expect(JSON.stringify(event)).not.toContain(secret);
        const prior = journal.get(event.id);
        if (prior) expect(event).toEqual(prior);
        journal.set(event.id, event);
        return { eventId: event.id, sequence: event.sequence, durable: true };
      }
      return { events: [...journal.values()].filter(e => e.threadId === payload.threadId && e.sequence > Number(payload.afterSequence)), complete: true } as unknown as Json;
    } });
    const thread = await client.createThread({ provider: "fake", workspace: "root", payloadPolicy: "metadata-only", transcriptEndpoint: "encrypted-owner-journal" });
    const receipt = await client.submit({ threadId: thread.id, commandId: "once", text: secret });
    await expect.poll(() => pending).toBe(1);
    expect(effects).toBe(0);
    expect(store.snapshot("owner", thread.id).transcript).toHaveLength(0);
    release();
    await controller.drain();
    expect(effects).toBe(1);
    expect((await client.getTurn(receipt.turnId)).state).toBe("completed");
    const replay = await client.replayTranscript(thread.id);
    expect(replay.events.some(e => e.payload.kind === "message" && e.payload.role === "assistant")).toBe(true);
    expect(new Set(replay.events.map(e => e.sequence)).size).toBe(replay.events.length);
    expect(JSON.stringify(store.durableRows())).not.toContain(secret);
    expect(JSON.stringify(store.durableRows())).not.toContain("[REDACTED]");
    await expect(intruder.replayTranscript(thread.id)).rejects.toThrow();
    expect(await client.submit({ threadId: thread.id, commandId: "once", text: secret })).toEqual(receipt);
    expect(effects).toBe(1);
  } finally { release(); await controller.drain(); client.dispose(); intruder.dispose(); await server.close(); await controller.close(); store.close(); }
});
