import { createHash, randomUUID } from "node:crypto";
import {
  ControllerError,
  isTerminal,
  requiredString,
  type Json,
  type Preparation,
  type Receipt,
  type Turn,
  type TurnInput,
  type TurnState,
} from "../contracts.js";
import { canonical } from "./store-codec.js";
import { appendEvent } from "./store-events.js";
import type { StoreHost } from "./store-host.js";
import {
  authorizeThread,
  readThread,
  readTurn,
  saveTurn,
} from "./store-records.js";

export function acceptTurn(
  host: StoreHost,
  owner: string,
  input: TurnInput,
): Receipt {
  input = host.capture.clean(input, true);
  requiredString(input.commandId, "command id");
  if (
    typeof input.text !== "string" ||
    input.text.length > 1_000_000 ||
    (!input.text.trim() && !input.parts?.length)
  )
    throw new ControllerError(
      "invalid_input",
      "Turn input is empty or too large",
    );
  const thread = authorizeThread(host, owner, input.threadId);
  const digest = createHash("sha256").update(canonical(input)).digest("hex");
  return host.transaction(() => {
    const prior = host.db
      .prepare("SELECT digest,body FROM commands WHERE owner=? AND id=?")
      .get(owner, input.commandId);
    if (prior) {
      if (prior.digest !== digest)
        throw new ControllerError(
          "command_conflict",
          "Command key has different input",
        );
      return JSON.parse(String(prior.body)) as Receipt;
    }
    const now = Date.now();
    const turn: Turn = {
      id: randomUUID(),
      threadId: thread.id,
      commandId: input.commandId,
      attemptId: randomUUID(),
      state: "queued",
      text: input.text,
      parts: input.parts,
      output: "",
      externalRef: input.externalRef,
      ...(input.continuedFrom ? { continuedFrom: input.continuedFrom } : {}),
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    const receipt: Receipt = {
      commandId: input.commandId,
      threadId: thread.id,
      turnId: turn.id,
      acceptedAt: now,
      durability: thread.payloadPolicy,
    };
    saveTurn(host, turn);
    host.db
      .prepare("INSERT INTO commands VALUES(?,?,?,?)")
      .run(owner, input.commandId, digest, JSON.stringify(receipt));
    appendEvent(
      host,
      thread.id,
      "turn.accepted",
      { turn: turn as unknown as Json },
      turn.id,
    );
    return receipt;
  });
}

export function transitionTurn(
  host: StoreHost,
  id: string,
  state: TurnState,
  error?: string,
): Turn {
  return host.transaction(() => {
    const turn = readTurn(host, id);
    if (!turn) throw new ControllerError("not_found", "Turn not found");
    if (isTerminal(turn.state) && state !== turn.state)
      throw new ControllerError("turn_terminal", "Turn is terminal");
    const next = {
      ...turn,
      state,
      updatedAt: Date.now(),
      ...(error ? { error } : {}),
    };
    saveTurn(host, next);
    appendEvent(
      host,
      turn.threadId,
      "turn.state",
      { state, error: error ?? null },
      id,
      undefined,
      true,
    );
    return next;
  });
}

export function resolveUncertainTurn(
  host: StoreHost,
  id: string,
  outcome: "failed" | "cancelled",
): void {
  host.transaction(() => {
    const turn = readTurn(host, id);
    if (!turn || !["interrupted", "submission-unknown"].includes(turn.state))
      throw new ControllerError(
        "resolution_invalid",
        "Turn has no uncertain outcome",
      );
    const error = "operator_verified_stopped";
    saveTurn(host, { ...turn, state: outcome, error, updatedAt: Date.now() });
    appendEvent(
      host,
      turn.threadId,
      "turn.state",
      { state: outcome, error },
      id,
      undefined,
      true,
    );
  });
}

export function prepareTurn(
  host: StoreHost,
  turnId: string,
  preparation: Preparation,
): void {
  preparation = host.capture.clean(preparation);
  host.transaction(() => {
    const turn = readTurn(host, turnId)!;
    const durable = readThread(host, turn.threadId)!.payloadPolicy === "durable";
    host.db
      .prepare(
        "INSERT INTO preparations VALUES(?,?) ON CONFLICT(turn_id) DO UPDATE SET body=excluded.body",
      )
      .run(
        turnId,
        JSON.stringify(
          durable
            ? preparation
            : {
                version: preparation.version,
                omitted: preparation.omitted,
                payloadUnavailable: true,
              },
        ),
      );
    if (!durable)
      host.volatilePreparations.set(turnId, structuredClone(preparation));
    transitionTurn(host, turnId, "prepared");
  });
}
