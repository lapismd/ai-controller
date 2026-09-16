import { expect, it, vi } from "vitest";
import { Controller } from "../domain/engine.js";
import { ControllerStore } from "../persistence/store.js";
import { CodexProvider } from "./codex.js";
import { AsyncEventQueue } from "./compat/event-queue.js";
import type { AgentEvent, AgentSession } from "./compat/types.js";

it("keeps the workspace occupied until native cancellation is confirmed", async () => {
  const events = new AsyncEventQueue<AgentEvent>();
  let sends = 0;
  const session: AgentSession = {
    id: "native",
    runtimeId: "codex-native",
    events: () => events,
    send: async () => {
      sends++;
      events.push({ type: "text", text: "working" });
      if (sends === 2) events.push({ type: "completed" });
    },
    cancel: vi.fn(async () => {}),
    close: async () => events.close(),
    respondToApproval: async () => {},
  };
  const provider = new CodexProvider(
    { workspace: "/tmp" },
    { runtime: { start: async () => session, resume: async () => session } },
  );
  const store = new ControllerStore(":memory:");
  const controller = new Controller(store, new Map([["native", provider]]));
  try {
    const thread = store.createThread("owner", {
      provider: "native",
      workspace: "workspace",
    });
    const first = controller.submit("owner", {
      threadId: thread.id,
      commandId: "first",
      text: "first",
    });
    await expect.poll(() => store.turn(first.turnId)?.state).toBe("running");
    const next = controller.submit("owner", {
      threadId: thread.id,
      commandId: "second",
      text: "second",
    });
    controller.cancel("owner", first.turnId);
    await expect
      .poll(() => vi.mocked(session.cancel!).mock.calls.length)
      .toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.turn(first.turnId)?.state).toBe("running");
    expect(sends).toBe(1);
    events.push({
      type: "completed",
      result: { turn: { status: "interrupted" } },
    });
    await controller.drain();
    expect(store.turn(first.turnId)?.state).toBe("cancelled");
    expect(store.turn(next.turnId)?.state).toBe("completed");
    expect(sends).toBe(2);
  } finally {
    await controller.close();
    store.close();
  }
});
