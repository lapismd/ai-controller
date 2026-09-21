import { afterEach, expect, it } from "vitest";
import { CaptureBoundary } from "./boundary.js";
import { CaptureSession } from "./session.js";
import type { Thread, Turn } from "../contracts.js";
const disposers: CaptureBoundary[] = [];
afterEach(() => { for (const boundary of disposers.splice(0)) boundary.close(); });
function fixture() {
  const secret = "synthetic-capture-canary-906";
  const boundary = new CaptureBoundary({ secrets: [secret], roots: [{ kind: "workspace", id: "probe", path: "/private/test/workspace" }] });
  disposers.push(boundary);
  const thread = { id: "thread", owner: "owner", provider: "acp", workspace: "probe", payloadPolicy: "durable", version: 1, createdAt: 1 } as Thread;
  const turn = { id: "turn", attemptId: "attempt", threadId: thread.id } as Turn;
  return { secret, capture: new CaptureSession(thread, turn, boundary) };
}
function kinds(records: ReturnType<CaptureSession["accept"]>) {
  return records.map((record) => record.event?.payload.kind);
}
it("buffers chunks into one completed message, exposing immediate status only", () => {
  const { secret, capture } = fixture();
  const first = capture.accept({ type: "text", text: secret.slice(0, 12), sourceId: "1", messageId: "message" });
  expect(kinds(first)).toEqual([undefined]);
  expect(first[0]?.projection).toMatchObject({ type: "activity", data: { type: "status", status: "Working", pending: true } });
  expect(JSON.stringify(first)).not.toContain(secret.slice(0, 12));
  expect(capture.accept({ type: "text", text: secret.slice(12), sourceId: "2", messageId: "message" })).toEqual([]);
  const status = capture.accept({ type: "activity", data: { type: "usage", used: 4, limit: 10 }, sourceId: "3" });
  expect(status.some((record) => record.event?.payload.kind === "message")).toBe(false);
  expect(status[0]?.event?.payload).toMatchObject({ kind: "usage", used: 4, limit: 10 });
  const later = capture.accept({ type: "activity", data: { type: "usage", used: 8, limit: 10 }, sourceId: "4" });
  expect(later[0]?.event?.id).toBe(status[0]?.event?.id);
  expect(later[0]?.event?.payload).toMatchObject({ kind: "usage", used: 8, limit: 10 });
  const final = capture.accept({ type: "completed" });
  expect(final.filter((record) => record.event?.payload.kind === "message")).toHaveLength(1);
  expect(final[0]?.event?.payload).toMatchObject({ kind: "message", text: "[REDACTED]" });
  expect(final[0]?.projection).toMatchObject({ type: "text", complete: true });
});
it("retains completed thinking and turns unfinished cancelled text into a gap", () => {
  const { secret, capture } = fixture();
  capture.accept({ type: "activity", data: { type: "thinking", text: secret }, sourceId: "1" });
  const thought = capture.accept({ type: "text", text: "unfinished", sourceId: "2" });
  expect(thought[0]?.event?.payload).toMatchObject({ kind: "thinking", text: "[REDACTED]", visible: true });
  const cancelled = capture.accept({ type: "completed", outcome: "cancelled" });
  expect(cancelled[0]?.event?.payload).toMatchObject({ kind: "omission", reason: "cancelled" });
  expect(JSON.stringify(cancelled)).not.toContain("unfinished");
});
it("retains plans, tool input/results, and coverage metadata without leftover rows", () => {
  const { secret, capture } = fixture();
  expect(kinds(capture.accept({ type: "activity", data: { type: "capture_coverage" } }))).toEqual([]);
  const plan = capture.accept({ type: "activity", data: { type: "plan", entries: [{ content: "Inspect /private/test/workspace/README", status: "in_progress" }] } });
  expect(plan[0]?.event?.payload).toMatchObject({ kind: "plan", entries: [{ content: "Inspect $WORKSPACE[probe]/README", status: "in_progress" }] });
  expect(plan[0]?.event?.coverage).toMatchObject({ mode: "external-acp", observations: "normalized" });
  const start = capture.accept({ type: "activity", data: { type: "tool.start", id: "tool", name: "read", input: { text: secret } } });
  expect(kinds(start)).toEqual([undefined]);
  expect(JSON.stringify(start)).not.toContain(secret);
  const end = capture.accept({ type: "activity", data: { type: "tool.end", id: "tool", output: { path: "/private/test/workspace/README", text: secret }, observation: { type: "tool_call_update" } } });
  expect(kinds(end)).toEqual(["tool-invocation", "tool-result"]);
  expect(JSON.stringify(end)).not.toContain(secret);
  expect(end[1]?.event?.payload).toMatchObject({ invocationId: "tool", outcome: "succeeded" });
});
it("merges a thin tool update onto the original command envelope", () => {
  const { capture } = fixture();
  const start = capture.accept({
    type: "activity",
    data: {
      type: "tool.start",
      id: "bash",
      title: "tool call",
      kind: "execute",
      command: "npm test",
      input: { command: "npm test" },
    },
    sourceId: "start",
  });
  expect(kinds(start)).toEqual([undefined]);
  expect(start[0]?.projection).toMatchObject({
    type: "activity",
    data: { type: "tool.start", id: "bash", name: "execute", kind: "execute", command: "npm test" },
  });
  capture.accept({
    type: "activity",
    data: { type: "tool.start", id: "bash", name: "acp_tool" },
    sourceId: "update",
  });
  const end = capture.accept({
    type: "activity",
    data: { type: "tool.end", id: "bash", name: "acp_tool", output: "ok" },
    sourceId: "end",
  });
  expect(end[0]?.event?.payload).toMatchObject({
    kind: "tool-invocation",
    invocationId: "bash",
    name: "execute",
    input: { command: "npm test" },
    command: "npm test",
    toolKind: "execute",
  });
  expect(end[1]?.event?.payload).toMatchObject({
    kind: "tool-result",
    invocationId: "bash",
    output: "ok",
    outcome: "succeeded",
  });
  expect(end[1]?.projection).toMatchObject({
    type: "activity",
    data: { type: "tool.end", id: "bash", name: "execute", command: "npm test" },
  });
});
it("retains optional usage cost on the single usage snapshot", () => {
  const { capture } = fixture();
  const first = capture.accept({
    type: "activity",
    data: { type: "usage", used: 4, limit: 10, cost: 0.2 },
    sourceId: "u1",
  });
  expect(first[0]?.event?.payload).toMatchObject({ kind: "usage", used: 4, limit: 10, cost: 0.2 });
  const later = capture.accept({
    type: "activity",
    data: { type: "usage", used: 8, limit: 10, cost: 0.4 },
    sourceId: "u2",
  });
  expect(later[0]?.event?.id).toBe(first[0]?.event?.id);
  expect(later[0]?.event?.payload).toMatchObject({ kind: "usage", used: 8, limit: 10, cost: 0.4 });
});
it("deduplicates transport observations without using their IDs as message IDs", () => {
  const { capture } = fixture();
  const chunk = { type: "text" as const, text: "done", sourceId: "transport-1", complete: true };
  const output = capture.accept(chunk);
  expect(capture.accept(chunk)).toEqual([]);
  expect(output.at(-1)?.event?.payload).toMatchObject({ kind: "message", messageId: "attempt:block:1" });
});
it("drops leftover ACP observations and keeps explicit stream-boundary gaps", () => {
  const { secret, capture } = fixture();
  expect(capture.accept({ type: "activity", data: { type: "file.changed", path: "/private/test/workspace/README" } })).toEqual([]);
  expect(capture.accept({ type: "activity", data: { type: "subagent", childSessionId: "child", initiatingToolId: "spawn", state: "started" } })).toEqual([]);
  expect(capture.accept({ type: "activity", data: { type: "compaction", coveredEventIds: ["file"], summary: secret } })).toEqual([]);
  expect(capture.accept({ type: "activity", data: { type: "unsupported_chunk", raw: secret } })[0]?.event?.payload).toMatchObject({ kind: "omission" });
  const unavailable = capture.accept({ type: "activity", data: { payloadUnavailable: true } });
  expect(kinds(unavailable)).toEqual([undefined]);
  expect(unavailable[0]?.projection).toMatchObject({ type: "activity", data: { payloadUnavailable: true } });
});
