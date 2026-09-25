import { continuationTarget } from "./continuation.js";
import { ControllerError, isTerminal, type Receipt, type TurnInput } from "../contracts.js";
import type { ControllerHost } from "./engine-host.js";
import { requireTurn } from "./engine-respond.js";
import { scheduleController } from "./engine-schedule.js";

export function continueTurn(
  host: ControllerHost,
  owner: string,
  input: import("../contracts.js").ContinueInput,
): Receipt {
  const parent = continuationTarget(host.store, owner, input);
  return submitTurn(host, owner, {
    threadId: parent.threadId,
    commandId: input.commandId,
    text: input.text,
    continuedFrom: parent.id,
  });
}

export function submitTurn(
  host: ControllerHost,
  owner: string,
  input: TurnInput,
): Receipt {
  if (host.closing)
    throw new ControllerError("stopping", "Controller is stopping");
  const thread = host.store.authorizeThread(owner, input.threadId);
  if (input.continuedFrom) {
    const parent = continuationTarget(host.store, owner, {
      turnId: input.continuedFrom,
      commandId: input.commandId,
      text: input.text,
    });
    if (parent.threadId !== thread.id)
      throw new ControllerError(
        "continuation_scope_mismatch",
        "Continuation must remain in its original thread",
      );
  }
  const provider = host.providers.get(thread.provider);
  if (!provider)
    throw new ControllerError("provider_unavailable", "Provider is unavailable");
  if (
    input.parts?.some(
      (part) => !provider.capabilities.content.includes(part.type),
    )
  )
    throw new ControllerError(
      "unsupported_content",
      "Provider cannot accept this content",
    );
  const receipt = host.store.accept(owner, input);
  scheduleController(host);
  return receipt;
}

export function cancelTurn(
  host: ControllerHost,
  owner: string,
  turnId: string,
): void {
  const turn = requireTurn(host, owner, turnId);
  if (isTerminal(turn.state)) return;
  host.store.transaction(() => {
    host.store.saveTurn({ ...turn, cancelRequested: true });
    host.store.append(
      turn.threadId,
      "turn.cancel_requested",
      {},
      turnId,
      undefined,
      true,
    );
    if (!host.active.has(turnId)) host.store.transition(turnId, "cancelled");
  });
  host.active.get(turnId)?.abort.abort();
}

export function resolveTurn(
  host: ControllerHost,
  owner: string,
  turnId: string,
  outcome: "failed" | "cancelled",
  externalStopped: boolean,
): void {
  const turn = requireTurn(host, owner, turnId);
  if (!externalStopped)
    throw new ControllerError(
      "resolution_required",
      "Verify external work has stopped before resolving this turn",
    );
  if (!["failed", "cancelled"].includes(outcome))
    throw new ControllerError(
      "invalid_input",
      "Resolution outcome must be failed or cancelled",
    );
  if (
    !["submission-unknown", "interrupted"].includes(turn.state) ||
    host.active.has(turn.id)
  )
    throw new ControllerError(
      "resolution_invalid",
      "Only inactive uncertain turns can be resolved",
    );
  host.store.transaction(() => {
    host.store.append(
      turn.threadId,
      "turn.resolved",
      { outcome, externalStopped: true },
      turn.id,
      undefined,
      true,
    );
    host.store.resolveUncertain(turn.id, outcome);
  });
  scheduleController(host);
}
