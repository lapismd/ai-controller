import type { Json, ProviderConfig } from "../contracts.js";

/** Choose an offered allow decision; labels and unknown choices confer no authority. */
export function automaticApproval(configuration: ProviderConfig, kind: "approval" | "input", request: Json): string | undefined {
  if (configuration.approvalPolicy !== "allow-all" || configuration.restricted || kind !== "approval") return;
  if (!request || typeof request !== "object" || Array.isArray(request) || !Array.isArray(request.options)) return;
  for (const accepted of ["allow-once", "allow-session", "allow-always"]) {
    for (const option of request.options) {
      if (typeof option === "string") {
        if (option.replaceAll("_", "-") === accepted) return option;
      } else if (option && typeof option === "object" && !Array.isArray(option)) {
        const id = option.id ?? option.optionId;
        if (typeof id === "string" && typeof option.kind === "string" && option.kind.replaceAll("_", "-") === accepted) return id;
      }
    }
  }
}
