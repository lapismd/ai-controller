import {
  ControllerError,
  isTerminal,
  type Json,
  type Turn,
} from "../contracts.js";
import type { ControllerHost } from "./engine-host.js";

export function requireTurn(
  host: ControllerHost,
  owner: string,
  id: string,
): Turn {
  const turn = host.store.turn(id);
  if (!turn) throw new ControllerError("not_found", "Turn not found");
  host.store.authorizeThread(owner, turn.threadId);
  return turn;
}

export function respondToInteraction(
  host: ControllerHost,
  owner: string,
  id: string,
  response: Json,
  resolution: "owner" | "automatic" = "owner",
): void {
  const interaction = host.store.interaction(id);
  if (!interaction)
    throw new ControllerError("not_found", "Interaction not found");
  const turn = requireTurn(host, owner, interaction.turnId);
  const waiting = host.responses.get(id);
  if (
    isTerminal(turn.state) ||
    turn.cancelRequested ||
    interaction.state !== "pending" ||
    !waiting ||
    interaction.deadline <= Date.now()
  )
    throw new ControllerError(
      "interaction_stale",
      "Interaction is no longer live",
    );
  if (interaction.kind === "approval") {
    const options = (interaction.request as { options?: Json[] })?.options ?? [];
    if (
      !options.some((option) =>
        typeof option === "string"
          ? option === response
          : option &&
            typeof option === "object" &&
            !Array.isArray(option) &&
            (option.id ?? option.optionId) === response,
      )
    )
      throw new ControllerError(
        "invalid_response",
        "Approval outcome was not offered",
      );
  } else if (interaction.kind === "input") {
    const schema = (interaction.request as { schema?: Record<string, Json> })
      ?.schema;
    if (schema && !host.ajv.validate(schema, response))
      throw new ControllerError(
        "invalid_response",
        "Input does not match the requested schema",
      );
  } else
    throw new ControllerError(
      "invalid_response",
      "Tool results use the executor endpoint",
    );
  response = host.store.capture.clean(response);
  host.store.putInteraction({
    ...interaction,
    state: "resolved",
    response,
    resolution,
  });
  host.responses.delete(id);
  waiting.resolve(response);
}
