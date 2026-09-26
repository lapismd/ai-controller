import type { AgentRuntimeExecutor, NativeAgentRuntimeEvent } from "@lapismd/ai-host";
import { ControllerError, type Json } from "../contracts.js";
import type { ExecutionContext } from "../domain/ports.js";
import { mapAcpRuntimeEvent, mapAcpPermissionRequest, mapApprovalOptionToAcpDecision } from "./compat/acp-event-mapper.js";
import type { ActiveSession } from "./acp.js";

export function receiveAcpFrame(executor: AgentRuntimeExecutor, sessions: Map<string, ActiveSession>, frame: NativeAgentRuntimeEvent): void {
    const session = [...sessions.values()].find(
      (item) => item.sessionId === frame.sessionId,
    );
    const context = session?.context;
    if (!session || !context) return;
    if (++session.queued > 1000) {
      session.reject?.(
        new ControllerError(
          "ingestion_overflow",
          "Provider output exceeded ingestion capacity",
        ),
      );
      return;
    }
    session.ingest = session.ingest
      .then(async () => {
        const sourceId = `${context.turn.attemptId}:${frame.runId}:${frame.sequence}`;
        if (frame.event.type === "permission") {
          const request = frame.event.request ?? {};
          const nativeId = String(request.requestId ?? request.id ?? "");
          if (["resolved", "expired", "cancelled"].includes(String(request.state))) {
            session.settledInteractions.add(nativeId);
            if (request.state !== "resolved") await context.emit({ type: "interaction-settled", nativeId, state: request.state as "expired" | "cancelled" });
            return;
          }
          if (session.settledInteractions.has(nativeId) || session.interactions.has(nativeId)) return;
          const normalized = mapAcpPermissionRequest(request);
          const interaction = context
            .interact(
              "approval",
              nativeId,
              normalized as unknown as Json,
              typeof request.expiresAt === "number" ? request.expiresAt : Date.now() + 15 * 60_000,
            )
            .then(
              (value) =>
                session.settledInteractions.has(nativeId) ? undefined : executor.respondAcpSession(
                  frame.sessionId,
                  nativeId,
                  mapApprovalOptionToAcpDecision(String(value), normalized.options),
                ),
              () =>
                session.settledInteractions.has(nativeId) ? undefined : executor.respondAcpSession(
                  frame.sessionId,
                  nativeId,
                  "cancel",
                ),
            )
            .catch(() =>
              session.reject?.(
                new ControllerError(
                  "approval_stale",
                  "Provider approval is no longer live",
                ),
              ),
            ).finally(() => session.interactions.delete(nativeId));
          session.interactions.set(nativeId, interaction);
          return;
        }
        const event = frame.event.event ?? {};
        const type = String(event.type ?? "");
        const normalized = mapAcpRuntimeEvent({ ...event, type });
        if (normalized?.type === "text" || type === "text")
          await context.emit({
            type: "text",
            text:
              normalized?.type === "text"
                ? normalized.text
                : String(event.text ?? event.delta ?? ""),
            sourceId,
            ...(typeof event.messageId === "string" ? { messageId: event.messageId } : {}),
            ...(event.complete === true ? { complete: true } : {}),
          });
        else if (type === "message_complete")
          await context.emit({ type: "activity", data: { type, ...(typeof event.messageId === "string" ? { messageId: event.messageId } : {}) }, sourceId });
        else if (["done", "completed"].includes(type)) {
          await context.emit({
            type: "completed",
            outcome:
              event.stopReason === "cancelled" ? "cancelled" : "completed",
          });
          await settleOutstanding(session, context);
          session.resolve?.();
        } else if (type === "error" || frame.event.type === "closed") {
          await context.emit({ type: "failed", code: "provider_failed" });
          await settleOutstanding(session, context);
          session.resolve?.();
        } else
          await context.emit({
            type: "activity",
            data: (type === "capture_coverage" ? event
              : type === "status" && event.tag === "plan" ? { type: "plan", entries: event.entries ?? [], observation: event }
              : normalized ? { ...normalized, observation: event }
              : { type: "provider_extension", sourceType: type, observation: event }) as unknown as Json,
            sourceId,
          });
      })
      .catch((error) => {
        session.reject?.(
          error instanceof Error
            ? error
            : new ControllerError("ingestion_failed", "Output commit failed"),
        );
        void executor.cancelAcpSession(frame.sessionId).catch(() => {});
      })
      .finally(() => {
        session.queued--;
      });
  }
async function settleOutstanding(session: ActiveSession, context: ExecutionContext): Promise<void> {
    for (const id of session.interactions.keys()) {
      if (session.settledInteractions.has(id)) continue;
      session.settledInteractions.add(id);
      await context.emit({ type: "interaction-settled", nativeId: id, state: "cancelled" });
    }
    await Promise.allSettled(session.interactions.values());
  }
