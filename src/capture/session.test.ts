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
it("buffers chunks into one completed message, exposing immediate status only", () => {
  const { secret, capture } = fixture();
  const first = capture.accept({ type: "text", text: secret.slice(0, 12), sourceId: "1", messageId: "message" });
  expect(first.map(record => record.event.payload.kind)).toEqual(["lifecycle"]);
  expect(JSON.stringify(first)).not.toContain(secret.slice(0, 12));
  expect(capture.accept({ type: "text", text: secret.slice(12), sourceId: "2", messageId: "message" })).toEqual([]);
  // A usage update is not an end-of-message boundary.
  const status = capture.accept({ type: "activity", data: { type: "usage", used: 4 }, sourceId: "3" });
  expect(status.some(record => record.event.payload.kind === "message")).toBe(false);
  const final = capture.accept({ type: "completed" });
  expect(final.filter(record => record.event.payload.kind === "message")).toHaveLength(1);
  expect(final[0]?.event.payload).toMatchObject({ kind: "message", text: "[REDACTED]" });
  expect(final[0]?.projection).toMatchObject({ type: "text", complete: true });
});
it("retains completed thinking and turns unfinished cancelled text into a gap", () => {
  const { secret, capture } = fixture();
  capture.accept({ type: "activity", data: { type: "thinking", text: secret }, sourceId: "1" });
  const thought = capture.accept({ type: "text", text: "unfinished", sourceId: "2" });
  expect(thought[0]?.event.payload).toMatchObject({ kind: "thinking", text: "[REDACTED]", visible: true });
  const cancelled = capture.accept({ type: "completed", outcome: "cancelled" });
  expect(cancelled[0]?.event.payload).toMatchObject({ kind: "omission", reason: "cancelled" });
  expect(JSON.stringify(cancelled)).not.toContain("unfinished");
});
it("retains plans, tool input/results, and explicit ACP coverage", () => {
  const { secret, capture } = fixture();
  capture.accept({ type: "activity", data: { type: "capture_coverage" } });
  const plan = capture.accept({ type: "activity", data: { type: "plan", entries: [{ content: "Inspect /private/test/workspace/README", status: "in_progress" }] } });
  expect(plan[0]?.event.payload).toMatchObject({ kind: "plan", entries: [{ content: "Inspect $WORKSPACE[probe]/README", status: "in_progress" }] });
  expect(plan[0]?.event.coverage).toMatchObject({ mode: "external-acp", observations: "normalized" });
  const start = capture.accept({ type: "activity", data: { type: "tool.start", id: "tool", name: "read", input: { text: secret } } });
  expect(JSON.stringify(start)).not.toContain(secret);
  const end = capture.accept({ type: "activity", data: { type: "tool.end", id: "tool", output: { path: "/private/test/workspace/README", text: secret } } });
  expect(end.map(record => record.event.payload.kind)).toEqual(["tool-invocation", "tool-result"]);
  expect(JSON.stringify(end)).not.toContain(secret);
  expect(end[1]?.event.payload).toMatchObject({ invocationId: "tool", outcome: "succeeded" });
});
it("deduplicates transport observations without using their IDs as message IDs", () => {
  const { capture } = fixture();
  const chunk = { type: "text" as const, text: "done", sourceId: "transport-1", complete: true };
  const output = capture.accept(chunk);
  expect(capture.accept(chunk)).toEqual([]);
  expect(output.at(-1)?.event.payload).toMatchObject({ kind: "message", messageId: "attempt:block:1" });
});
it("preserves logical file identity, parent links, compaction references and gaps", () => {
  const { secret, capture } = fixture();
  const file = capture.accept({ type: "activity", data: { type: "file.changed", path: "/private/test/workspace/README" } });
  expect(file[0]?.event.payload).toMatchObject({ kind: "file", path: { kind: "workspace", workspaceId: "probe", relativePath: "README", resolvable: true } });
  const child = capture.accept({ type: "activity", data: { type: "subagent", childSessionId: "child", initiatingToolId: "spawn", state: "started" } });
  expect(child[0]?.event.payload).toMatchObject({ kind: "subagent", initiatingToolId: "spawn" });
  const summary = capture.accept({ type: "activity", data: { type: "compaction", coveredEventIds: [file[0]!.event.id], summary: secret } });
  expect(summary[0]?.event.payload).toMatchObject({ kind: "compaction", coveredEventIds: [file[0]!.event.id], summary: "[REDACTED]" });
  expect(capture.accept({ type: "activity", data: { type: "unsupported_chunk", raw: secret } })[0]?.event.payload).toMatchObject({ kind: "omission" });
});
