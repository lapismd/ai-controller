import { describe, expect, it } from "vitest";
import {
  mapAcpPermissionRequest,
  mapAcpRuntimeEvent,
  mapApprovalOptionToAcpDecision,
} from "./acp-event-mapper.js";

describe("ACP event mapper", () => {
  it("maps text, thinking, tools, completion, and errors", () => {
    expect(mapAcpRuntimeEvent({ type: "text_delta", text: "hi" })).toEqual({
      type: "text",
      text: "hi",
    });
    expect(
      mapAcpRuntimeEvent({
        type: "text_delta",
        text: "think",
        stream: "thought",
      }),
    ).toEqual({ type: "thinking", text: "think", kind: "reasoning" });
    expect(
      mapAcpRuntimeEvent({
        type: "tool_call",
        toolCallId: "t1",
        title: "read",
        rawInput: { path: "a" },
      }),
    ).toEqual({
      type: "tool.start",
      id: "t1",
      name: "read",
      input: { path: "a" },
    });
    expect(
      mapAcpRuntimeEvent({
        type: "tool_call",
        toolCallId: "t1",
        title: "read",
        status: "completed",
        rawInput: { path: "a" },
        rawOutput: "ok",
      }),
    ).toEqual({
      type: "tool.end",
      id: "t1",
      name: "read",
      input: { path: "a" },
      output: "ok",
      error: undefined,
    });
    expect(
      mapAcpRuntimeEvent({
        type: "tool_call",
        toolCallId: "t-generic",
        title: "tool call",
        kind: "search",
        rawInput: {},
      }),
    ).toEqual({
      type: "tool.start",
      id: "t-generic",
      name: "search",
      input: undefined,
    });
    expect(
      mapAcpRuntimeEvent({
        type: "tool_call",
        toolCallId: "t2",
        title: "read",
        locations: [{ path: "Notes/a.md" }],
      }),
    ).toEqual({
      type: "tool.start",
      id: "t2",
      name: "read",
      input: { locations: [{ path: "Notes/a.md" }] },
    });
    expect(
      mapAcpRuntimeEvent({
        type: "tool_call_update",
        toolCallId: "t1",
        title: "read",
        status: "completed",
        rawOutput: "ok",
      }),
    ).toEqual({
      type: "tool.end",
      id: "t1",
      name: "read",
      input: undefined,
      output: "ok",
      error: undefined,
    });
    expect(mapAcpRuntimeEvent({ type: "done", stopReason: "end" })).toEqual({
      type: "completed",
      result: { stopReason: "end" },
    });
    expect(mapAcpRuntimeEvent({ type: "error", message: "nope" })).toEqual({
      type: "error",
      error: expect.objectContaining({ message: "nope" }),
    });
    expect(
      mapAcpRuntimeEvent({
        type: "status",
        tag: "usage_update",
        text: "usage updated: 25,645/258,400",
        used: 25_645,
        size: 258_400,
      }),
    ).toEqual({
      type: "usage",
      usage: { used: 25_645, limit: 258_400 },
    });
    expect(
      mapAcpRuntimeEvent({
        type: "status",
        text: "usage updated: 25645/258400",
      }),
    ).toEqual({
      type: "usage",
      usage: { used: 25_645, limit: 258_400 },
    });
  });

  it("retains sequenced runtime provenance on mapped events", () => {
    expect(
      mapAcpRuntimeEvent({
        type: "text_delta",
        text: "replayed",
        __source: { sessionId: "session-1", runId: "run-1", sequence: 4 },
      }),
    ).toEqual({
      type: "text",
      text: "replayed",
      source: { sessionId: "session-1", runId: "run-1", sequence: 4 },
    });
  });

  it("maps onPermissionRequest payloads to ApprovalRequest", () => {
    const request = mapAcpPermissionRequest({
      requestId: "p1",
      kind: "execute",
      title: "Allow npm install?",
      toolName: "bash",
      input: { command: "npm install" },
      options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }],
    });
    expect(request).toMatchObject({
      id: "p1",
      kind: "execute",
      title: "Allow npm install?",
      tool: { name: "bash", input: { command: "npm install" } },
    });
    expect(request.options[0]).toMatchObject({
      id: "allow-once",
      kind: "allow-once",
    });
    expect(mapApprovalOptionToAcpDecision("allow-always")).toEqual({
      outcome: "allow_always",
    });
    expect(mapApprovalOptionToAcpDecision("deny-once")).toEqual({
      outcome: "reject_once",
    });
    expect(request.metadata).toBeUndefined();
  });

  it("unwraps acpx onPermissionRequest payloads", () => {
    const request = mapAcpPermissionRequest({
      sessionId: "s1",
      inferredKind: "execute",
      raw: {
        toolCall: {
          toolCallId: "tc-1",
          title: "npm install",
          kind: "execute",
          rawInput: { command: "npm install" },
        },
        options: [
          { optionId: "allow-once", kind: "allow_once", name: "Allow" },
        ],
      },
    });
    expect(request).toMatchObject({
      id: "tc-1",
      kind: "execute",
      title: "npm install",
      tool: { name: "npm install", input: { command: "npm install" } },
    });
    expect(request.metadata).toBeUndefined();
  });

  it("maps available command updates onto the binding catalog event", () => {
    expect(
      mapAcpRuntimeEvent({
        type: "available_commands_update",
        commands: [
          { name: "compact", description: "Compact", argumentHint: "[focus]" },
        ],
      }),
    ).toEqual({
      type: "commands.update",
      commands: [
        {
          name: "compact",
          description: "Compact",
          argumentHint: "[focus]",
        },
      ],
    });
    expect(
      mapAcpRuntimeEvent({
        type: "status",
        commands: [{ name: "/skills", description: "Native skills" }],
      }),
    ).toEqual({
      type: "commands.update",
      commands: [
        {
          name: "/skills",
          description: "Native skills",
          argumentHint: undefined,
        },
      ],
    });
  });
});
