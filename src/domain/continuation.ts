import { ControllerError, type ContextBlock, type ContinueInput, type Thread, type Turn } from "../contracts.js";
import type { ControllerStore } from "../persistence/store.js";
import type { TranscriptPage } from "../transcript-contracts.js";

export function continuationTarget(store: ControllerStore, owner: string, input: ContinueInput): Turn {
  const parent = store.turn(input.turnId);
  if (!parent) throw new ControllerError("not_found", "Turn not found");
  store.authorizeThread(owner, parent.threadId);
  if (!["completed", "failed", "cancelled"].includes(parent.state))
    throw new ControllerError("continuation_not_stopped", "The task must be stopped and uncertain execution resolved before continuing");
  if (store.interactions(parent.threadId).some(item => item.turnId === parent.id &&
    (item.state === "pending" || item.kind === "tool" && item.state === "unknown")))
    throw new ControllerError("continuation_effects_unknown", "Outstanding effects require reconciliation before continuing");
  return parent;
}

export async function continuationContext(
  thread: Thread, turn: Turn, replay: (sequence: number, turnId: string) => Promise<TranscriptPage>,
): Promise<ContextBlock[]> {
  if (!turn.continuedFrom) return [];
  let sequence = 0;
  const records: string[] = [];
  const outstanding = new Set<string>();
  let characters = 0;
  let truncated = false;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await replay(sequence, turn.continuedFrom);
    for (const event of page.events) {
      if (event.threadId !== thread.id || event.turnId !== turn.continuedFrom)
        throw new ControllerError("continuation_scope_mismatch", "Continuation evidence belongs to another turn");
      const payload = event.payload;
      if (payload.kind === "tool-invocation") outstanding.add(payload.invocationId);
      if (payload.kind === "tool-result") {
        if (payload.outcome === "unknown") throw new ControllerError("continuation_effects_unknown", "Observed tool effects require reconciliation");
        outstanding.delete(payload.invocationId);
      }
      if (payload.kind === "omission" && /tool|interrupted/.test(payload.reason))
        throw new ControllerError("continuation_effects_unknown", "Incomplete activity requires reconciliation before continuing");
      const record = JSON.stringify({ id: event.id, sequence: event.sequence, payload });
      const bounded = record.length > 8192 ? JSON.stringify({ id: event.id, kind: payload.kind, omitted: "record exceeds continuation budget" }) : record;
      records.push(bounded); characters += bounded.length;
      while (characters > 32000 && records.length) { characters -= records.shift()!.length; truncated = true; }
    }
    if (page.complete) {
      if (outstanding.size) throw new ControllerError("continuation_effects_unknown", "Observed tool effects require reconciliation");
      if (!records.length && thread.payloadPolicy === "metadata-only")
        throw new ControllerError("transcript_unavailable", "Verified prior progress is unavailable for continuation");
      return [{ id: `continuation:${turn.continuedFrom}`, revision: turn.continuedFrom,
        kind: "handoff", trust: "reference", required: true,
        content: `Prior observed progress for turn ${turn.continuedFrom}. Verify current state before acting; do not repeat completed tool effects. ${truncated ? "Earlier records omitted by context budget." : ""}\n${records.join("\n")}` }];
    }
    if (page.nextSequence === undefined || page.nextSequence <= sequence) break;
    sequence = page.nextSequence;
  }
  throw new ControllerError("transcript_unavailable", "Continuation history could not be verified completely");
}
