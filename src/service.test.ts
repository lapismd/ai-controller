import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRegistry, startService } from "./service.js";
it("preserves the host's Codex ACP launcher instead of requiring another global binary", async () => {
  const registry = await agentRegistry();
  const command = registry.resolve("codex").command;
  expect(JSON.stringify(command)).toContain("@agentclientprotocol/codex-acp@");
  expect(JSON.stringify(command)).toContain("npx");
});
it("rejects two configured identities for the same physical workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "controller-workspace-"));
  try {
    await expect(
      startService(
        {
          schema: "lapis-ai-controller.config/1",
          bind: "127.0.0.1",
          port: 1,
          database: join(root, "controller.sqlite"),
          workspaces: { a: root, b: root },
          providers: [{ id: "codex", driver: "acp", agent: "codex" }],
          credentials: [],
        },
        [],
      ),
    ).rejects.toMatchObject({ code: "workspace_alias" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
