const GENERIC_TOOL_NAMES = new Set(["tool call", "acp_tool", "tool"]);

export function isGenericToolName(name: string | undefined): boolean {
  const normalized = name?.trim().toLowerCase() ?? "";
  return normalized.length === 0 || GENERIC_TOOL_NAMES.has(normalized);
}

export function isEmptyToolInput(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed === "{}";
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

export function preferToolName(
  current: string | undefined,
  incoming: string | undefined,
): string {
  const incomingName = incoming?.trim() ?? "";
  const currentName = current?.trim() ?? "";
  if (!incomingName) return currentName || "acp_tool";
  if (isGenericToolName(incomingName) && currentName && !isGenericToolName(currentName)) {
    return currentName;
  }
  return incomingName;
}

export function toolNameFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ["name", "toolName", "tool"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim() && !isGenericToolName(value)) {
      return value.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
