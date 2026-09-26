import { describe, expect, it } from "vitest";
import { automaticApproval } from "../domain/approval-policy.js";
import { codexThreadPolicy, codexTurnPolicy } from "./codex-approval-policy.js";
import {
  openCodeApprovalRequest,
  openCodePermissionRules,
} from "./opencode-permission.js";

describe("native approval policy mappings", () => {
  it("gives unrestricted Codex Allow all full access", () => {
    const input = { approvalPolicy: "allow-all" as const };
    expect(codexThreadPolicy(input)).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(codexTurnPolicy(input)).toEqual({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("keeps Codex Ask and restricted sessions sandboxed", () => {
    expect(codexThreadPolicy({ approvalPolicy: "ask" })).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(
      codexTurnPolicy({ approvalPolicy: "allow-all", restricted: true }),
    ).toEqual({
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("maps OpenCode Allow all and supervised Ask rules", () => {
    expect(openCodePermissionRules({ approvalPolicy: "allow-all" })).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ]);
    const ask = openCodePermissionRules({ approvalPolicy: "ask" });
    expect(ask).toContainEqual({
      permission: "*",
      pattern: "*",
      action: "ask",
    });
    expect(ask).toContainEqual({
      permission: "read",
      pattern: "*",
      action: "allow",
    });
    expect(ask).toContainEqual({
      permission: "external_directory",
      pattern: "*",
      action: "ask",
    });
  });

  it("gives the generic fallback a typed OpenCode allow-once choice", () => {
    expect(
      automaticApproval(
        { approvalPolicy: "allow-all" },
        "approval",
        openCodeApprovalRequest({ permission: "edit" }),
      ),
    ).toBe("allow_once");
  });
});
