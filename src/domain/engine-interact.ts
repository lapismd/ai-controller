import { randomUUID } from "node:crypto";
import {
  ControllerError,
  isTerminal,
  type Interaction,
  type Json,
  type Thread,
  type Turn,
} from "../contracts.js";
import { automaticApproval } from "./approval-policy.js";
import { bounded } from "./context.js";
import type { ControllerHost } from "./engine-host.js";
import { respondToInteraction } from "./engine-respond.js";
import { captureFor, persistCapture } from "./engine-transcript.js";

export async function interact(
  host: ControllerHost,
  thread: Thread,
  turn: Turn,
  kind: "approval" | "input",
  nativeId: string,
  request: Json,
  deadline: number,
  signal: AbortSignal,
): Promise<Json> {
  await persistCapture(host, turn, captureFor(host, turn).completeBlock());
  request = host.store.capture.clean(request);
  const automatic = automaticApproval(
    host.store.preparation(turn.id)?.configuration ?? {},
    kind,
    request,
  );
  const interaction: Interaction = {
    id: randomUUID(),
    threadId: thread.id,
    turnId: turn.id,
    nativeId,
    kind,
    ...(automatic !== undefined ? { resolution: "automatic" as const } : {}),
    request,
    state: "pending",
    deadline,
  };
  const response = new Promise<Json>((resolve, reject) => {
    host.responses.set(interaction.id, { resolve, reject });
  });
  void response.catch(() => {});
  await persistCapture(host, turn, [
    captureFor(host, turn).record({
      kind: kind === "approval" ? "permission" : "input",
      interactionId: interaction.id,
      request,
      state: "pending",
    }),
  ]);
  const settled = host.interactionLifecycle.state(turn.id, nativeId);
  if (
    settled ||
    isTerminal(host.store.turn(turn.id)!.state) ||
    signal.aborted
  ) {
    host.responses.delete(interaction.id);
    host.store.putInteraction({
      ...interaction,
      state: settled ?? "cancelled",
    });
    throw host.interactionLifecycle.error();
  }
  host.store.putInteraction(interaction);
  host.store.transition(turn.id, "waiting");
  try {
    if (automatic !== undefined && !signal.aborted && deadline > Date.now()) {
      respondToInteraction(host, thread.owner, interaction.id, automatic, "automatic");
    }
    const value = await bounded(
      response,
      Math.max(0, deadline - Date.now()),
      signal,
    );
    await persistCapture(host, turn, [
      captureFor(host, turn).record({
        kind: kind === "approval" ? "permission" : "input",
        interactionId: interaction.id,
        request,
        response: value,
        state: "resolved",
      }),
    ]);
    const current = host.store.turn(turn.id)!;
    if (
      !isTerminal(current.state) &&
      !current.cancelRequested &&
      !host.store
        .interactions(thread.id)
        .some(
          (item) => item.turnId === turn.id && item.state === "pending",
        )
    )
      host.store.transition(turn.id, "running");
    return value;
  } finally {
    host.responses.delete(interaction.id);
    if (host.store.interaction(interaction.id)?.state === "pending")
      host.store.putInteraction({
        ...interaction,
        state: signal.aborted ? "cancelled" : "expired",
      });
  }
}
