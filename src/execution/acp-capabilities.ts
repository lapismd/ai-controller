import type { Capabilities } from "../contracts.js";

export const acpCapabilities: Capabilities = {
    driver: "acp",
    content: ["text", "resource"],
    configuration: true,
    resume: "context",
    approvals: true,
    approvalFeatures: {
      persistentDecisions: true,
      granularPermissions: true,
      policyAmendments: false,
    },
    input: false,
    tools: true,
    externalMcp: true,
  };
