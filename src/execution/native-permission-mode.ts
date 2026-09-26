import type { AgentRuntimeExecutor } from "@lapismd/ai-host";
import type { NativePermissionMode } from "../policy-contracts.js";

/** Older hosts explicitly remain unreported; requesting a mode never proves it applied. */
export function nativePermissionMode(executor: AgentRuntimeExecutor, sessionId: string, requested?: string): NativePermissionMode | undefined {
  try {
    const value = executor.getAcpSessionStatus?.(sessionId).permissionMode;
    if (value && ["applied", "unsupported", "rejected"].includes(value.status)) {
      return { requested: value.requested, status: value.status, ...(value.status === "applied" && value.effective ? { effective: value.effective } : {}) };
    }
  } catch { /* Status may be unavailable after a disconnect. */ }
  return requested ? { requested, status: "unreported" } : undefined;
}
