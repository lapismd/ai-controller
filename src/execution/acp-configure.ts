export type AcpConfigureField = {
  status?: string;
  reason?: string;
};

export function rejectedRequestedConfiguration(
  requested: { model?: string; thinking?: string },
  effective: { model?: AcpConfigureField; thinking?: AcpConfigureField },
): { field: "model" | "thinking"; reason: string } | undefined {
  if (requested.thinking && effective.thinking?.status === "unsupported")
    return {
      field: "thinking",
      reason:
        effective.thinking.reason ?? "Provider rejected requested thinking",
    };
  if (requested.model && effective.model?.status === "unsupported")
    return {
      field: "model",
      reason: effective.model.reason ?? "Provider rejected requested model",
    };
}
