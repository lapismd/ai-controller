import { expect, it } from "vitest";
import { agentRegistry } from "./service.js";
it("preserves the host's Codex ACP launcher instead of requiring another global binary", async () => {
  const registry = await agentRegistry();
  const command = registry.resolve("codex").command;
  expect(JSON.stringify(command)).toContain("@agentclientprotocol/codex-acp@");
  expect(JSON.stringify(command)).toContain("npx");
});
