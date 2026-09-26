import type { ApprovalPolicy } from "../contracts.js";

type ApprovalInput = {
  approvalPolicy?: ApprovalPolicy;
  restricted?: boolean;
};

export function codexThreadPolicy(input: ApprovalInput) {
  if (input.approvalPolicy === "allow-all" && !input.restricted)
    return { approvalPolicy: "never" as const, sandbox: "danger-full-access" as const };
  return {
    approvalPolicy: input.restricted ? "never" as const : "on-request" as const,
    sandbox: "read-only" as const,
  };
}

export function codexTurnPolicy(input: ApprovalInput) {
  if (input.approvalPolicy === "allow-all" && !input.restricted)
    return {
      approvalPolicy: "never" as const,
      sandboxPolicy: { type: "dangerFullAccess" as const },
    };
  return {
    approvalPolicy: input.restricted ? "never" as const : "on-request" as const,
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
  };
}
