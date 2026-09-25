import type { ControllerEvent } from "../contracts.js";
import type { StoreHost } from "./store-host.js";

export function runTransaction<T>(
  host: StoreHost,
  operation: () => T,
): T {
  if (host.pendingEvents) return operation();
  host.db.exec("BEGIN IMMEDIATE");
  host.pendingEvents = [];
  const backup = [
    new Map(host.volatileTurns),
    new Map(host.volatilePreparations),
    new Map(host.volatileInteractions),
    new Map(host.volatileEvents),
  ] as const;
  let result: T;
  let committed: ControllerEvent[];
  try {
    result = operation();
    host.db.exec("COMMIT");
    committed = host.pendingEvents;
  } catch (error) {
    host.db.exec("ROLLBACK");
    for (const [map, saved] of [
      [host.volatileTurns, backup[0]],
      [host.volatilePreparations, backup[1]],
      [host.volatileInteractions, backup[2]],
      [host.volatileEvents, backup[3]],
    ] as const) {
      map.clear();
      for (const [key, value] of saved)
        (map as Map<string, unknown>).set(key, value);
    }
    throw error;
  } finally {
    host.pendingEvents = undefined;
  }
  for (const event of committed)
    for (const listener of host.listeners) {
      try {
        listener(structuredClone(event));
      } catch {
        /* Observer failures cannot undo a committed receipt. */
      }
    }
  return result;
}
