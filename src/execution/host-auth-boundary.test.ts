import { describe, expect, it } from "vitest";
import { AcpProvider } from "./acp.js";
import { CodexProvider } from "./codex.js";

describe("ai-host execution boundary", () => {
  it("constructs host adapters without controller principals or scopes", () => {
    const acp = new AcpProvider({
      id: "codex",
      agent: "codex",
      workspaces: { default: "/tmp" },
    });
    const native = new CodexProvider({ default: "/tmp" }, { id: "codex-native" });
    expect("principal" in acp.options).toBe(false);
    expect("scopes" in acp.options).toBe(false);
    expect(JSON.stringify(acp.options)).not.toContain("threads:operate");
    expect(JSON.stringify(native)).not.toContain("memory:read");
  });
});
