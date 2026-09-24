import type { ControllerStore } from "../persistence/store.js";
import type { ProviderConfig, Turn } from "../contracts.js";
import type { ExecutionPolicy, NativePermissionMode } from "../policy-contracts.js";

export function recordExecutionPolicy(store: ControllerStore, turn: Turn, configuration: ProviderConfig, nativeMode?: NativePermissionMode): void {
  const requested = configuration.approvalPolicy ?? "ask";
  const restricted = configuration.restricted === true;
  const executionPolicy: ExecutionPolicy = {
    requested, effective: restricted ? "ask" : requested, restricted,
    ...(nativeMode ? { nativeMode } : configuration.permissionMode ? { nativeMode: { requested: configuration.permissionMode, status: "unreported" } } : {}),
  };
  const current = store.turn(turn.id)!;
  if (JSON.stringify(current.executionPolicy) === JSON.stringify(executionPolicy)) return;
  store.transaction(() => {
    store.saveTurn({ ...current, executionPolicy });
    store.append(turn.threadId, "turn.policy", executionPolicy, turn.id, undefined, true);
  });
}
