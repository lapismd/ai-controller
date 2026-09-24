import { expect, it } from "vitest";
import { ControllerStore } from "../persistence/store.js";
import { Controller } from "./engine.js";
import type { ProviderConfig, Json } from "../contracts.js";
import type { ExecutionProvider } from "./ports.js";

async function run(configuration: ProviderConfig, kind: "approval" | "input" = "approval", options: Json[] = [{ id: "provider-choice-7", kind: "allow-once" }, { id: "no", kind: "deny-once" }]) {
  const store = new ControllerStore(":memory:");
  let decision: Json | undefined;
  const provider: ExecutionProvider = {
    capabilities: { driver: "fixture", content: ["text"], configuration: true, resume: "none", approvals: true, input: true, tools: false },
    close: async () => {},
    execute: async context => {
      decision = await context.interact(kind, "native-permission", { options }, Date.now() + (configuration.approvalPolicy === "allow-all" && !configuration.restricted && kind === "approval" && options.some(option => typeof option === "object" && option !== null && !Array.isArray(option) && option.kind === "allow-once") ? 5000 : 100));
      await context.emit({ type: "completed" });
    },
  };
  const controller = new Controller(store, new Map([["fixture", provider]]));
  const thread = store.createThread("owner", { provider: "fixture", workspace: "repo", configuration });
  controller.submit("owner", { threadId: thread.id, commandId: "request", text: "work" });
  await controller.drain();
  const interactions = store.interactions(thread.id);
  const state = store.turns(thread.id)[0]!.state;
  await controller.close(); store.close();
  return { decision, interactions, state };
}
it("automatically resolves the exact offered approval and records its policy decision", async () => {
  const result = await run({ approvalPolicy: "allow-all" });
  expect(result.decision).toBe("provider-choice-7");
  expect(result.state).toBe("completed");
  expect(result.interactions[0]).toMatchObject({ state: "resolved", response: "provider-choice-7", resolution: "automatic" });
});
it.each([{}, { approvalPolicy: "ask" }, { approvalPolicy: "allow-all", restricted: true }] as ProviderConfig[])("preserves Ask and restricted execution (%j)", async configuration => {
  const result = await run(configuration);
  expect(result.decision).toBeUndefined();
  expect(result.interactions[0]?.state).toBe("expired");
});
it("does not answer task questions or invent an unoffered approval", async () => {
  expect((await run({ approvalPolicy: "allow-all" }, "input")).decision).toBeUndefined();
  expect((await run({ approvalPolicy: "allow-all" }, "approval", [{ id: "deny", kind: "deny-once" }])).decision).toBeUndefined();
});
