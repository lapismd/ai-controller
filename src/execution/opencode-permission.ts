import type { ApprovalPolicy, Json } from "../contracts.js";

export type OpenCodePermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "ask";
};

export function openCodePermissionRules(input: {
  approvalPolicy?: ApprovalPolicy;
  restricted?: boolean;
}): OpenCodePermissionRule[] {
  if (input.approvalPolicy === "allow-all" && !input.restricted)
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function openCodeApprovalRequest(
  properties: Record<string, unknown>,
): Json {
  return {
    ...properties,
    options: [
      { id: "allow_once", kind: "allow-once", label: "Allow once" },
      { id: "allow_always", kind: "allow-always", label: "Always allow" },
      { id: "reject_once", kind: "deny-once", label: "Reject" },
    ],
  } as Json;
}

export function openCodePermissionReply(
  value: unknown,
): "once" | "always" | "reject" {
  return value === "allow_always"
    ? "always"
    : value === "allow_once"
      ? "once"
      : "reject";
}
