import type { AgentRuntimeExecutor } from "@lapismd/ai-host";
import type { NativePermissionMode } from "../policy-contracts.js";

/** Older hosts explicitly remain unreported; requesting a mode never proves it applied. */
export function nativePermissionMode(executor: AgentRuntimeExecutor, sessionId: string, requested: string): NativePermissionMode {
  try {
    const value = executor.getAcpSessionStatus?.(sessionId).permissionMode;
    if (value?.requested === requested && ["applied", "unsupported", "rejected"].includes(value.status)) {
      return { requested, status: value.status, ...(value.status === "applied" && value.effective ? { effective: value.effective } : {}) };
    }
  } catch { /* Status may be unavailable after a disconnect. */ }
  return { requested, status: "unreported" };
}
