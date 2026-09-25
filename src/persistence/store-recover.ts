import { isTerminal } from "../contracts.js";
import { appendEvent } from "./store-events.js";
import type { StoreHost } from "./store-host.js";
import { putInteraction } from "./store-interactions.js";
import { listTurns, readInteraction } from "./store-records.js";
import { transitionTurn } from "./store-turns.js";

export function recoverStore(host: StoreHost): void {
  host.transaction(() => {
    for (const turn of listTurns(host)) {
      if (isTerminal(turn.state)) continue;
      if (["dispatching", "running", "waiting"].includes(turn.state))
        appendEvent(
          host,
          turn.threadId,
          "capture.gap",
          { reason: "unfinished_blocks_discarded_on_restart" },
          turn.id,
          `${turn.attemptId}:restart-gap`,
          true,
        );
      if (turn.state === "dispatching")
        transitionTurn(
          host,
          turn.id,
          "submission-unknown",
          "dispatch_outcome_unknown",
        );
      else if (["running", "waiting"].includes(turn.state))
        transitionTurn(host, turn.id, "interrupted", "execution_interrupted");
      else if (turn.text === undefined)
        transitionTurn(
          host,
          turn.id,
          "interrupted",
          "private_payload_unavailable",
        );
      else if (turn.state === "preparing") transitionTurn(host, turn.id, "queued");
    }
    for (const row of host.db.prepare("SELECT id FROM interactions").all()) {
      const interaction = readInteraction(host, String(row.id))!;
      if (interaction.state === "pending")
        putInteraction(host, {
          ...interaction,
          state: interaction.kind === "tool" ? "unknown" : "cancelled",
        });
    }
  });
}

export function durableRows(host: StoreHost): unknown[] {
  return [
    "threads",
    "turns",
    "commands",
    "preparations",
    "events",
    "interactions",
  ].flatMap((table) => host.db.prepare(`SELECT * FROM ${table}`).all());
}
