import { ControllerError, type Turn } from "../contracts.js";
import type { ControllerStore } from "../persistence/store.js";

type Settlement = "expired" | "cancelled";

/** Remembers host settlement even while a durable capture acknowledgement is pending. */
export class InteractionLifecycle {
  readonly ended = new Map<string, Map<string, Settlement>>();
  state(turnId: string, nativeId: string): Settlement | undefined {
    return this.ended.get(turnId)?.get(nativeId);
  }
  settle(store: ControllerStore, turn: Turn, nativeId: string, state: Settlement,
    reject: (id: string, error: Error) => void): void {
    let turnStates = this.ended.get(turn.id);
    if (!turnStates) this.ended.set(turn.id, turnStates = new Map());
    if (!turnStates.has(nativeId)) turnStates.set(nativeId, state);
    for (const interaction of store.interactions(turn.threadId)) {
      if (interaction.turnId !== turn.id || interaction.nativeId !== nativeId || interaction.kind !== "approval" || interaction.state !== "pending") continue;
      store.putInteraction({ ...interaction, state: turnStates.get(nativeId)! });
      reject(interaction.id, this.error());
    }
  }
  error(): ControllerError {
    return new ControllerError("interaction_settled", "The host already settled this interaction");
  }
  clear(turnId: string): void { this.ended.delete(turnId); }
}
